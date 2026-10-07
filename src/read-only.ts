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
 * belongs to the process, not to a resumable session like the byte limits do). Note the fence only
 * matches literal command names: it does not expand `${VAR}` or aliases, so a poisoned environment
 * is outside what it can see.
 */

import { basename, splitCommandSubstitutions, splitSegments, tokenizeSegment } from "./scan-guard";

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
	// name/path lookup and bounded listing: read-only, and `... | xargs wc -l` used to trip over
	// them. `find` is allowed only without -exec/-delete (see DANGEROUS_ANYWHERE).
	"find",
	"tree",
	"which",
	"whereis",
	"pwd",
	"uname",
	"id",
	"test",
	"[",
	// allowed only with no operand left over; see FLAG_GATED_COMMANDS
	"date",
	"hostname",
]);

/**
 * Shell builtins that only read or print. They are allowed because advisors write shell pipelines
 * constantly (`... | head; echo ---; ...`, `cd <abs> && git log`) and re-running a whole line for a
 * cosmetic `echo` is pure waste. Being a builtin is not the reason they are safe: `scanRaw` still
 * rejects any redirect, so `echo x > file` stays blocked.
 *
 * Deliberately not here: `read` (eats stdin a pipeline may need), `.`/`source`/`eval` (run arbitrary
 * code), `export`/`unset` (mutate the environment later commands see), `exec` (replaces the shell).
 */
const SHELL_READ_ONLY = new Set(["echo", "printf", "cd", "true", "false", ":"]);

/**
 * Loops and conditionals. Denied by name instead of being left to the generic "unknown command"
 * branch, because the body is never what gets judged: `for f in x; do <body>; done` is split on `;`
 * and the segment that fails today is `do`. Someone adding `do` to the allowlist to fix that false
 * positive would silently make every loop body unjudged code. Naming them keeps the deny deliberate
 * and gives the model a reason it can act on (run the body command on its own).
 */
const SHELL_CONTROL_FLOW = new Set([
	"for",
	"while",
	"until",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"{",
	"}",
	"(",
	")",
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
	// Read-only too, and each one showed up as a false positive: `git tag --contains`,
	// `git reflog show`, `git merge-base HEAD MERGE_HEAD`. `git worktree` reads with `list` and writes
	// with `add`/`prune` — worktreeOf() below keeps the read-only subcommand only.
	"tag",
	"reflog",
	"merge-base",
	"for-each-ref",
	"symbolic-ref",
	"show-ref",
	"worktree",
	"count-objects",
	"verify-pack",
	"var",
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

/** `xargs` flags that take no value and cannot make xargs write: only knobs that shape how it calls the callee. */
const XARGS_SAFE_NO_VALUE = new Set([
	"-0",
	"--null",
	"-r",
	"--no-run-if-empty",
	"-t",
	"--verbose",
	"-p",
	"--interactive",
	"-x",
	"--exit",
	"-o",
	"--open-tty",
]);

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

/**
 * Read-only *when given no operand*. `date` prints the clock and `hostname` prints the host name —
 * until an operand turns them into setters (BSD `date 0101120099`, `hostname evil.example`).
 * `date -s`/`hostname -F` do not exist on BSD but do on GNU, so both the setter *flags* and the bare
 * operand are refused.
 *
 * They are worth the special case because both showed up in real advisor sessions while probing
 * sandbox and environment questions. (On this machine they need root anyway, so it is belt and
 * braces — but "needs root" is not a property the fence should rely on.)
 */
const FLAG_GATED_COMMANDS: Record<string, { setterFlags: Set<string>; valueFlags: Set<string> }> = {
	// A leading `+` is date's output format, not a value: `date +%s` prints.
	date: {
		setterFlags: new Set(["-s", "--set"]),
		valueFlags: new Set(["-f", "-r", "-v", "--date", "--reference"]),
	},
	hostname: {
		setterFlags: new Set(["-F", "--file", "--nis"]),
		valueFlags: new Set(),
	},
};

/** True when a non-flag token survives, i.e. the command is being told to set something. */
function setsState(tokens: string[], flags: { setterFlags: Set<string>; valueFlags: Set<string> }): boolean {
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") return i + 1 < tokens.length;
		const name = flagNameOf(token);
		if (flags.setterFlags.has(name)) return true;
		if (flags.valueFlags.has(token)) {
			i++; // the value belongs to the flag, whatever it looks like
			continue;
		}
		if (token.startsWith("+")) continue; // `date +%s`: an output format, not an operand
		if (token.startsWith("-") && token.length > 1) continue;
		return true;
	}
	return false;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One redirect as written in the command: the operator, its target word, and where it sits. */
interface RawRedirect {
	/** `<`, `<>`, `>`, `>>` or `>&`. */
	op: string;
	/** The word after the operator (`/dev/null`, `1`, a path, ...). */
	target: string;
	/** Offsets of the whole redirect (fd digits included), for masking the allowed ones out. */
	start: number;
	end: number;
	/** The ambiguous `&` in `>&file` / `&>file`, kept so the denial can name the right rewrite. */
	closeTo?: string;
}

/**
 * Redirects that cannot create a file: stderr discarded or merged into stdout, and any stream sent
 * to `/dev/null`.
 *
 * They are allowed because they are the reflex pasted into half of all shell one-liners
 * (`... 2>/dev/null | head`), and blocking them costs a full turn each time while writing nothing
 * anywhere. This is deliberately narrow: the target must be exactly `/dev/null`, so `2> /tmp/x` —
 * which *looks* like silencing and actually writes a file — stays blocked, as does every other
 * target, `2>&2`, `>&file`, and the `&>` form. `<` (stdin) is read-only and allowed; `<>` is not,
 * because it opens for writing and creates the file.
 */
function isDiscardRedirect(r: RawRedirect): boolean {
	if (r.op === "<") {
		// Process substitution: `<(...)` is not redirection at all, it runs a command and feeds the
		// result in. Denied and named, rather than silently treated as "reads stdin".
		if (r.target.startsWith("(")) return false;
		return true;
	}
	// `>&` is two different operators depending on the shell: `2>&1` duplicates a descriptor (no file),
	// while `&>word`/`>&word` truncates a file. A numeric target is unambiguously the first form.
	if (r.op === ">&") return /^\d+$/.test(r.target);
	if (r.op === ">" || r.op === ">>") {
		if (r.target !== "/dev/null") return false;
		// `ls >&/dev/null` is bash's `&>` form (discard); zsh reads the same text as fd 1 to a file named
		// /dev/null, i.e. the same file. Either way nothing new is created, but the ambiguity is not worth
		// the argument: `2>/dev/null` says the same thing and reads the same in both shells.
		return r.closeTo === undefined;
	}
	return false;
}

/**
 * Redirects that would be allowed if written the plain way, so the denial can name that form instead
 * of leaving the model to guess (or to retry with the same shape).
 */
function writeRedirectAdvice(r: RawRedirect): string {
	if (r.op === "<>") {
		return "`<>` opens a file for reading *and writing* (it creates it); use `<` for stdin.";
	}
	if ((r.op === "<" || r.op === ">") && r.target.startsWith("(")) {
		return `\`${r.op}(${r.target.slice(1)}\` is process substitution, which runs that command; this session only runs the commands it can check on their own.`;
	}
	if (r.op === ">&") {
		return `\`>&${r.target}\` redirects a stream into \`${r.target}\`; only a numeric target (\`2>&1\`) duplicates a descriptor — use a pipe instead.`;
	}
	if (r.closeTo !== undefined) {
		return `\`${r.op}\` here is the \`&>\` file-redirect form; use \`2>/dev/null\` to discard stderr.`;
	}
	return `output redirects are not allowed (\`${r.op}${r.target}\` writes a stream). Use a pipe, or \`2>/dev/null\` to discard stderr.`;
}

interface RawScan {
	/** Every redirect found outside quotes. */
	redirects: RawRedirect[];
	/** The quote never closed, so the command can't be parsed reliably. */
	unbalanced: boolean;
}

/**
 * Walk the raw command outside quotes and collect every redirect, with its fd prefix where present
 * (`2>/dev/null` and `>/dev/null` both land here). Unlike `stripRedirections` in scan-guard, this
 * keeps the operators and targets, because the fence has to judge them rather than drop them.
 */
function scanRaw(command: string): RawScan {
	const redirects: RawRedirect[] = [];
	let quote: "'" | '"' | null = null;
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === '"') quote = null;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\") {
			i += 2;
			continue;
		}
		// A leading run of digits is a file descriptor, not a number: only treat it as one when an
		// operator actually follows, else put it back and let the loop walk it normally.
		const fdStart = i;
		while (i < command.length && /\d/.test(command[i])) i++;
		const opChar = command[i];
		if (opChar !== "<" && opChar !== ">") {
			i = fdStart + 1;
			continue;
		}
		let op = opChar;
		i++;
		if (opChar === "<" && command[i] === ">") {
			// `<>` opens for reading *and writing*, creating the file: the one `<` form that is not a read
			op = "<>";
			i++;
		} else if (command[i] === opChar) {
			op += command[i];
			i++;
		} else if (opChar === ">" && command[i] === "&") {
			op += "&";
			i++;
		}
		// `&>file` and `>&file` are the same redirect; only the first is the form this fence allows for
		// /dev/null, so remember the preceding `&` and let the denial name the rewrite.
		const closeTo = opChar === ">" && (command[fdStart - 1] === "&" || op === ">&") ? "&" : undefined;
		let target = "";
		// `> /dev/null` and `>/dev/null` are both common, so skip the optional space
		while (i < command.length && (command[i] === " " || command[i] === "\t")) i++;
		while (i < command.length && !/[\s;&|]/.test(command[i])) {
			target += command[i];
			i++;
		}
		redirects.push({ op, target, start: fdStart, end: i, closeTo: op === "<" || op === "<>" ? undefined : closeTo });
	}
	return { redirects, unbalanced: quote !== null };
}

/**
 * Blank out the redirects that are allowed, so the segment splitter never sees them.
 *
 * Needed because `&` is a segment separator here: without masking, `rg x . 2>&1 | head` splits at the
 * `&` and the trailing `1` reads as an unknown command. Only discard redirects are masked — a
 * writing one has already been denied by the time this runs.
 */
function maskDiscardRedirects(command: string): string {
	let out = command;
	for (const r of scanRaw(command).redirects) {
		if (!isDiscardRedirect(r)) continue;
		out = out.slice(0, r.start) + " ".repeat(r.end - r.start) + out.slice(r.end);
	}
	return out;
}

/** The first unquoted redirect that could create a file, or undefined when every one is a discard. */
function firstWritingRedirect(command: string): RawRedirect | undefined {
	return scanRaw(command).redirects.find((r) => !isDiscardRedirect(r));
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

/** `tail`/`ls` flags that never return. Short forms only match exactly, so `-n 50` is untouched. */
const LONG_RUNNING_FLAGS = new Set(["-f", "-F", "-R"]);

function flagNameOf(token: string): string {
	return token.split("=", 1)[0];
}

/**
 * Any flag that points at a file or another program. `sed -i` is covered by sedIsReadOnly; these are
 * here because the tool can write (`jq --in-place`) or execute (`rg --pre`, `git --exec-path`,
 * `git --upload-pack`, `rg --hostname-bin`). A pattern that merely starts with `-` is still treated
 * as a flag: saying no to a weird pattern costs one turn, saying yes to `--pre` costs the fence.
 */
const EXEC_OR_WRITE_FLAGS = new Set([
	"--pre",
	"--pre-glob",
	"--hostname-bin",
	"--exec-path",
	"--upload-pack",
	"--receive-pack",
	"--in-place",
	"--config-env",
]);

/** True when the command line carries a flag that writes a file or runs another program. */
function hasDangerousFlag(tokens: string[], extra: Set<string> = new Set()): boolean {
	return tokens.some((t) => {
		const name = flagNameOf(t);
		return name.startsWith("-") && (extra.has(name) || EXEC_OR_WRITE_FLAGS.has(name));
	});
}

function deny(reason: string): ReadOnlyVerdict {
	return { ok: false, reason };
}

/**
 * Flags that hand a file to a program in the allow list, so the "only reads files" premise stops
 * holding. Checked for *every* allowed command, not just one of them.
 *
 * `-f`/`--file` is deliberately absent: it is a *read-from* flag everywhere it appears here
 * (`sort -f` ignores case, `uniq -f N` skips fields), and the commands that execute instead
 * (`grep -f` reads a pattern file) are read-only by construction.
 */
const DANGEROUS_ANYWHERE = new Set([
	"--exec",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fdelete",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

/**
 * `-o` / `--output` write a file for these two, but mean "only matching" for `grep`/`rg` and "OR" for
 * `find`, so the check has to be per command instead of global.
 */
const PER_COMMAND_WRITE_FLAGS: Record<string, Set<string>> = {
	sort: new Set(["-o", "--output"]),
	tree: new Set(["-o", "--output"]),
};

/** `xargs` optionally opens a file to read its items from; the rest of the file is left to the callee. */
const XARGS_OPENS_FILE = new Set(["-a", "--arg-file"]);
const XARGS_VALUE_FLAGS = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"--eof",
	"-I",
	"--replace",
	"-L",
	"--max-lines",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"-s",
	"--max-chars",
	"--process-slot-var",
]);

/** Git's pager override; an argument here runs as a program (there is no `--pager` long form). */
const GIT_PAGER_FLAGS = new Set(["-p", "--paginate"]);

/**
 * Judge one command. `ok` means every segment is a read-only command.
 *
 * Command substitutions (`$(...)`, backticks) are pulled out first: leaving them in the text makes
 * `sed -n "$(grep -n x f | cut -d: -f1)p" f` split on the pipe *inside* the substitution, and the
 * trailing `p" f` then reads as an unknown command. The substitution's own inner commands are judged
 * separately, so removing them from the outer text loses no coverage.
 */
export function judgeReadOnlyCommand(command: string): ReadOnlyVerdict {
	if (command.trim() === "") return { ok: true };
	if (scanRaw(command).unbalanced) {
		return deny("the command has an unclosed quote, so it cannot be checked; fix the quoting and retry.");
	}

	const { text, nested } = splitCommandSubstitutions(command);
	for (const inner of nested) {
		const verdict = judgeReadOnlyCommand(inner);
		if (!verdict.ok) {
			return deny(`a command substitution runs \`${inner.trim().slice(0, 60)}\`, which is denied: ${verdict.reason}`);
		}
	}
	// Everything the substitutions left behind, plus the outer command: judged once, on the full text,
	// so `echo x > f` and `... 2>/tmp/x` are still writes.
	const writing = firstWritingRedirect(text);
	if (writing) {
		return deny(writeRedirectAdvice(writing));
	}

	const segments = splitSegments(maskDiscardRedirects(text));
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

		if (SHELL_READ_ONLY.has(head)) {
			// `cd` writes the two pseudo-vars below; anything else here only prints or picks a branch
			if (tokens.some((t) => t.startsWith("OLDPWD=") || t.startsWith("PWD="))) {
				return deny(`\`${head}\` with a directory assignment is not a plain read; run it without the assignment.`);
			}
			continue;
		}

		if (head === "xargs") {
			// xargs is the one wrapper that cannot be skipped: `rg -l ... | xargs wc -l` is a real
			// read-only idiom. Only the callee's own reading matters, so it is judged as a command.
			//
			// Unknown flags are denied instead of skipped: an xargs flag changes *what it runs and with
			// which argv* (`-a` takes the items from a file instead of stdin; GNU's default-of-one-call
			// on empty input is the same class of surprise), so a flag this code has not seen is a flag
			// whose effect it cannot account for. Fail closed and name it.
			let i = 1;
			let callee: string[] | undefined;
			while (i < tokens.length) {
				const token = tokens[i];
				if (token === "--") {
					callee = tokens.slice(i + 1);
					break;
				}
				if (token.startsWith("-") && token.length > 1) {
					const name = flagNameOf(token);
					const short = token.slice(0, 2);
					// Attached values count: `-alist.txt` is `-a list.txt`, and matching only bare `-a` used
					// to let it through as an "unknown flag" that got silently skipped.
					if ((short === "-a" || XARGS_OPENS_FILE.has(name)) && name !== "--arg-file") {
						return deny(
							"`xargs -a <file>` reads its items from a file, which this session does not follow; pipe them in instead.",
						);
					}
					if (XARGS_OPENS_FILE.has(name)) {
						return deny(
							"`xargs --arg-file` reads its items from a file, which this session does not follow; pipe them in instead.",
						);
					}
					// A value-taking flag may carry its value attached (`-n1`, `-I{}`, `-d,`), so only the
					// two-character head has to match. A no-value flag must match the whole token: `-0foo`
					// looks like `-0` to a prefix match, but xargs would read `foo` as the command.
					const valueFlag = XARGS_VALUE_FLAGS.has(name) || (short !== name && XARGS_VALUE_FLAGS.has(short));
					if (!valueFlag && !XARGS_SAFE_NO_VALUE.has(token)) {
						return deny(
							`\`xargs ${token}\` is not a flag this read-only session knows; it changes what xargs runs, so it cannot be checked. Drop it and pipe the input in.`,
						);
					}
					// Skip the value too when it is a separate token; an attached form needs nothing
					if (valueFlag && !token.includes("=") && token.length === name.length && short === name) i++;
					i++;
					continue;
				}
				callee = tokens.slice(i);
				break;
			}
			if (!callee || callee.length === 0) {
				return deny("`xargs` must name a command to run; a bare `xargs` cannot be checked.");
			}
			const verdict = judgeReadOnlyCommand(callee.join(" "));
			if (!verdict.ok) return deny(`\`xargs\` would run a denied command: ${verdict.reason}`);
			continue;
		}

		if (SHELL_CONTROL_FLOW.has(head)) {
			return deny(
				`\`${head}\` is shell control flow. This session judges single commands, and a loop body is split off before it can be checked, so the whole construct is refused rather than half-checked. Run the body command on its own.`,
			);
		}

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
			if (hasDangerousFlag(tokens)) {
				return deny(
					"this git call passes a flag that can write or run another program, which this read-only session forbids.",
				);
			}
			const sub = subcommandOf(tokens, GIT_GLOBAL_VALUE_FLAGS);
			if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) {
				return deny(`\`git ${sub ?? ""}\` is not read-only. Only read-only git subcommands are allowed here.`);
			}
			// Only the *global* position matters: `git -p log` starts $PAGER (code execution from a poisoned
			// environment), while `git cat-file -p <obj>` is just "pretty print" on a subcommand flag.
			const subIndex = tokens.indexOf(sub);
			if (tokens.slice(1, subIndex).some((t) => GIT_PAGER_FLAGS.has(flagNameOf(t)))) {
				return deny("`git -p` can start your pager, which is not read-only; run git with `--no-pager`.");
			}
			if (sub === "worktree") {
				const action = subcommandOf(["git", ...tokens.slice(subIndex + 1)], new Set());
				if (action !== "list") {
					return deny("`git worktree` can create and remove worktrees; only `git worktree list` is read-only.");
				}
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
			const execFlag = tokens.find((t) => EXEC_OR_WRITE_FLAGS.has(flagNameOf(t)));
			if (execFlag) {
				return deny(
					`\`rg ${flagNameOf(execFlag)}\` runs another program for every file, which this read-only session forbids.`,
				);
			}
		} else if ((head === "tail" || head === "ls") && hasDangerousFlag(tokens, LONG_RUNNING_FLAGS)) {
			return deny(`\`${head}\` with a follow/recursive flag never returns; this session only runs bounded commands.`);
		}

		if (PLAIN_COMMANDS.has(head)) {
			const writeFlags = PER_COMMAND_WRITE_FLAGS[head];
			if (hasDangerousFlag(tokens, writeFlags ? new Set([...DANGEROUS_ANYWHERE, ...writeFlags]) : DANGEROUS_ANYWHERE)) {
				return deny(
					`\`${head}\` was given a flag that runs another program or writes a file; this session is read-only.`,
				);
			}
			if (head === "sed" && !sedIsReadOnly(tokens)) {
				return deny(
					"`sed -i` edits files in place, which this read-only session forbids. Use plain `sed -n` to print lines.",
				);
			}
			// `date`/`hostname` read the clock and the host name, but an operand turns them into setters
			const gated = FLAG_GATED_COMMANDS[head];
			if (gated && setsState(tokens, gated)) {
				return deny(
					`\`${head}\` with an operand or setter flag changes machine state instead of printing it; run it with no argument (\`date +%s\`, \`hostname -s\`).`,
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
