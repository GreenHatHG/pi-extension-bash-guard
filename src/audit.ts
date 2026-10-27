/**
 * `/bash-guard audit`: build one prompt and send it as a user message.
 *
 * The prompt tells the agent (with its normal bash/read tools) to scan pi's own session history for
 * evidence the guard's rules are missing something or mis-tuned, then report numbered suggestions and
 * STOP. Nothing here edits files or config — the user picks a suggestion by replying with a number.
 *
 * No local preprocessing: the agent does the aggregation itself, which is safe because the guard
 * applies to its own scans too (that's the point of the plugin).
 */

import { dirname, resolve } from "node:path";
import { formatBytes } from "./analyze";
import {
	MAX_NUMBER,
	MAX_PARENT_SEGMENTS,
	MAX_PATH_LENGTH,
	MAX_SEGMENT_OCCURRENCES,
	MAX_STRING_LENGTH,
} from "./arg-guard";
import { DEFAULT_CONFIG, type GuardConfig } from "./config";
import { STREAK_BLOCK_AT } from "./streak-guard";
import { SEARCH_TIMEOUT_SECONDS } from "./timeout-guard";

/**
 * Where pi stores sessions. `PI_CODING_AGENT_DIR` moves the whole config dir; PI_CODING_AGENT_SESSION_DIR
 * moves session storage, and a custom dir is FLAT — jsonl files sit directly inside it, unlike the
 * default root which nests one `<dir-encoded-cwd>` per project. Guessing wrong points the audit at a
 * directory that does not exist.
 */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
	return env.PI_CODING_AGENT_SESSION_DIR?.trim() || `${agentDir}/sessions`;
}

/** Marker texts the guard injects, so the agent can count interventions with plain grep. */
export const GUARD_MARKERS = [
	"[BASH OUTPUT GUARD]",
	"[BASH SCAN GUARD]",
	"[LOOP GUARD]",
	"[ARG GUARD]",
	"[BASH TIMEOUT GUARD]",
	"[BASH READ-ONLY FENCE]",
] as const;

/** Scope of the audit: only this project's sessions, or every session on the machine. */
export type AuditScope = "project" | "all";

/**
 * Session dirs are named after the cwd: strip the leading slash, map every `/`, `\` and `:` to `-`,
 * then wrap the whole name in `--` on each side (`/home/me/proj` → `--home-me-proj--`). This mirrors
 * pi's own encoder; verified against 30 real session dirs on this machine.
 */
export function sessionDirForCwd(cwd: string): string {
	// pi resolves the cwd before encoding, so `//a//b` and `/a/../a` must collapse first
	return `--${resolve(cwd)
		.replace(/\/+$/, "")
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

export interface AuditInput {
	cwd: string;
	scope: AuditScope;
	/** `ctx.sessionManager.getSessionDir()` — the real dir holding this session, covers `--session-dir`. */
	sessionDir?: string;
	/** Live config, so the prompt audits the real thresholds instead of the defaults. */
	cfg?: GuardConfig;
	env?: NodeJS.ProcessEnv;
}

/** A dir named `--<encoded-cwd>--` is one project inside the default root; anything else is flat. */
function isEncodedProjectDir(dir: string): boolean {
	const base =
		dir
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop() ?? "";
	return base.startsWith("--") && base.endsWith("--");
}

function projectScope(input: AuditInput): { dir: string; flat: boolean } {
	if (input.sessionDir) return { dir: input.sessionDir, flat: !isEncodedProjectDir(input.sessionDir) };
	const env = input.env ?? process.env;
	if (env.PI_CODING_AGENT_SESSION_DIR?.trim()) return { dir: sessionsDir(env), flat: true };
	return { dir: `${sessionsDir(env)}/${sessionDirForCwd(input.cwd)}`, flat: false };
}

function allScope(input: AuditInput): { root: string; flat: boolean } {
	if (input.sessionDir) {
		return isEncodedProjectDir(input.sessionDir)
			? { root: dirname(input.sessionDir), flat: false }
			: { root: input.sessionDir, flat: true };
	}
	const env = input.env ?? process.env;
	return { root: sessionsDir(env), flat: Boolean(env.PI_CODING_AGENT_SESSION_DIR?.trim()) };
}

function limit(bytes: number): string {
	return bytes > 0 ? formatBytes(bytes) : "no limit";
}

function onOff(flag: boolean): string {
	return flag ? "on" : "off";
}

function tunables(cfg: GuardConfig): string[] {
	const bytes = limit(cfg.maxBytes);
	const payload = limit(cfg.payloadMaxBytes);
	return [
		`- Output limits: ${bytes} for search/list/dump output, ${payload} for everything else; preview keeps ${cfg.previewHead} head + ${cfg.previewTail} tail lines (${cfg.errorPreviewTail} tail when the command fails).`,
		`- Switches: master ${onOff(cfg.enabled)}, opening hint ${onOff(cfg.hint)}, pre-scan block ${onOff(cfg.scanBlock)}, arg guard ${onOff(cfg.argGuard)}, loop breaker ${onOff(cfg.streakBlock)}.`,
		`- Search commands (find/grep/rg/du/tree) are capped at a ${SEARCH_TIMEOUT_SECONDS}s timeout; scans rooted at $HOME, /, or a system dir are blocked before they run.`,
		`- Loop breaker: same command shape ${STREAK_BLOCK_AT} times in a row with no assistant text in between → blocked.`,
		`- Arg guard on every tool call: path > ${MAX_PATH_LENGTH} chars, > ${MAX_PARENT_SEGMENTS} \`..\` segments, one path segment repeated ${MAX_SEGMENT_OCCURRENCES}+ times; numbers NaN/negative/>${MAX_NUMBER}; string instruction > ${MAX_STRING_LENGTH} chars.`,
	];
}

/** Build the full audit prompt. */
export function buildAuditPrompt(input: AuditInput): string {
	const cfg = input.cfg ?? DEFAULT_CONFIG;
	const project = projectScope(input);
	const all = allScope(input);

	const scopeLine =
		input.scope === "all"
			? `Scope: ALL session directories under ${all.root} (this machine's full history).`
			: project.flat
				? `Scope: only sessions for the current project — the directory ${project.dir}. A custom session dir is flat, so it may also hold other projects' sessions; to narrow down, filter on the \`cwd\` field of each file's first \`session\` line. If it does not exist, say so and stop.`
				: `Scope: only sessions for the current project — the directory ${project.dir}. If it does not exist, say so and stop.`;

	const dataLine =
		input.scope === "all"
			? all.flat
				? `- Session files: ${all.root}/*.jsonl, one JSON entry per line, all projects mixed (the first \`session\` line of each file carries its \`cwd\`).`
				: `- Session files: ${all.root}/<dir-encoded-cwd>/*.jsonl, one JSON entry per line.`
			: `- Session files: ${project.dir}/*.jsonl, one JSON entry per line.`;

	const markers = GUARD_MARKERS.map((m) => `- \`${m}\``).join("\n");

	return [
		"Audit bash-guard by reading real pi session history. You report suggestions and then STOP — change no project file and no guard config; temp extract files are fine. I will pick a suggestion by replying with its number.",
		"",
		scopeLine,
		"",
		"Where the data is:",
		dataLine,
		'- Bash results are `message` entries with `message.role="toolResult"` and `message.toolName="bash"`; the output text is in `message.content[].text`.',
		"- Guard interventions appear as markers inside that toolResult text:",
		markers,
		"- Counting caveat: the markers also show up outside toolResult text — in the session-start custom message, in blocked tool calls for other tools (ARG GUARD), and quoted in assistant prose. Count per entry, not per raw file grep, or you will over-count.",
		"- Second caveat: a marker is an intervention only when it *begins* the toolResult text or one of its lines (guard messages and block reasons do; the timeout hint is appended as its own line). A marker in the middle of a line is a grep hit on this repo's source, tests or docs — a reference, not an intervention.",
		"- Guard config appears as `custom` entries with customType `bash-guard-config`.",
		"",
		"How to scan — the guard applies to your own commands too, so aggregate before you look:",
		"- Count first: `grep -c` / `rg -c` (with `-m` caps), `rg -l` for file lists, `| sort | uniq -c`, `head`/`tail` for spot checks.",
		"- Never dump a whole session file. Pull out just the command strings or the marker lines you need; write big extracts to a temp file and read them selectively.",
		"- Session files can be large: filter by marker or toolName before pretty-printing anything.",
		"",
		"Current tunables to audit (are they still right?):",
		...tunables(cfg),
		"",
		"What to look for:",
		"1. Marker counts, overall and per project — which rules actually fire in practice, which never do.",
		"2. Misses: search commands that still timed out, the same command re-run right after the guard stepped in, big-output command shapes no rule covers.",
		`3. Threshold health: output-size distribution near the ${limit(cfg.maxBytes)}/${limit(cfg.payloadMaxBytes)} lines; silent same-shape streak lengths in normal sessions (is ${STREAK_BLOCK_AT} calibrated, or does it fire on healthy heavy searching?).`,
		"4. Noise: interventions that were NOT helpful (the model's rewritten command was worse, or the blocked command was legitimate).",
		"",
		"Deliverable — then stop and wait for my reply:",
		"- 3 to 5 numbered improvement suggestions, strongest first. For each: the evidence (real commands/counts, with session file paths), the proposed change (a threshold, a new rule, or hint text), and its cost or risk.",
		"- If the evidence does not support any change, say so plainly instead of inventing suggestions.",
		"- End with one line: reply with a number to pick a suggestion.",
	].join("\n");
}
