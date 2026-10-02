/**
 * 纯函数：解析 `find` / `grep` / `rg` / `du` / `tree` 的扫描 root 操作数；并据此检测
 * 「根目录为 $HOME 或 /」的无界扫描。
 *
 * 动机：现有 output guard 只在 `tool_result` 阶段看**输出字节**，像
 * `grep -rl X ~ | head` 这种命令输出极小、却要遍历整个 home（macOS 光 `~/Library`
 * 就几十 GB）的命令完全拦不住——真实事故跑了 934 秒。这里在 `tool_call` 阶段事前拦截。
 *
 * 解析分两层，刻意不写完整 shell 解析器：
 * 1. **段切分**：按 `;&|\n` 切，但**引号感知**——模式里的 `"a\|b"` 不能被当成管道。
 * 2. **段内 tokenizer**：处理单/双引号与反斜杠转义，才能正确拿到 `find "$HOME"` 的 root。
 *
 * 归一化只做**字面匹配**（`~` / `$HOME` / `${HOME}` / 字面 home 路径 / `/` / 精确系统目录），
 * 不做真实路径解析。`/Users/x/../x`、home 的符号链接别名会漏报——这是刻意的：
 * 目标是少误伤，而不是抓对抗样本（纯函数也不该去 stat）。
 *
 * 拦截集合（只匹配**精确 root**，更深子目录一律放行）：
 * - `root`：文件系统根 `/`。
 * - `home`：整个 home（`~`、`$HOME`、`${HOME}`、字面 home 路径）。
 * - `system`：`/etc`、`/var`、`/usr` 这类系统目录（`/etc/nginx` 这种子目录不拦）。
 */

/** 段首的环境变量赋值前缀（`FOO=bar cmd`）。 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `${HOME}` 字面量（拼接以避免被 lint 误认为模板占位符）。 */
const BRACED_HOME = "$" + "{HOME}";
/** 会被跳过的命令包装器。 */
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
/** 包装器里「后面跟一个值」的选项（宁多勿少：多吞只会漏报，不会误伤）。 */
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
/** `grep` 短选项里「后面跟一个值」的字母。 */
const GREP_SHORT_VALUE_FLAGS = new Set(["e", "f", "m", "A", "B", "C"]);
/** `grep` 长选项里「后面跟一个值」的名字（含 `--`）。 */
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
/** `rg` 短选项里「后面跟一个值」的字母（注意 `-r` 是 --replace，不是递归）。 */
const RG_SHORT_VALUE_FLAGS = new Set(["e", "f", "r", "t", "T", "g", "m", "A", "B", "C", "j", "M", "E"]);
/** `rg` 长选项里「后面跟一个值」的名字（含 `--`）。 */
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

/** 被拦截的扫描类型：`root` = 文件系统根，`home` = 整个 home 目录，`system` = 系统目录。 */
export type ScanKind = "root" | "home" | "system";

/**
 * 精确匹配才拦截的系统目录（子目录如 `/etc/nginx` 放行）。macOS 与 Linux 常见路径的并集，
 * 多出的一两个在另一平台不存在也无害。
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
	/** 命中的命令，如 `find` / `grep` / `rg`。 */
	tool: string;
	/** 原始 root 参数（用于提示文案）。 */
	root: string;
	kind: ScanKind;
	/** 返回给模型的拦截原因 + 收窄建议。 */
	reason: string;
}

/** 一次解析出的扫描命令。 */
export interface ParsedScan {
	/** 命令名（`find` / `grep` / `rg` / `du` / `tree`）。 */
	tool: string;
	/** 是否会递归遍历目录。 */
	recursive: boolean;
	/** 扫描 root 操作数（grep/rg 已去掉 pattern）。 */
	roots: string[];
}

/** 取路径的 basename，用于识别 `/usr/bin/grep` 这类绝对路径调用。 */
export function basename(token: string): string {
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

/**
 * 段切分：按 `;` `&` `|` 换行切，但**引号感知**——双引号里的 `"a\|b"`（grep 交替模式）
 * 不能被当成管道。反斜杠转义的字符也不切。
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

/** 段内 tokenizer：处理单引号（字面）、双引号（保留 `$VAR`、反斜杠转义）与反斜杠。 */
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
			i++; // 跳过收尾单引号
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
			i++; // 跳过收尾双引号
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
 * 去掉重定向（`2>/dev/null`、`> /tmp/out`、`<in`），避免把重定向目标误当成扫描 root。
 * 只在未加引号的 shell 语法中处理，避免把 `rg "a>b" .` 的模式破坏掉。
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

/** 剥掉段首的 `NAME=value` 赋值与 `sudo`/`env`/`xargs` 等包装器。 */
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

/** 把 root 字面量归类为 `root` / `home` / `system`；其余（含 `.`、子目录）返回 null 表示放行。 */
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

/** `find` 的 starting points（第一个 expression 选项之前的所有 operand）。 */
function findRoots(args: string[]): string[] {
	// GNU find 允许多个 starting point，且 `-H`/`-L`/`-P`（无值）与 `-D`/`-O`（带值）可前置。
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
			break; // 进入 expression，其后不再是 starting point
		}
		startingPoints.push(token);
	}
	return startingPoints;
}

/**
 * `grep` 只有带递归开关（`-r`/`-R`/`--recursive`）时才会遍历目录；root 是
 * pattern 之后的操作数（有 `-e`/`-f` 时所有操作数都是 root）。
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

/** `rg` 默认递归；root 是 pattern 之后的操作数（有 `-e`/`-f` 时所有操作数都是 root）。 */
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

/** `du`/`tree` 中需要单独消费一个值的选项；否则其值会被误当成扫描 root。 */
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

/** 非选项 operand（用于 `du`/`tree`），跳过选项及其独立值。 */
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

/** 提取 `$()` 与反引号中的嵌套命令，避免 shell command substitution 绕过扫描保护。 */
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

/** 解析命令里所有 `find`/`grep`/`rg`/`du`/`tree` 的扫描 root（按出现顺序）。 */
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

/** 组装拦截原因与收窄建议（模型可见）。 */
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
 * 检测命令中是否存在根目录为 `$HOME`、`/` 或精确系统目录的无界扫描。
 * 命中返回 `ScanBlock`（含 reason），否则返回 null。
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
