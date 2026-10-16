/**
 * Pure helpers: catch the "slice-read death loop" — an agent reading the same file over and over
 * in small `sed -n 'A,Bp'` windows, burning hours without progress.
 *
 * Thresholds come from replaying every pi session on this machine (992 sessions, ~25k slice reads):
 * - Normal sessions top out at 53 slice reads of one file (repo-tutor writing docs, each read a
 *   different range); the runaway session did 1242. 80 sits above a 2x gap (53 ... 1242).
 * - Normal sessions repeat the *exact same range* within 15s..10min at most 4 times, never clustered;
 *   the two known-bad sessions did 7 and 87. 6 in a 30-minute window catches both with room.
 *
 * Two hard rules, per file:
 * 1. Volume breaker: >= sliceBlockAfter slice reads of the same file in the session → block.
 *    Catches slow burn with all-different ranges (no repeats needed).
 * 2. Loop breaker: >= rapidRepeatLimit same-range fast re-reads (15s..10min apart) within a 30-minute
 *    window → block. Catches "tweak → re-read the same lines" loops that never reach the volume cap.
 * A soft nudge at sliceNudgeAfter reads goes on the tool result; it doesn't block.
 *
 * Only `sed -n 'A,Bp'` counts toward the hard rules: head/tail were never validated by the replay
 * (tail-following logs is a highly legitimate pattern), so they only feed the soft counter.
 */

import { splitSegments, stripRedirections, stripWrappers, tokenizeSegment } from "./scan-guard";

/** Soft nudge: slice reads of one file before a one-line hint rides along on the result. */
export const SLICE_NUDGE_AFTER = 20;
/** Hard rule 1: slice reads of one file before bash slice reads of it are blocked. */
export const SLICE_BLOCK_AFTER = 80;
/** Hard rule 2: same-range fast re-reads of one file within the window before blocking. */
export const RAPID_REPEAT_LIMIT = 6;
/** A re-read of the same range is "fast" when it happens 15s..10min after the previous one. */
export const RAPID_MIN_GAP_SECONDS = 15;
export const RAPID_MAX_GAP_SECONDS = 600;
/** The sliding window for fast re-reads. */
export const RAPID_WINDOW_MS = 30 * 60 * 1000;
/** Max files tracked; when full, the whole map is dropped (a session rarely touches more files). */
export const MAX_TRACKED_FILES = 500;

/** One parsed `sed -n` slice: the target file and the line ranges asked for. */
export interface ParsedSlice {
	file: string;
	/** Line ranges as [start, end] pairs, in order of appearance. */
	ranges: Array<[number, number]>;
}

/**
 * Pull every `sed -n 'A,Bp' file` slice out of one command.
 *
 * Handles: single/double/no quotes around the script, multi-range scripts (`'1,5p;20,30p'`),
 * `cd dir && sed -n ...` prefixes, and pipelines where the file comes before the pipe
 * (`sed -n '1,5p' f | grep x`). Substitutions (`$(...)`) are scanned as their own commands
 * because they run too. `sed -n /pat/p` (no line numbers) is skipped — no range, no key.
 */
export function parseSlices(command: string, depth = 0): ParsedSlice[] {
	if (!command || depth > 8) return [];
	const out: ParsedSlice[] = [];
	// `$(cmd)` and backticks execute too; judge their contents as their own command.
	const { text, nested } = splitSubstitutions(command);
	for (const inner of nested) out.push(...parseSlices(inner, depth + 1));
	for (const segment of splitSegments(text)) {
		const tokens = stripWrappers(tokenizeSegment(stripRedirections(segment)));
		if (tokens.length === 0 || tokens[0] !== "sed") continue;
		// Find -n and the script ('A,Bp'); the target is the first non-flag operand after it.
		let script: string | undefined;
		const targetTokens: string[] = [];
		for (let i = 1; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "-n") continue;
			if (token === "-e" || token === "--expression") {
				script = tokens[i + 1];
				i++;
				continue;
			}
			if (token.startsWith("-")) continue;
			if (script === undefined) script = token;
			else targetTokens.push(token);
		}
		if (script === undefined) continue;
		const ranges = parseRanges(script);
		if (ranges.length === 0 || targetTokens.length === 0) continue;
		out.push({ file: normalizePath(targetTokens[0]), ranges });
	}
	return out;
}

/** Replace `$(...)`/backticks with a marker, collecting the inner commands (quotes respected). */
function splitSubstitutions(command: string): { text: string; nested: string[] } {
	let text = "";
	const nested: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && quote !== "'") {
			text += ch + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (quote === "'") {
			text += ch;
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "`") {
			const end = command.indexOf("`", i + 1);
			if (end !== -1) {
				nested.push(command.slice(i + 1, end));
				text += " SUBST ";
				i = end;
				continue;
			}
		}
		if (ch === "$" && command[i + 1] === "(") {
			const end = matchParen(command, i + 2);
			if (end !== -1) {
				nested.push(command.slice(i + 2, end));
				text += " SUBST ";
				i = end;
				continue;
			}
		}
		if (ch === "'" || ch === '"') quote = quote === null ? ch : quote;
		text += ch;
	}
	return { text, nested };
}

/** Index of the `)` closing the `(` opened at `start`, or -1 (nesting and quotes respected). */
function matchParen(command: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | null = null;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Parse `A,Bp` ranges out of a sed script; `A,$p` and step/address forms are ignored. */
function parseRanges(script: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const match of script.matchAll(/(\d+),(\d+)p/g)) {
		const start = Number.parseInt(match[1], 10);
		const end = Number.parseInt(match[2], 10);
		if (end >= start) out.push([start, end]);
	}
	return out;
}

/**
 * Normalize a file path so the same file always lands on the same counter key.
 *
 * Real sessions split one file across keys (`src/x.ts` vs the full path, or a trailing `;` glued on
 * by a missing space), which silently raises every threshold. Without a cwd to resolve against, this
 * folds to a best-effort form: trailing punctuation stripped, `./` dropped, backslashes untouched.
 * Two paths that differ only by a relative/absolute prefix still split — rare, and the volume rule
 * then just needs more reads to fire.
 */
export function normalizePath(raw: string): string {
	return raw
		.replace(/^[.]\//, "")
		.replace(/[;,'"]+$/, "")
		.trim();
}

/** Per-file counters for the three rules. */
export interface FileSliceState {
	/** Total slice reads this session (soft nudge + volume breaker). */
	total: number;
	/** Nudge already shown once for this file. */
	nudged: boolean;
	/** Whether the volume breaker already fired for this file. */
	blocked: boolean;
	/** Last time each exact range-set was read (epoch ms), to detect fast re-reads. */
	lastReadAt: Map<string, number>;
	/** Timestamps of fast re-reads inside the sliding window. */
	rapidHits: number[];
}

export function newFileSliceState(): FileSliceState {
	return { total: 0, nudged: false, blocked: false, lastReadAt: new Map(), rapidHits: [] };
}

/** What a slice-read verdict means for the caller. */
export type SliceVerdict =
	| { kind: "pass" }
	/** One-line hint appended to the tool result (non-blocking). */
	| { kind: "nudge"; message: string }
	/** Blocked before running; reason tells the model the way out. */
	| { kind: "block"; message: string };

/** Update counters with one parsed slice and decide pass / nudge / block. */
export function recordSlice(
	state: FileSliceState,
	slice: ParsedSlice,
	nowMs: number,
	thresholds?: { nudgeAfter?: number; blockAfter?: number; rapidLimit?: number },
): SliceVerdict {
	const nudgeAfter = thresholds?.nudgeAfter ?? SLICE_NUDGE_AFTER;
	const blockAfter = thresholds?.blockAfter ?? SLICE_BLOCK_AFTER;
	const rapidLimit = thresholds?.rapidLimit ?? RAPID_REPEAT_LIMIT;

	state.total++;
	if (state.blocked) return { kind: "block", message: volumeBlockReason(state.total) };

	// Fast re-read of the exact same ranges: 15s..10min since the last read of this range-set.
	const key = slice.ranges.map(([a, b]) => `${a}-${b}`).join(";");
	const last = state.lastReadAt.get(key);
	const gap = last === undefined ? Infinity : (nowMs - last) / 1000;
	state.lastReadAt.set(key, nowMs);
	if (last !== undefined && gap >= RAPID_MIN_GAP_SECONDS && gap <= RAPID_MAX_GAP_SECONDS) {
		state.rapidHits.push(nowMs);
	}
	// Drop hits older than the sliding window (and any stale "Infinity" gap entries).
	while (state.rapidHits.length > 0 && nowMs - state.rapidHits[0] > RAPID_WINDOW_MS) state.rapidHits.shift();
	if (state.rapidHits.length >= rapidLimit) {
		state.rapidHits = [];
		state.blocked = true;
		return { kind: "block", message: loopBlockReason() };
	}

	if (!state.nudged && state.total >= nudgeAfter) {
		state.nudged = true;
		return { kind: "nudge", message: sliceNudgeMessage(state.total) };
	}
	if (state.total >= blockAfter) {
		state.blocked = true;
		return { kind: "block", message: volumeBlockReason(state.total) };
	}
	return { kind: "pass" };
}

function sliceNudgeMessage(total: number): string {
	return (
		`[SLICE READ GUARD] This file has now been read in ${total} small sed slices this session. ` +
		"If you keep needing context from it, read a big block once with the `read` tool (offset/limit) instead of more slices."
	);
}

function volumeBlockReason(total: number): string {
	return (
		`[SLICE READ GUARD] Blocked: this session has used ${total} small \`sed -n\` slice reads on this file. ` +
		"Further bash slice reads of it are off for the rest of this session. " +
		"Use the `read` tool (offset/limit) to pull what you need — that is not blocked."
	);
}

function loopBlockReason(): string {
	return (
		"[SLICE READ GUARD] Blocked: the same line range of this file has been re-read repeatedly in the last 30 minutes " +
		"without the file changing. The content is already in your context — work from it, or tell the user where you are stuck."
	);
}
