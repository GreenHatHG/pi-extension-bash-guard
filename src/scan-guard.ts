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

/** Leading env assignment at segment start (`FOO=bar cmd`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
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
}

/** Take a path's basename, to catch absolute calls like `/usr/bin/grep`. */
export function basename(token: string): string {
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

/**
 * Split segments on `;` `&` `|` and newlines, quote-aware — a `"a\|b"` (grep alternation) inside
 * double quotes must not count as a pipe. Backslash-escaped chars don't split either.
 */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			current += ch;
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
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			if (current.trim() !== "") segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") segments.push(current);
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
 * `grep` only walks dirs with a recursive flag (`-r`/`-R`/`--recursive`); roots are the operands
 * after the pattern (with `-e`/`-f`, every operand is a root).
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

	if (!recursive) return { recursive: false, roots: [] };
	return { recursive: true, roots: patternProvided ? operands : operands.slice(1) };
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

/** Pull nested commands out of `$()` and backticks, so shell substitution can't dodge the scan block. */
function extractNestedCommands(command: string): string[] {
	const nested: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
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
			if (ch === "$" && command[i + 1] === "(") {
				const end = findCommandSubstitutionEnd(command, i + 2);
				if (end !== -1) {
					nested.push(command.slice(i + 2, end));
					i = end;
				}
			}
			continue;
		}
		if (ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '"') {
			quote = ch;
			continue;
		}
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
				i = end;
			}
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			const end = findCommandSubstitutionEnd(command, i + 2);
			if (end !== -1) {
				nested.push(command.slice(i + 2, end));
				i = end;
			}
		}
	}
	return nested;
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

/** Parse every `find`/`grep`/`rg`/`du`/`tree` scan root in the command, in order of appearance. */
export function parseScanCommands(command: string, depth = 0): ParsedScan[] {
	const out: ParsedScan[] = [];
	if (!command || depth > 8) return out;
	for (const nested of extractNestedCommands(command)) out.push(...parseScanCommands(nested, depth + 1));
	for (const segment of splitSegments(command)) {
		const tokens = stripWrappers(tokenizeSegment(stripRedirections(segment)));
		if (tokens.length === 0) continue;
		const tool = basename(tokens[0]);
		const args = tokens.slice(1);
		if (tool === "find") {
			out.push({ tool, recursive: true, roots: findRoots(args) });
		} else if (tool === "grep" || tool === "egrep" || tool === "fgrep") {
			const { recursive, roots } = grepRoots(args);
			if (recursive) out.push({ tool, recursive, roots });
		} else if (tool === "rg") {
			const { roots } = rgRoots(args);
			out.push({ tool, recursive: true, roots });
		} else if (tool === "du" || tool === "tree") {
			const valueFlags = tool === "du" ? DU_VALUE_FLAGS : TREE_VALUE_FLAGS;
			out.push({ tool, recursive: true, roots: plainRoots(args, valueFlags) });
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
		fallback,
		"Re-issue a scoped command.",
	].join("\n");
}

/**
 * Check whether the command has an unbounded scan rooted at `$HOME`, `/`, or an exact system dir.
 * Returns a `ScanBlock` (with reason) on a hit, else null.
 */
export function detectBlockedScan(command: string, opts: { home: string }): ScanBlock | null {
	for (const scan of parseScanCommands(command)) {
		for (const root of scan.roots) {
			const kind = classifyRoot(root, opts.home);
			if (kind) return { tool: scan.tool, root, kind, reason: buildScanReason(scan.tool, root, kind) };
		}
	}
	return null;
}
