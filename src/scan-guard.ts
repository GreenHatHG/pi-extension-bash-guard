/**
 * Pure helper: find the scan root of `find` / `grep` / `rg` / `du` / `tree`, to catch unbounded
 * scans rooted at `$HOME` or `/`.
 *
 * The output guard only sees bytes at `tool_result`, so a command like `grep -rl X ~ | head` — tiny
 * output but walks the whole home dir (on macOS `~/Library` alone is tens of GB) — slips through.
 * So we block it earlier, at `tool_call`.
 *
 * Parsing has two layers; this is not a full shell parser:
 * 1. Split on `;&|\n`, quote-aware — a `"a\|b"` pattern must not count as a pipe.
 * 2. Tokenize inside a segment, handling single/double quotes and backslash escapes, so we can read
 *    the root in `find "$HOME"`.
 *
 * Matching is literal only (`~` / `$HOME` / `${HOME}` / a literal home path / `/` / an exact system
 * dir); we don't resolve real paths. `/Users/x/../x` and symlinked home aliases slip past on purpose:
 * we want few false hits, not to catch attackers (and a pure helper shouldn't stat anyway).
 *
 * The block list matches exact roots only; deeper subdirs always pass:
 * - `root`: the filesystem root `/`.
 * - `home`: the whole home dir (`~`, `$HOME`, `${HOME}`, a literal home path).
 * - `system`: system dirs like `/etc`, `/var`, `/usr` (subdirs like `/etc/nginx` pass).
 */

/** Leading env assignment at segment start (`FOO=bar cmd`); also used by the command classifier. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The `${HOME}` literal (built by joining so lint doesn't read it as a template placeholder). */
const BRACED_HOME = "$" + "{HOME}";
/** Command wrappers we skip past. */
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"command",
	"builtin",
	"exec",
	"env",
	"xargs",
	"nice",
	"nohup",
	"time",
	"stdbuf",
]);
/** Wrapper flags that take a value (err on the side of eating more: that only under-reports, never over-blocks). */
const WRAPPER_VALUE_FLAGS = new Set([
	"-u",
	"-g",
	"-p",
	"-C",
	"-h",
	"-r",
	"-t",
	"-U",
	"-I",
	"-i",
	"-L",
	"-s",
	"-a",
	"-E",
	"-P",
	"-d",
	"-n",
	"-o",
	"-e",
]);
/** `grep` short flags whose letter takes a value. */
const GREP_SHORT_VALUE_FLAGS = new Set(["e", "f", "m", "A", "B", "C"]);
/** `grep` long flags that take a value (including `--`). */
const GREP_LONG_VALUE_FLAGS = new Set([
	"--regexp",
	"--file",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
	"--include",
	"--exclude",
	"--exclude-dir",
	"--exclude-from",
	"--label",
	"--binary-files",
	"--devices",
	"--directories",
	"--group-separator",
]);
/** `rg` short flags whose letter takes a value (note `-r` is --replace, not recursive). */
const RG_SHORT_VALUE_FLAGS = new Set(["e", "f", "r", "t", "T", "g", "m", "A", "B", "C", "j", "M", "E"]);
/** `rg` long flags that take a value (including `--`). */
const RG_LONG_VALUE_FLAGS = new Set([
	"--regexp",
	"--file",
	"--replace",
	"--type",
	"--type-not",
	"--glob",
	"--iglob",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
	"--threads",
	"--max-columns",
	"--max-depth",
	"--max-filesize",
	"--encoding",
	"--engine",
	"--sort",
	"--sortr",
	"--pre",
	"--pre-glob",
	"--hostname-bin",
	"--color",
	"--colors",
]);

/** Scan kinds we block: `root` = filesystem root, `home` = whole home dir, `system` = system dir. */
export type ScanKind = "root" | "home" | "system";

/**
 * System dirs we block on an exact match (subdirs like `/etc/nginx` pass). A union of common macOS
 * and Linux paths; an extra one that doesn't exist on the other OS is harmless.
 */
const SYSTEM_ROOTS = new Set([
	"/etc",
	"/var",
	"/usr",
	"/System",
	"/Library",
	"/Applications",
	"/opt",
	"/private",
	"/bin",
	"/sbin",
	"/dev",
	"/proc",
]);

export interface ScanBlock {
	/** The command that hit, e.g. `find` / `grep` / `rg`. */
	tool: string;
	/** The raw root argument (for the message text). */
	root: string;
	kind: ScanKind;
	/** Block reason + narrowing hints sent back to the model. */
	reason: string;
}

/** One parsed scan command. */
export interface ParsedScan {
	/** Command name (`find` / `grep` / `rg` / `du` / `tree`). */
	tool: string;
	/** Whether it walks directories recursively. */
	recursive: boolean;
	/** Scan root operands (pattern already removed for grep/rg). */
	roots: string[];
	/**
	 * Whether the segment this scan sits in is fed by a pipe (`build | grep -E "FAIL"`). Such a scan only
	 * filters another program's output, so it is not the workload the timeout cap is meant for.
	 */
	piped: boolean;
}

/** One command segment plus how it was fed. */
export interface SplitSegment {
	text: string;
	/** Preceded by a pipe (`|` or `|&`) — its stdin comes from the previous segment. */
	piped: boolean;
}

/** Take a path's basename, to catch absolute calls like `/usr/bin/grep`. */
export function basename(token: string): string {
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

/**
 * Split segments on `;` `&` `|` and newlines, quote-aware — a `"a\|b"` (grep alternation) inside
 * double quotes must not count as a pipe. Backslash-escaped chars don't split either. The `&` of a
 * descriptor duplication (`2>&1`) is not a separator and stays in its segment.
 */
export function splitSegments(command: string): string[] {
	return splitSegmentsDetailed(command).map((segment) => segment.text);
}

/**
 * Same split as {@link splitSegments}, but each segment also records whether a pipe fed it.
 *
 * Only a real pipe counts (`|`, or bash's `|&`); `||` is an or-branch and runs standalone with no
 * stdin, so `rg foo || echo none` keeps its cap. Consecutive separators keep the pending flag:
 * the second `|` of `||` and the `&` of `|&` must not clear it.
 */
export function splitSegmentsDetailed(command: string): SplitSegment[] {
	const segments: SplitSegment[] = [];
	let current = "";
	let currentPiped = false;
	let inComment = false;
	let lineStart = 0;
	/** Last meaningful char outside a comment: tells a continued pipeline from a fresh command. */
	let lastSignificant = "";
	let quote: "'" | '"' | null = null;

	const flush = (): void => {
		if (current.trim() !== "") segments.push({ text: current, piped: currentPiped });
		current = "";
	};
	const mark = (ch: string): void => {
		if (!/\s/.test(ch)) lastSignificant = ch;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inComment) {
			// The newline itself is not part of the comment's text, so segments stay byte-identical.
			if (ch === "\n") {
				inComment = false;
				flush();
				// Blank and comment-only lines don't break a pipeline: `producer |`, `# why`, filter.
				if (lastSignificant !== "|" && lastSignificant !== "&") currentPiped = false;
				lineStart = i + 1;
			} else {
				current += ch;
			}
			continue;
		}

		if (quote === "'") {
			current += ch;
			mark(ch);
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			current += ch;
			if (ch === "\\" && i + 1 < command.length) {
				current += command[i + 1];
				i++;
				continue;
			}
			mark(ch);
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			mark(ch);
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === "#" && startsComment(command, i, lineStart)) {
			// A comment is not command text, so it neither feeds a pipe nor opens a quote.
			inComment = true;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			// `2>&1` / `>&2` duplicates a descriptor, it does not separate commands. Splitting there left a
			// stray `1` segment, so `grep ... 2>&1 | head` classified as unknown and got the 30KB limit
			// (real case: 2 lines / 30KB slipped through while the same command without `2>&1` was capped).
			if (ch === "&" && command[i - 1] === ">") {
				current += ch;
				continue;
			}
			flush();
			// Tracked across every separator, including one with an empty left side, so a slice like
			// ` | bash` still marks `bash` as pipe-fed.
			if (ch === "|") {
				currentPiped = command[i + 1] !== "|" && command[i - 1] !== "|";
			} else if (ch === "&") {
				if (command[i - 1] !== "|") currentPiped = false; // `|&` keeps what the `|` set
			} else if (ch === "\n") {
				if (lastSignificant !== "|" && lastSignificant !== "&") currentPiped = false;
				lineStart = i + 1;
			} else {
				currentPiped = false;
			}
			lastSignificant = ch === "\n" ? lastSignificant : ch;
			continue;
		}
		current += ch;
		mark(ch);
	}
	flush();
	return segments;
}

/** Tokenizer inside a segment: handles single quotes (literal), double quotes (keep `$VAR` and escapes), and backslashes. */
export function tokenizeSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let has = false;
	let i = 0;
	while (i < segment.length) {
		const ch = segment[i];
		if (ch === "'") {
			has = true;
			i++;
			while (i < segment.length && segment[i] !== "'") {
				current += segment[i];
				i++;
			}
			i++; // skip the closing single quote
			continue;
		}
		if (ch === '"') {
			has = true;
			i++;
			while (i < segment.length && segment[i] !== '"') {
				const inner = segment[i];
				if (inner === "\\" && i + 1 < segment.length && '"\\$`'.includes(segment[i + 1])) {
					current += segment[i + 1];
					i += 2;
					continue;
				}
				current += inner;
				i++;
			}
			i++; // skip the closing double quote
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			current += segment[i + 1];
			has = true;
			i += 2;
			continue;
		}
		if (/\s/.test(ch)) {
			if (has || current) tokens.push(current);
			current = "";
			has = false;
			i++;
			continue;
		}
		current += ch;
		has = true;
		i++;
	}
	if (has || current) tokens.push(current);
	return tokens;
}

/**
 * Strip redirections (`2>/dev/null`, `> /tmp/out`, `<in`) so a redirect target isn't mistaken for a
 * scan root. Only touches unquoted shell syntax, so `rg "a>b" .` keeps its pattern.
 */
export function stripRedirections(segment: string): string {
	let out = "";
	let quote: "'" | '"' | null = null;
	let i = 0;
	while (i < segment.length) {
		const ch = segment[i];
		if (quote) {
			out += ch;
			if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
				out += segment[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			out += ch + segment[i + 1];
			i += 2;
			continue;
		}

		let operatorStart = i;
		while (operatorStart < segment.length && /\d/.test(segment[operatorStart])) operatorStart++;
		if (operatorStart < segment.length && (segment[operatorStart] === "<" || segment[operatorStart] === ">")) {
			let afterOperator = operatorStart + 1;
			if (
				afterOperator < segment.length &&
				(segment[afterOperator] === segment[operatorStart] || segment[afterOperator] === "&")
			) {
				afterOperator++;
			}
			while (afterOperator < segment.length && /\s/.test(segment[afterOperator])) afterOperator++;
			while (afterOperator < segment.length) {
				const targetChar = segment[afterOperator];
				if (targetChar === "'" || targetChar === '"') {
					const targetQuote = targetChar;
					afterOperator++;
					while (afterOperator < segment.length && segment[afterOperator] !== targetQuote) {
						if (segment[afterOperator] === "\\" && targetQuote === '"') afterOperator++;
						afterOperator++;
					}
					afterOperator++;
					continue;
				}
				if (/\s|[;&|]/.test(targetChar)) break;
				afterOperator++;
			}
			out += " ";
			i = afterOperator;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Strip leading `NAME=value` assignments and wrappers like `sudo`/`env`/`xargs`. */
export function stripWrappers(tokens: string[]): string[] {
	const out = tokens.slice();
	for (let guard = 0; guard < 10; guard++) {
		while (out.length > 0 && ASSIGNMENT.test(out[0])) out.shift();
		if (out.length === 0) break;
		if (!WRAPPERS.has(basename(out[0]))) break;
		out.shift();
		while (out.length > 0 && out[0].startsWith("-") && out[0] !== "--") {
			const flag = out.shift() as string;
			if (WRAPPER_VALUE_FLAGS.has(flag)) out.shift();
		}
		if (out[0] === "--") out.shift();
	}
	return out;
}

/** Classify a root literal as `root` / `home` / `system`; null means pass (including `.` and subdirs). */
function classifyRoot(raw: string, home: string): ScanKind | null {
	if (raw === "") return null;
	if (/^\/+$/.test(raw)) return "root";
	const dir = raw.replace(/\/+$/, "");
	if (dir === "~" || dir === "$HOME" || dir === BRACED_HOME) return "home";
	if (home) {
		const normalizedHome = home.replace(/\/+$/, "");
		if (normalizedHome !== "" && dir === normalizedHome) return "home";
	}
	if (SYSTEM_ROOTS.has(dir)) return "system";
	return null;
}

/** `find` starting points (all operands before the first expression flag). */
function findRoots(args: string[]): string[] {
	// GNU find allows several starting points; `-H`/`-L`/`-P` (no value) and `-D`/`-O` (value) may come first.
	const PRE_NOARG = new Set(["-H", "-L", "-P"]);
	const PRE_ARG = new Set(["-D", "-O"]);
	let endOfOptions = false;
	const startingPoints: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token.length > 1) {
			if (PRE_NOARG.has(token)) continue;
			if (PRE_ARG.has(token)) {
				i++;
				continue;
			}
			break; // reached the expression, nothing after is a starting point
		}
		startingPoints.push(token);
	}
	return startingPoints;
}

/**
 * `grep` roots are the operands after the pattern (with `-e`/`-f`, every operand is a root).
 * The `recursive` flag is kept only so the scan-block check can skip non-recursive grep — a
 * single-file grep like `grep foo /` can't walk a tree, so it's not a scan (but it still gets
 * the 5-minute timeout cap, since a pathological regex on a huge file hangs just the same).
 */
function grepRoots(args: string[]): { recursive: boolean; roots: string[] } {
	let recursive = false;
	let patternProvided = false;
	let endOfOptions = false;
	const operands: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("--")) {
			const name = token.split("=")[0];
			if (name === "--recursive" || name === "--dereference-recursive") recursive = true;
			if (name === "--regexp" || name === "--file") patternProvided = true;
			if (!token.includes("=") && GREP_LONG_VALUE_FLAGS.has(name)) i++;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token.length > 1) {
			const cluster = token.slice(1);
			if (/[rR]/.test(cluster)) recursive = true;
			if (/[ef]/.test(cluster)) patternProvided = true;
			if (GREP_SHORT_VALUE_FLAGS.has(cluster[cluster.length - 1])) i++;
			continue;
		}
		operands.push(token);
	}

	if (!patternProvided && operands.length === 0) return { recursive, roots: [] };
	return { recursive, roots: patternProvided ? operands : operands.slice(1) };
}

/** `rg` is recursive by default; roots are the operands after the pattern (with `-e`/`-f`, every operand is a root). */
function rgRoots(args: string[]): { recursive: boolean; roots: string[] } {
	let patternProvided = false;
	let endOfOptions = false;
	const operands: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("--")) {
			const name = token.split("=")[0];
			if (name === "--regexp" || name === "--file") patternProvided = true;
			if (!token.includes("=") && RG_LONG_VALUE_FLAGS.has(name)) i++;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token.length > 1) {
			const cluster = token.slice(1);
			if (cluster.includes("e") || cluster.includes("f")) patternProvided = true;
			if (RG_SHORT_VALUE_FLAGS.has(cluster[cluster.length - 1])) i++;
			continue;
		}
		operands.push(token);
	}

	return { recursive: true, roots: patternProvided ? operands : operands.slice(1) };
}

/** `du`/`tree` flags that take a value; otherwise the value is mistaken for a scan root. */
const DU_VALUE_FLAGS = new Set([
	"-d",
	"-t",
	"-B",
	"--block-size",
	"--exclude",
	"--exclude-from",
	"--max-depth",
	"--threshold",
	"--time-style",
]);
const TREE_VALUE_FLAGS = new Set(["-H", "-I", "-L", "-P", "-o", "--ignore", "--level", "--pattern", "--output"]);

/** Non-flag operands (for `du`/`tree`), skipping flags and their separate values. */
function plainRoots(args: string[], valueFlags: Set<string>): string[] {
	const roots: string[] = [];
	let endOfOptions = false;
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("--")) {
			const name = token.split("=")[0];
			if (!token.includes("=") && valueFlags.has(name)) i++;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token.length > 1) {
			if (valueFlags.has(token)) i++;
			continue;
		}
		roots.push(token);
	}
	return roots;
}

/**
 * Placeholder a command substitution is replaced with: a plain word with no shell syntax in it, so
 * splitting the outer command on `;&|` can no longer see the separators that live inside the
 * substitution.
 */
export const SUBSTITUTION_MARKER = "__pi_substitution__";

export interface CommandSubstitutions {
	/** The command with every substitution replaced by SUBSTITUTION_MARKER (quotes preserved). */
	text: string;
	/** The inner command text of each substitution, in order of appearance. */
	nested: string[];
}

/**
 * Replace `$(...)` and backticks with SUBSTITUTION_MARKER, collecting what they run.
 *
 * Both forms execute their contents, so they are pulled out and judged as commands of their own
 * (see read-only.ts), and replacing them here keeps the *outer* command parseable: without it,
 * `sed -n "$(grep -n x f | cut -d: -f1)p" f` is split on the `|` inside the substitution and the
 * trailing `p" f` becomes an unknown segment.
 *
 * Substitutions inside single quotes are literal text and are left alone, so a stray `$(` there still
 * fails closed downstream instead of being silently treated as code.
 */
export function splitCommandSubstitutions(command: string): CommandSubstitutions {
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
		// Inside double quotes `$(...)` and backticks still execute, so they are collected here too.
		if (ch === "`") {
			let end = i + 1;
			while (end < command.length) {
				if (command[end] === "\\") {
					end += 2;
					continue;
				}
				if (command[end] === "`") break;
				end++;
			}
			if (end < command.length) {
				nested.push(command.slice(i + 1, end));
				text += SUBSTITUTION_MARKER;
				i = end;
				continue;
			}
		}
		if (ch === "$" && command[i + 1] === "(") {
			const end = findCommandSubstitutionEnd(command, i + 2);
			if (end !== -1) {
				nested.push(command.slice(i + 2, end));
				text += SUBSTITUTION_MARKER;
				i = end;
				continue;
			}
		}
		if (ch === "'" || ch === '"') quote = quote === null ? ch : quote;
		text += ch;
	}
	return { text, nested };
}

/** What each substitution runs, in order of appearance (nested ones are judged recursively later). */
export function extractNestedCommands(command: string): string[] {
	return splitCommandSubstitutions(command).nested;
}

/**
 * Word lists of `for <name> in <words>; do ... done` loops.
 *
 * `for f in $(grep -l pattern ~/.pi/agent/sessions); do ...` is an unbounded scan that no single
 * segment shows: the word list sits between `in` and `do`, where the segment splitter never looks.
 * The body needs no handling here — read-only.ts judges it as its own command.
 */
const FOR_IN = /\bfor\s+[A-Za-z_]\w*\s+in\s+([\s\S]*?)(?=;|\n|\bdo\b)/g;
export function extractForWordLists(command: string): string[] {
	const out: string[] = [];
	for (const match of command.matchAll(FOR_IN)) out.push(match[1]);
	return out;
}

function findCommandSubstitutionEnd(command: string, start: number): number {
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
		if (ch === "$") {
			if (command[i + 1] === "(") {
				depth++;
				i++;
			}
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

/** A heredoc body is replaced with this word: plain, so it stays one token. */
export const HEREDOC_MARKER = "__pi_heredoc__";

/**
 * Words that mean "a shell may read this body", so the body stays command text.
 *
 * The check is deliberately generous: one shell word anywhere on the opening line and nothing is masked.
 * Not masking only costs the old noise (a body line that looks like a scan gets judged); masking a body
 * a shell really runs would hide a real command, so the error direction is one-way.
 *
 * History has zero shell-fed heredocs (all 1,197 archived ones feed `python3`, `cat` or `git`), so this
 * list costs nothing today and covers the shapes a shell can actually be reached through: a shell name
 * behind any wrapper (`timeout 30 bash`, `sudo -E bash`, `env -i sh`, `xargs -I{} sh -c`), glued to an
 * operator (`|bash`, `&&bash`), after a keyword (`{ bash; }`), via `$SHELL`/`$BASH`, or `source`.
 */
const HEREDOC_BODY_IS_CODE = new Set([
	"bash",
	"rbash",
	"sh",
	"zsh",
	"rzsh",
	"dash",
	"ksh",
	"ksh93",
	"rksh",
	"mksh",
	"pdksh",
	"ash",
	"fish",
	"csh",
	"tcsh",
	"ssh",
	"su",
	"eval",
	"source",
	// POSIX `.` sources a file — the same reach as `source`.
	".",
	"yash",
	"posh",
	"oksh",
	"loksh",
	"$SHELL",
	"$BASH",
	// Braced forms of the same variables (built by joining so lint doesn't read them as placeholders).
	"$" + "{SHELL}",
	"$" + "{BASH}",
]);

/** One parsed `<<` operator. */
interface HeredocOp {
	/** Closing word, quotes removed. */
	delimiter: string;
	/** `<<-`: leading tabs are stripped before comparing to the delimiter. */
	stripTabs: boolean;
	/** Quoted delimiter: the body is literal bytes, so nothing inside it runs. */
	literal: boolean;
}

/** Where an operator sits in the command text. */
interface HeredocOpRange {
	start: number;
	end: number;
	op: HeredocOp;
	/**
	 * `0<<'EOF'` / `2<<'EOF'` redirects a descriptor instead of feeding the program's stdin, so a later
	 * command can still read the body. The body is never masked, but it is still skipped so its prose
	 * cannot pair with a later delimiter-looking line and mask a real command.
	 */
	fdRedirect: boolean;
}

/** Operators opened on one logical line, plus the body they share. */
interface HeredocGroup {
	ranges: HeredocOpRange[];
	/** Index of the newline that ends the opening logical line. */
	lineEnd: number;
	/** Index just past the last closing delimiter line. */
	bodyEnd: number;
	/** Commands an unquoted body would still run (`$(...)` / backticks), in order. */
	expansions: string[];
}

/**
 * Read a `<<` / `<<-` operator and its delimiter, or null when it is not one we can read.
 *
 * Deliberately refuses rather than guesses: a missed heredoc leaves the body being judged as commands
 * (the old, noisy-but-safe behaviour), while a wrong guess hides commands the shell really runs.
 */
function parseHeredocOperator(command: string, start: number): { op: HeredocOp; end: number } | null {
	let i = start + 2;
	if (command[i] === "<") return null; // `<<<` herestring: its operand is a word, not a body
	let stripTabs = false;
	if (command[i] === "-") {
		stripTabs = true;
		i++;
	}
	while (i < command.length && /[ \t]/.test(command[i])) i++;
	let delimiter = "";
	let literal = false;
	while (i < command.length) {
		const ch = command[i];
		if (ch === "'" || ch === '"') {
			const close = command.indexOf(ch, i + 1);
			if (close === -1) return null;
			delimiter += command.slice(i + 1, close);
			literal = true;
			i = close + 1;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			delimiter += command[i + 1];
			literal = true;
			i += 2;
			continue;
		}
		if (/[\w.-]/.test(ch)) {
			delimiter += ch;
			i++;
			continue;
		}
		break;
	}
	if (delimiter === "") return null;
	// `$((1<<2))` / `for ((i=0;i<<3;i++))`: a shift, not a redirect.
	if (/^\d+$/.test(delimiter)) return null;
	const after = command[i] ?? "";
	if (!/^$|[ \t\n;&|<>]/.test(after)) return null;
	return { op: { delimiter, stripTabs, literal }, end: i };
}

/**
 * Index of the newline that ends the logical line containing `from`, or -1 when the command ends first.
 *
 * A newline inside quotes, or escaped by a backslash, does not end the line — the opening line of a
 * heredoc keeps going through both, and everything up to the real end is command text, not a body.
 * Called only at an operator, which by construction sits outside quotes, so the scan starts unquoted.
 */
function logicalLineEnd(command: string, from: number): number {
	let quote: "'" | '"' | null = null;
	let substitutions = 0;
	let backtick = false;
	let i = from;
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
		if (ch === "\\") {
			i += 2; // also swallows the newline of a `\`-continuation
			continue;
		}
		if (backtick) {
			if (ch === "`") backtick = false;
			i++;
			continue;
		}
		if (ch === "`") {
			backtick = true;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		// `$( … )` keeps running across a newline, so the line is not over yet.
		if (ch === "$" && command[i + 1] === "(") {
			substitutions++;
			i += 2;
			continue;
		}
		if (ch === "(" && substitutions > 0) {
			substitutions++;
			i++;
			continue;
		}
		if (ch === ")" && substitutions > 0) {
			substitutions--;
			i++;
			continue;
		}
		if (ch === "\n" && substitutions === 0) return i;
		i++;
	}
	return -1;
}

/** Index where the logical line containing `index` starts, walking back over `\`-continued newlines. */
function logicalLineStartFrom(command: string, anchor: number, index: number): number {
	let start = anchor;
	let i = anchor;
	while (i <= index) {
		const end = logicalLineEnd(command, i);
		if (end === -1 || end >= index) break;
		start = end + 1;
		i = end + 1;
	}
	return start;
}

/** True when `#` right here starts a comment: at line start, or after a metacharacter that ends a word. */
function startsComment(command: string, index: number, lineStart: number): boolean {
	if (index === lineStart) return true;
	// `${#x}` is a length expansion, not a comment.
	if (command[index - 1] === "{" && command[index - 2] === "$") return false;
	return /[\s;&|(){}]/.test(command[index - 1] ?? " ");
}

/**
 * Find the first real heredoc operator at or after `from`.
 *
 * Skips the places where `<<` is ordinary text: inside quotes, after an unquoted `#` (a comment runs to
 * the end of the line, so a comment that mentions `<<EOF` opens nothing), inside `((…))` / `$((…))` (a
 * shift), and inside `${…}` (parameter expansion).
 */
function findNextHeredocOperator(command: string, from: number): HeredocOpRange | null {
	let quote: "'" | '"' | null = null;
	let arithmetic = 0;
	let parameter = 0;
	let lineStart = command.lastIndexOf("\n", from - 1) + 1;
	let i = from;
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
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\n") {
			lineStart = i + 1;
			i++;
			continue;
		}
		if (ch === "#" && startsComment(command, i, lineStart)) {
			const newlineAt = command.indexOf("\n", i);
			if (newlineAt === -1) return null;
			i = newlineAt;
			continue;
		}
		if (ch === "$" && command[i + 1] === "{") {
			parameter++;
			i += 2;
			continue;
		}
		if (ch === "}" && parameter > 0) {
			parameter--;
			i++;
			continue;
		}
		if (ch === "(" && command[i + 1] === "(") {
			arithmetic++;
			i += 2;
			continue;
		}
		if (ch === ")" && command[i + 1] === ")" && arithmetic > 0) {
			arithmetic--;
			i += 2;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<" && arithmetic === 0 && parameter === 0) {
			if (command[i + 2] === "<") {
				i += 3; // herestring: `<command> <<< word`
				continue;
			}
			const parsed = parseHeredocOperator(command, i);
			if (parsed) {
				return { start: i, end: parsed.end, op: parsed.op, fdRedirect: /[0-9]/.test(command[i - 1] ?? "") };
			}
		}
		i++;
	}
	return null;
}

/**
 * Commands an unquoted heredoc body really runs.
 *
 * Quote characters in a body are literal bytes, so a `$(…)` inside `'…'` in the prose still executes —
 * `splitCommandSubstitutions` would skip it because it reads shell quoting. Only quoting *inside* the
 * substitution is shell syntax, which `findCommandSubstitutionEnd` already handles.
 */
function extractHeredocExpansions(body: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === "\\") {
			i += 2; // `\$` / ``\` `` are literal, so the pair is not an expansion
			continue;
		}
		if (ch === "`") {
			let end = i + 1;
			while (end < body.length) {
				if (body[end] === "\\") {
					end += 2;
					continue;
				}
				if (body[end] === "`") break;
				end++;
			}
			if (end < body.length) {
				out.push(body.slice(i + 1, end));
				i = end + 1;
				continue;
			}
			break;
		}
		if (ch === "$" && body[i + 1] === "(") {
			const end = findCommandSubstitutionEnd(body, i + 2);
			if (end !== -1) {
				out.push(body.slice(i + 2, end));
				i = end + 1;
				continue;
			}
		}
		i++;
	}
	return out;
}

/**
 * Pair the operators opened on one logical line with the body they share.
 *
 * Returns the operator's end as `end` when no group could be resolved: an unclosed heredoc is a syntax
 * error in bash, so guessing would swallow every command after it. `end` is also how the caller stays
 * linear — see {@link maskHeredocBodies}.
 */
function resolveHeredocGroup(command: string, first: HeredocOpRange): { group: HeredocGroup | null; end: number } {
	const ranges: HeredocOpRange[] = [first];
	let last = first;
	let lineEnd = logicalLineEnd(command, last.end);
	while (lineEnd !== -1) {
		const next = findNextHeredocOperator(command, last.end);
		if (!next || next.start > lineEnd) break;
		ranges.push(next);
		last = next;
		lineEnd = logicalLineEnd(command, last.end);
	}
	if (lineEnd === -1) return { group: null, end: command.length };
	let pos = lineEnd + 1;
	const expansions: string[] = [];
	for (const range of ranges) {
		const bodyStart = pos;
		let closed = false;
		while (pos < command.length) {
			const newlineAt = command.indexOf("\n", pos);
			const end = newlineAt === -1 ? command.length : newlineAt;
			const line = command.slice(pos, end);
			const compared = range.op.stripTabs ? line.replace(/^\t+/, "") : line;
			pos = newlineAt === -1 ? command.length : newlineAt + 1;
			if (compared === range.op.delimiter) {
				closed = true;
				break;
			}
		}
		if (!closed) return { group: null, end: command.length };
		if (!range.op.literal) {
			// Unquoted delimiter: the body still expands `$(...)` and backticks, and those really run.
			expansions.push(...extractHeredocExpansions(command.slice(bodyStart, pos)));
		}
	}
	return { group: { ranges, lineEnd, bodyEnd: pos, expansions }, end: pos };
}

/** `sudo` flags that start a shell with the heredoc on stdin. */
const SUDO_SHELL_FLAGS = new Set(["-s", "-i", "--shell", "--login"]);

/** True when one token names a shell: `bash`, `|bash`, `(bash)`, `$SHELL`, `/bin/sh`. */
function tokenIsShell(token: string): boolean {
	// Raw first: stripping would turn `${BASH}` into `${BASH` and lose the match.
	if (HEREDOC_BODY_IS_CODE.has(token)) return true;
	const cleaned = token.replace(/^[^A-Za-z0-9_$/.-]+/, "").replace(/[^A-Za-z0-9_$/.-]+$/, "");
	if (cleaned === "") return false;
	if (HEREDOC_BODY_IS_CODE.has(cleaned)) return true;
	// `$'bash'` / `$"bash"` tokenize to `$bash`; the `$` is a quoting prefix, not part of the name.
	const program = basename(cleaned).replace(/^\$/, "");
	return HEREDOC_BODY_IS_CODE.has(program);
}

/**
 * True when anything on the opening line names a way into a shell, so the body is a script, not data.
 *
 * Token-level on purpose: `timeout --signal KILL 5 bash` and `f() { bash; }` have no single "program
 * token" to inspect, but they do contain a shell name.
 */
function heredocFeedsShell(header: string): boolean {
	// Raw tokens too: `stripRedirections` deletes `>(bash)`, a process substitution that runs a shell.
	const tokens = [...tokenizeSegment(header), ...tokenizeSegment(stripRedirections(header))];
	if (tokens.some(tokenIsShell)) return true;
	// `sudo -s` / `sudo -i` start a root shell with this body on stdin; the shell name is the flag.
	const sudoShell = tokens.includes("sudo") || tokens.includes("su");
	return sudoShell && tokens.some((token) => SUDO_SHELL_FLAGS.has(token));
}

/** How many lines after a body may hold the shell that consumes it. */
const CONSUMER_LOOKAHEAD_LINES = 12;

/** The lines after a body that may hold the shell consuming it: blanks and comments skipped, bounded. */
function consumerAfterBody(command: string, from: number): string {
	// Look a few lines ahead, not just one: a compound group's consumer (`} | bash`) can sit below the
	// body with an ordinary command line in between, and that line is part of the generated script.
	const lines: string[] = [];
	let start = from;
	let end = logicalLineEnd(command, start);
	let scanned = 0;
	while (end !== -1 && scanned < CONSUMER_LOOKAHEAD_LINES) {
		const line = command.slice(start, end);
		const trimmed = line.trim();
		if (trimmed !== "" && !trimmed.startsWith("#")) lines.push(line);
		if (heredocFeedsShell(line)) break;
		start = end + 1;
		end = logicalLineEnd(command, start);
		scanned++;
	}
	if (end === -1) lines.push(command.slice(start));
	return lines.join("\n");
}

/**
 * Replace heredoc bodies with {@link HEREDOC_MARKER} so their text is never read as commands.
 *
 * Without this, the body of `git commit -F - <<'EOF' … EOF` is scanned as if the shell would run every
 * line of the commit message: a binary name in the prose was blocked as a filesystem scan (it really
 * happened, twice in one session), and 42 of the 1,197 archived heredoc commands were capped to a 300s
 * timeout for a scan that does not exist. 98% of those heredocs quote the delimiter, so the body is
 * pure bytes.
 *
 * Scanning resumes *after* each removed body, so an apostrophe or `${` in prose cannot leak quote state
 * into the next heredoc. An unquoted delimiter keeps its executing part: the collected `$(...)` /
 * backtick contents are appended as their own segments, so they are still judged.
 *
 * A body a shell may read is left alone — see {@link heredocFeedsShell}.
 */
export function maskHeredocBodies(command: string): string {
	if (!command.includes("<<")) return command;
	let out = "";
	let cursor = 0;
	let scanFrom = 0;
	while (scanFrom < command.length) {
		const first = findNextHeredocOperator(command, scanFrom);
		if (!first) break;
		const resolved = resolveHeredocGroup(command, first);
		if (!resolved.group) {
			// Unclosed: bash rejects the script, so nothing runs. Stop instead of rescanning the tail.
			scanFrom = resolved.end;
			continue;
		}
		const group = resolved.group;
		if (first.fdRedirect) {
			// Descriptor redirect: the body stays command text, but scanning resumes past it so its
			// prose cannot pair with a later delimiter-looking line.
			scanFrom = group.bodyEnd;
			continue;
		}
		// Start of the logical line holding the operator. `scanFrom` is always a line boundary (0 or a
		// body end), so this is a forward walk — and it cannot reach back into a removed body.
		const lineStart = logicalLineStartFrom(command, scanFrom, first.start);
		if (
			heredocFeedsShell(command.slice(lineStart, group.lineEnd)) ||
			// The consumer can be named after the body: `{ cat <<EOF … EOF ; } | bash`. Blank lines and
			// comment lines in between belong to the same group, so they are skipped, not treated as the
			// consumer.
			heredocFeedsShell(consumerAfterBody(command, group.bodyEnd))
		) {
			// Skip the whole group: the remaining bodies on this line share the same shell, and
			// re-evaluating them would look at a header slice with the shell word cut off.
			scanFrom = group.bodyEnd;
			continue;
		}
		for (const range of group.ranges) {
			out += `${command.slice(cursor, range.start)} ${HEREDOC_MARKER} `;
			cursor = range.end;
		}
		out += command.slice(cursor, group.lineEnd);
		out += "\n";
		for (const expansion of group.expansions) out += `; ${expansion} `;
		out += "\n";
		cursor = group.bodyEnd;
		scanFrom = group.bodyEnd;
	}
	out += command.slice(cursor);
	return out;
}

/** Parse every `find`/`grep`/`rg`/`du`/`tree` scan root in the command, in order of appearance. */
export function parseScanCommands(command: string, depth = 0): ParsedScan[] {
	const out: ParsedScan[] = [];
	if (!command || depth > 8) return out;
	// Heredoc bodies are text handed to a program, not commands this shell will run.
	const masked = maskHeredocBodies(command);
	for (const nested of extractNestedCommands(masked)) out.push(...parseScanCommands(nested, depth + 1));
	for (const words of extractForWordLists(masked)) out.push(...parseScanCommands(words, depth + 1));
	for (const segment of splitSegmentsDetailed(masked)) {
		const tokens = stripWrappers(tokenizeSegment(stripRedirections(segment.text)));
		if (tokens.length === 0) continue;
		const tool = basename(tokens[0]);
		const args = tokens.slice(1);
		if (tool === "find") {
			out.push({ tool, recursive: true, roots: findRoots(args), piped: segment.piped });
		} else if (tool === "grep" || tool === "egrep" || tool === "fgrep") {
			// Every grep is parsed (roots + recursion flag); the block check skips non-recursive ones,
			// but the timeout cap covers them all — see `searchTimeoutInjection`.
			out.push({ tool, ...grepRoots(args), piped: segment.piped });
		} else if (tool === "rg") {
			const { roots } = rgRoots(args);
			out.push({ tool, recursive: true, roots, piped: segment.piped });
		} else if (tool === "du" || tool === "tree") {
			const valueFlags = tool === "du" ? DU_VALUE_FLAGS : TREE_VALUE_FLAGS;
			out.push({ tool, recursive: true, roots: plainRoots(args, valueFlags), piped: segment.piped });
		}
	}
	return out;
}

/** Build the block reason and narrowing hints (model-visible). */
export function buildScanReason(tool: string, root: string, kind: ScanKind): string {
	const headline =
		kind === "root"
			? `Blocked before running: \`${tool}\` was asked to scan the filesystem root \`${root}\`.`
			: kind === "home"
				? `Blocked before running: \`${tool}\` was asked to scan your entire home directory (\`${root}\`).`
				: `Blocked before running: \`${tool}\` was asked to scan the system directory \`${root}\`.`;
	const fallback =
		kind === "home"
			? "- If you truly need all of `~`: `rg --hidden -g '!Library/**' -g '!**/node_modules/**' -g '!**/.git/**' <pattern> ~`."
			: `- If you truly need \`${root}\`: bound it — \`find ${root} -maxdepth 2 -name '<name>' 2>/dev/null\`.`;
	return [
		`[BASH SCAN GUARD] ${headline}`,
		"This walks a large or system tree and can take many minutes while producing almost no output.",
		"Scope it instead:",
		"- Code search: `rg -l <pattern> <project-dir>` (rg is fast and respects .gitignore); add `-g '!**/node_modules/**'` if needed.",
		"- Find by name: `mdfind -name '<name>'` (macOS Spotlight index, near-instant).",
		"- Find an executable: `command -v <name>` / `type -a <name>`; for a global package: `npm root -g`, `npm ls -g --depth=0`, `ls /usr/lib/node_modules`.",
		fallback,
		"Re-issue a scoped command.",
	].join("\n");
}

/** True for the grep family: `grep`/`egrep`/`fgrep`. */
function toolEndsWithGrep(tool: string): boolean {
	return tool === "grep" || tool === "egrep" || tool === "fgrep";
}

/**
 * Check whether the command has an unbounded scan rooted at `$HOME`, `/`, or an exact system dir.
 * Returns a `ScanBlock` (with reason) on a hit, else null.
 */
export function detectBlockedScan(command: string, opts: { home: string }): ScanBlock | null {
	for (const scan of parseScanCommands(command)) {
		// Non-recursive grep reads explicit files only — it can't walk a tree, so it never blocks.
		// (`egrep`/`fgrep` are the same tool under old names.)
		if (toolEndsWithGrep(scan.tool) && !scan.recursive) continue;
		for (const root of scan.roots) {
			const kind = classifyRoot(root, opts.home);
			if (kind) return { tool: scan.tool, root, kind, reason: buildScanReason(scan.tool, root, kind) };
		}
	}
	return null;
}
