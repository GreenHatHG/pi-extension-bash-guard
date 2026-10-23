/**
 * Pure helpers: catch the "silent same-shape death loop" — an assistant burning turn after turn
 * on the same command shape (program + subcommand) without ever emitting text.
 *
 * Both known runaways share one signature. A recall loop made 222 `bun main.ts recall` calls with
 * zero assistant text between them; an 8h sed loop made 402 consecutive silent `sed` calls (it ran
 * `cd dir && sed -n ...`, so navigation segments must be skipped). Replay of 164 normal VPS
 * sessions: silent same-shape streak p50=1, p90=6, max=28. Both runaways exceed 200. Threshold 35
 * sits above the normal max with room and catches both in minutes.
 *
 * A single hard rule, evaluated per tool call by walking the session branch backwards:
 * silent same-shape streak >= STREAK_BLOCK_AT → block the new call. Recovery is cheap by design:
 * any assistant text (or user message) resets the streak, so a blocked model just has to say one
 * line of progress before retrying.
 */

/** Block a bash call when this many same-shape calls ran with no assistant text in between. */
export const STREAK_BLOCK_AT = 35;

/** Programs that only navigate; a chain like `cd dir && rg ...` should be judged by the real command. */
const NAVIGATION_PROGRAMS = new Set(["cd", "pushd", "popd"]);
/** Wrappers that don't change what the inner command is. */
const TRANSPARENT_WRAPPERS = new Set(["nohup", "env", "sudo"]);

/**
 * Reduce one command to a comparable shape: program + subcommand, variable args dropped.
 *
 * Skips leading env assignments and transparent wrappers, then walks `&&`/`;`/`|` segments past
 * pure navigation so `cd dir && sed -n '1,5p' f` reads as `sed`. For interpreted scripts
 * (`bun /path/main.ts recall ...`) the script name and first non-flag argument are kept, since
 * that pair distinguishes loop-prone CLI reads (`main.ts recall`) from one-off runs.
 */
export function shapeOf(command: string): string | null {
	if (!command) return null;
	for (const segment of command.split(/&&|\|\||;|\|/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		const kept: string[] = [];
		let skipNext = false;
		for (const token of tokens) {
			if (skipNext) {
				skipNext = false;
				continue;
			}
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || TRANSPARENT_WRAPPERS.has(token)) continue;
			if (token === "timeout") {
				skipNext = true; // `timeout N cmd`: N is a duration, not the command
				continue;
			}
			kept.push(token);
		}
		if (kept.length === 0) continue;
		const program = kept[0].split("/").pop() ?? kept[0];
		if (NAVIGATION_PROGRAMS.has(program)) continue;
		const rest = kept.slice(1);
		if (program === "git") {
			const sub = rest.find((t) => !t.startsWith("-"));
			return sub ? `git ${sub}` : "git";
		}
		const first = rest[0];
		// A script run (`bun /path/main.ts recall …`): only a script-extension first arg means this;
		// a plain path like `cat $HOME/file` must fall through to the data-argument rule below.
		if (first !== undefined && /^\.[cm]?[tj]sx?$/.test(first.slice(first.lastIndexOf(".")))) {
			const script = first.split("/").pop() ?? first;
			const sub = rest.slice(1).find((t) => !t.startsWith("-"));
			return sub ? `${program} ${script} ${sub}` : `${program} ${script}`;
		}
		for (const token of rest) {
			if (token.startsWith("-")) continue;
			if (
				token.includes("/") ||
				token.startsWith("$") ||
				token.startsWith("'") ||
				token.startsWith('"') ||
				token.startsWith("`")
			) {
				return program; // argument is data (a path or quoted string), not a subcommand
			}
			return `${program} ${token}`;
		}
		return program;
	}
	return null;
}

/** What a streak verdict means for the caller. */
export type StreakVerdict =
	| { kind: "pass" }
	/** Blocked before running; the reason names the way out. */
	| { kind: "block"; message: string; streak: number };

/**
 * Walk the session branch backwards and measure the silent same-shape bash streak that a new call
 * would extend.
 *
 * Scanning stops at the first assistant text or user message; everything newer is part of the
 * current silent run. The streak also stops at the first different-shape bash call — it measures a
 * consecutive run, not a total. Non-bash tools are skipped without breaking the streak (an agent
 * pairing one `read` with twenty `rg` calls is still looping). Parallel calls within one assistant
 * message are each preflighted against the same history, so a message firing N identical calls sees
 * them as N+1; that only sharpens the breaker.
 */
export function measureSilentStreak(
	branch: Array<{ type?: string; message?: { role?: string; content?: unknown } }>,
	newShape: string,
): number {
	let streak = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role === "user") break;
		if (role === "assistant") {
			const parts = Array.isArray(content) ? content : [];
			const hasText = parts.some(
				(part) =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: string }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string" &&
					(part as { text: string }).text.trim() !== "",
			);
			if (hasText) break;
			for (const part of parts) {
				if (
					typeof part === "object" &&
					part !== null &&
					(part as { type?: string }).type === "toolCall" &&
					(part as { name?: string }).name === "bash"
				) {
					const command = (part as { arguments?: { command?: unknown } }).arguments?.command;
					if (typeof command !== "string" || command.trim() === "") continue;
					// A different shape ends the consecutive run; scan back-to-front so the first
					// mismatch seen is the one nearest the new call.
					if (shapeOf(command) !== newShape) return streak;
					streak++;
				}
			}
		}
	}
	return streak;
}

/** The block reason served to the model. Recovery = emit one line of text, then retry differently. */
export function streakBlockMessage(streak: number): string {
	return (
		`[LOOP GUARD] Blocked: the last ${streak} bash calls were the same kind of command with no commentary from you in between. ` +
		"Repeating this pattern is not making progress — the results you are looking for are not coming. " +
		"Reply with one short line saying where you are stuck, then change approach: " +
		"search with different keywords or a different tool, or read the file directly with the `read` tool instead of more searches."
	);
}
