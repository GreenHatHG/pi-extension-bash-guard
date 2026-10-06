/**
 * Read-only command fence: judge a shell command as "fine for a read-only session" or not.
 *
 * Used when PI_BASH_GUARD_MODE=advisor (the advisor sub-agent is there to judge, not to work).
 * The rule is deny-by-default on purpose. A denylist would need to know every way a command can
 * write or reach the network, and one miss turns the fence into decoration; an allowlist fails
 * loudly instead (an over-strict rule costs one turn, a hole costs the whole point).
 *
 * Splitting the command reuses scan-guard's quote-aware helpers, so `rg "a|b" .` stays one
 * segment and `git log --format='%s'` keeps its quotes.
 *
 * Where the input comes from: PI_BASH_GUARD_MODE (read from env only, never persisted — the mode
 * belongs to the process, not to a resumable session like the byte limits do).
 */

import { basename, splitSegments, tokenizeSegment } from "./scan-guard";

/** Env var that switches a process into a fenced mode. Set by the sub-agent launcher for advisor panes. */
export const MODE_ENV = "PI_BASH_GUARD_MODE";

/** Mode value meaning "bash must be read-only". */
export const READ_ONLY_MODE = "advisor";

/**
 * Read the fence mode for this process. undefined = no fence, a string = fence (an unknown value
 * fails closed: a typo in the injection must not silently hand out a full bash).
 */
export function readOnlyMode(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[MODE_ENV];
	if (raw === undefined) return undefined;
	const mode = raw.trim();
	return mode === "" ? undefined : mode;
}

export type ReadOnlyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * `bun` and `pi-vcc` are the session-recall CLI (its runtime is bun, or a compiled binary).
 * They stay hardcoded rather than injected: the brief template is the only thing that puts a CLI
 * in front of the advisor, so there is exactly one family to allow, and a path prefix match on a
 * multi-token command is both fussy and easy to get wrong.
 */
const PLAIN_COMMANDS = new Set([
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"sed",
	"head",
	"tail",
	"wc",
	"ls",
	"stat",
	"file",
	"less",
	"sort",
	"uniq",
	"cut",
	"tr",
	"diff",
	"jq",
]);

/** git subcommands that only read. Anything else (checkout/commit/reset/clean/push/...) is denied. */
const GIT_READ_SUBCOMMANDS = new Set([
	"log",
	"show",
	"diff",
	"status",
	"blame",
	"rev-parse",
	"rev-list",
	"branch",
	"ls-files",
	"show-branch",
	"name-rev",
	"describe",
	"shortlog",
	"grep",
	"ls-tree",
	"cat-file",
	"config",
]);

/** tmux subcommands that only read. Any kill, send-keys, set-hook, run-shell or new-session is denied. */
const TMUX_READ_SUBCOMMANDS = new Set([
	"capture-pane",
	"has-session",
	"ls",
	"list-sessions",
	"display-message",
	"show-environment",
	"show-options",
]);

/** Wrappers whose own flags can take a value; the value must be skipped before reading subcommands. */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const TMUX_GLOBAL_VALUE_FLAGS = new Set(["-L", "-S", "-f"]);

/**
 * Explicit "never allowed" list. These are already outside the allowlist; they are named so the
 * denial can say "this can never run here" instead of "unknown command", which teaches the model
 * faster and keeps the reason short.
 */
const NEVER_ALLOWED = new Set([
	"cat",
	"tee",
	"dd",
	"rm",
	"mv",
	"cp",
	"rsync",
	"chmod",
	"chown",
	"kill",
	"killall",
	"pkill",
	"sudo",
	"su",
	"npm",
	"pnpm",
	"yarn",
	"npx",
	"brew",
	"pip",
	"pip3",
	"uv",
	"cargo",
	"go",
	"make",
	"docker",
	"curl",
	"wget",
	"nc",
	"ssh",
	"scp",
	"node",
	"python",
	"python3",
	"perl",
	"ruby",
	"osascript",
	"vim",
	"vi",
	"nano",
	"emacs",
	"awk",
]);

/**
 * Wrappers hand the command to another program, so they are denied outright: an allowlist rule that
 * looks at the token after `sudo`/`env`/`xargs` is one indirection away from being wrong.
 * A plain leading `NAME=value` assignment is harmless, so that one is skipped.
 *
 * `timeout` is the exception: it only bounds a run, and the briefs tell the model to use it, so it is
 * unwrapped and its inner command is judged like any other.
 */
const WRAPPER_COMMANDS = new Set(["sudo", "doas", "env", "xargs", "command", "nohup", "exec", "nice"]);

/** `timeout` flags that take a separate value, e.g. `timeout -s KILL 5 cmd`. */
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "--signal", "-k", "--kill-after"]);

/** `timeout [flags] <duration> <command...>` -> the inner command, or undefined if it doesn't parse. */
function unwrapTimeout(tokens: string[]): string[] | undefined {
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--") return tokens.slice(i + 1);
		if (TIMEOUT_VALUE_FLAGS.has(t)) {
			i++;
			continue;
		}
		if (t.startsWith("-")) continue;
		// First bare token is the duration; everything after it is the command
		return tokens.slice(i + 1);
	}
	return undefined;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** What the first scan of the raw command found; both findings deny. */
interface RawScan {
	/** An unquoted `>` (write redirect), including `>>`, `2>&1` and here-docs (`<<`). */
	redirect: boolean;
	/** The quote never closed, so the command can't be parsed reliably. */
	unbalanced: boolean;
}

/**
 * Scan the raw command before splitting: an unquoted `>` means it writes, and an unbalanced quote
 * means we can't trust our own parse. Reading stdin (`<`) is fine, so this can't just reuse
 * `stripRedirections`, which eats both. Fails closed on anything it cannot parse.
 */
function scanRaw(command: string): RawScan {
	let quote: "'" | '"' | null = null;
	let redirect = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === ">") redirect = true;
	}
	return { redirect, unbalanced: quote !== null };
}

/** The first token after the command word, skipping global flags (and their values). */
function subcommandOf(tokens: string[], valueFlags: Set<string>): string | undefined {
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--") return tokens[i + 1];
		if (valueFlags.has(t)) {
			i++;
			continue;
		}
		if (t.startsWith("-")) continue;
		return t;
	}
	return undefined;
}

/** `sed -i` edits in place, so a plain `sed` is only safe without it. */
function sedIsReadOnly(tokens: string[]): boolean {
	return !tokens.some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place" || t.startsWith("--in-place"));
}

/**
 * `rg --pre <cmd>` runs that command for every file, so it is an execution channel. `tail -f` and
 * `ls -R` never return, which is a hang rather than a hole, but a fenced process should not do it.
 * `tail -F`/`--follow` is a long option; the short form is `-f`, matched exactly so `-n` and
 * friends are untouched.
 */
const RG_EXEC_FLAGS = new Set(["--pre", "--pre-glob", "--hostname-bin"]);
const LONG_RUNNING_FLAGS = new Set(["-f", "-F", "--follow", "-R", "--recursive"]);

function hasAnyToken(tokens: string[], exact: Set<string>): boolean {
	return tokens.some((t) => {
		const flag = t.split("=", 1)[0];
		return exact.has(t) || exact.has(flag);
	});
}

function deny(reason: string): ReadOnlyVerdict {
	return { ok: false, reason };
}

/** Judge one command. `ok` means every segment is a read-only command. */
export function judgeReadOnlyCommand(command: string): ReadOnlyVerdict {
	if (command.trim() === "") return { ok: true };
	const raw = scanRaw(command);
	if (raw.unbalanced) {
		return deny("the command has an unclosed quote, so it cannot be checked; fix the quoting and retry.");
	}
	if (raw.redirect) {
		return deny(
			"output redirects are not allowed (this session is read-only). Use the read tool for files, or the recall CLI for session history.",
		);
	}

	const segments = splitSegments(command);
	for (const segment of segments) {
		const tokens = tokenizeSegment(segment);
		// Leading assignments are skipped one by one, so `A=1 B=2 rg x` still resolves to `rg`.
		while (tokens.length > 0 && ASSIGNMENT.test(tokens[0])) tokens.shift();
		// `timeout` is just a bound on the run, so judge what it wraps
		if (tokens.length > 0 && basename(tokens[0]) === "timeout") {
			const inner = unwrapTimeout(tokens);
			if (!inner || inner.length === 0) {
				return deny("`timeout` must wrap a command; a bare `timeout` is not useful here and cannot be checked.");
			}
			tokens.splice(0, tokens.length, ...inner);
		}
		if (tokens.length === 0) continue;
		const head = basename(tokens[0]);

		if (WRAPPER_COMMANDS.has(head)) {
			return deny(`\`${head}\` hands the command to another program, which this read-only session forbids.`);
		}

		if (NEVER_ALLOWED.has(head)) {
			return deny(
				`\`${head}\` can never run in this read-only session. Use the read tool for files, or the recall CLI for session history.`,
			);
		}

		if (head === "bun" || head === "pi-vcc") {
			// A bare `bun` is the REPL and can run anything; the recall CLI is always `bun <script> ...`.
			if (tokens.length < 2) {
				return deny("a bare `bun` REPL is not allowed; only `bun <script> ...` (the recall CLI) is.");
			}
			// `bun -e '<code>'` runs code straight from the command line, same as a denied interpreter
			const evalFlag = tokens.find((t) => t === "-e" || t === "--eval" || t === "--print");
			if (evalFlag) {
				return deny(`\`bun ${evalFlag}\` runs code from the command line, which this read-only session forbids.`);
			}
			continue;
		}

		if (head === "git") {
			const sub = subcommandOf(tokens, GIT_GLOBAL_VALUE_FLAGS);
			if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) {
				return deny(`\`git ${sub ?? ""}\` is not read-only. Only read-only git subcommands are allowed here.`);
			}
			continue;
		}

		if (head === "tmux") {
			const sub = subcommandOf(tokens, TMUX_GLOBAL_VALUE_FLAGS);
			if (!sub || !TMUX_READ_SUBCOMMANDS.has(sub)) {
				return deny(`\`tmux ${sub ?? ""}\` is not read-only. Only pane/session inspection is allowed here.`);
			}
			continue;
		}

		if (head === "rg") {
			// allowlist: rg is a reader, but --pre turns it into a runner
			const execFlag = tokens.find((t) => RG_EXEC_FLAGS.has(t.split("=", 1)[0]));
			if (execFlag) {
				return deny(`\`rg ${execFlag}\` runs another program for every file, which this read-only session forbids.`);
			}
		} else if ((head === "tail" || head === "ls") && hasAnyToken(tokens, LONG_RUNNING_FLAGS)) {
			return deny(`\`${head}\` with a follow/recursive flag never returns; this session only runs bounded commands.`);
		}

		if (PLAIN_COMMANDS.has(head)) {
			if (head === "sed" && !sedIsReadOnly(tokens)) {
				return deny(
					"`sed -i` edits files in place, which this read-only session forbids. Use plain `sed -n` to print lines.",
				);
			}
			continue;
		}
		return deny(
			`\`${head}\` is not on the read-only allow list. Read files with the read tool; use the recall CLI for session history.`,
		);
	}

	return { ok: true };
}
