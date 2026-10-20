/**
 * Generic tool-argument validation (the "treat a tool call like an API call" guard).
 *
 * A model is a client calling tools as if they were API endpoints. A degenerate argument —
 * a `path` that is `claude-code/../claude-code/../...` repeated ~2000 times, a `limit` of
 * `Infinity`, a negative `offset` — is the same as a client sending a malformed request. This
 * module validates those arguments at the `tool_call` boundary so a bad call is refused before
 * it can touch the filesystem or burn a turn.
 *
 * It is intentionally tool-agnostic: it keys off argument *shapes*, not off specific tool names,
 * so it covers `read`/`write`/`edit`/`grep` and any future tool that takes a `path` or a number.
 *
 * The thresholds below are calibrated against the real pi session history on this machine
 * (117 jsonl sessions, 910 path args, 929 numeric args, 6122 string args):
 *   - normal paths are p50=63 / p99=93 chars, max under 500 except a single runaway incident;
 *   - normal paths climb at most a few `..`; only the same runaway had >4;
 *   - normal string args (commands, patterns) are p50=128 / p99=3619 chars;
 *   - numeric args are all finite, non-negative, and under ~2000 in practice — Infinity/NaN/
 *     negatives never occur normally, so flagging them never touches a real call.
 *
 * The string-length rule is scoped to *instruction* keys (`command`, `pattern`) only. Payload keys
 * (a `write`'s `content`, an `edit`'s `newText`) are never length-checked: writing a 60KB file is a
 * normal call and must not be refused on length.
 */

/** Longest path we'll accept. Real paths top out well under 500; this catches runaways early. */
export const MAX_PATH_LENGTH = 512;
/** Most `..` parent segments a sane path climbs before we call it degenerate. */
const MAX_PARENT_SEGMENTS = 8;
/** A `/`-segment seen this many times in one path is a runaway repeat (the incident had 1937). */
const MAX_SEGMENT_OCCURRENCES = 20;
/** Longest any string argument may be (guards against whole-argument loops). */
export const MAX_STRING_LENGTH = 50_000;
/** Longest number argument before we call it nonsense. Timeouts legitimately reach ~2000s, so keep headroom. */
const MAX_NUMBER = 1_000_000_000;
/**
 * String-valued keys we length-check. These are *instruction* parameters (a command to run, a pattern
 * to match) — a runaway loop there is genuinely degenerate. Keys that carry *payload* (the `content`
 * of a `write`, the `newText` of an `edit`) are deliberately left out: writing a 60KB file or pasting a
 * long block is a normal, non-degenerate call and must not be refused on length.
 */
const STRING_LENGTH_CHECKED_KEYS = new Set(["command", "pattern"]);

export interface ArgVerdict {
	ok: boolean;
	reason?: string;
}

/**
 * Count `..` parent segments in a path (a normal path has a handful; thousands is the bug).
 * Splitting on `/` and counting literal `..` is enough — we don't need to resolve symlinks.
 */
export function countParentSegments(path: string): number {
	let count = 0;
	for (const seg of path.split("/")) {
		if (seg === "..") count++;
	}
	return count;
}

/**
 * A "degenerate" path is one where a single `/`-segment dominates — the signature of a runaway
 * repeat like `claude-code/../claude-code/../...` (the `claude-code` segment appears 1937 times).
 * Checking the most common segment is robust where "does the prefix repeat" fails, because the
 * buggy path often has a real prefix before the loop starts.
 */
export function hasDominantSegment(path: string): boolean {
	const segs = path.split("/");
	if (segs.length < MAX_SEGMENT_OCCURRENCES) return false;
	const counts = new Map<string, number>();
	let top = 0;
	for (const seg of segs) {
		if (seg === "" || seg === "." || seg === "..") continue; // ignore empty/self/parent markers
		const n = (counts.get(seg) ?? 0) + 1;
		counts.set(seg, n);
		if (n > top) top = n;
	}
	return top >= MAX_SEGMENT_OCCURRENCES;
}

/**
 * Validate a `path` argument. Refuses: too-long paths, parent-segment storms, and degenerate
 * repeats. Absolute paths are allowed — the point is shape sanity, not sandboxing (that is the
 * read-only fence's job).
 */
export function checkPath(value: unknown): ArgVerdict {
	if (typeof value !== "string") return { ok: true }; // not our shape; other guards (none here) may care
	if (value.length > MAX_PATH_LENGTH) {
		return {
			ok: false,
			reason: `[ARG GUARD] path is ${value.length} chars (max ${MAX_PATH_LENGTH}); this looks like a runaway repeat.`,
		};
	}
	const parents = countParentSegments(value);
	if (parents > MAX_PARENT_SEGMENTS) {
		return {
			ok: false,
			reason: `[ARG GUARD] path climbs too many parent dirs (${parents} ".." segments); it is degenerate.`,
		};
	}
	if (hasDominantSegment(value)) {
		return {
			ok: false,
			reason: "[ARG GUARD] one path segment is repeated too many times; refusing a degenerate path.",
		};
	}
	return { ok: true };
}

/**
 * Validate a numeric argument (offset/limit/timeout...). Refuses: non-finite, negative, huge.
 * `Infinity`/`NaN` and negatives are the classic model slips; huge is a runaway repeat.
 */
export function checkNumber(value: unknown): ArgVerdict {
	if (typeof value !== "number") return { ok: true }; // not our shape
	if (!Number.isFinite(value)) {
		return { ok: false, reason: `[ARG GUARD] numeric argument is ${String(value)}; expected a finite number.` };
	}
	if (value < 0) {
		return { ok: false, reason: `[ARG GUARD] numeric argument is ${value}; must be >= 0.` };
	}
	if (value > MAX_NUMBER) {
		return { ok: false, reason: `[ARG GUARD] numeric argument is ${value}; too large to be a real value.` };
	}
	return { ok: true };
}

/**
 * Validate a string *instruction* argument (command/pattern) by raw length. Refuses absurdly long
 * strings. Not applied to payload keys (content/newText) — those are intentionally exempt, see
 * `STRING_LENGTH_CHECKED_KEYS`.
 */
export function checkString(value: unknown): ArgVerdict {
	if (typeof value !== "string") return { ok: true };
	if (value.length > MAX_STRING_LENGTH) {
		return { ok: false, reason: `[ARG GUARD] argument is ${value.length} chars (max ${MAX_STRING_LENGTH}).` };
	}
	return { ok: true };
}

/**
 * Validate a full tool-call argument object. Keys are checked by name/shape regardless of tool,
 * so a `path` key is validated wherever it appears. Returns the first failing verdict, or ok.
 */
export function validateToolArgs(input: unknown): ArgVerdict {
	if (input === null || typeof input !== "object") return { ok: true };
	for (const [key, value] of Object.entries(input)) {
		const verdict =
			key === "path"
				? checkPath(value)
				: typeof value === "number"
					? checkNumber(value)
					: typeof value === "string" && STRING_LENGTH_CHECKED_KEYS.has(key)
						? checkString(value)
						: { ok: true };
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}
