/**
 * 纯函数：把一条 shell 命令归入三类，用来决定「用哪个字节阈值」和「用什么语气」。
 *
 * 分类是**保守白名单**：只有整条命令（去掉语义中性命令后）全部命中已知的
 * 「过程输出」命令，才算 `exhaust`；只要有一段解析不了、或出现白名单之外
 * 的命令，就落到 `unknown`（按高价值载荷对待）。这样即使判错，方向也是
 * 「多给模型内容」，而不是「吞掉模型真正需要的内容」。
 *
 * - `exhaust`：列举 / 搜索 / 环境转储 / 历史记录。典型输出是过程噪声，
 *   用**紧阈值**（`maxBytes`）+ 重写建议 + 重复/升级警告。
 * - `build-test`：构建 / 测试命令。失败时错误信息密度高，用**宽阈值**
 *   （`payloadMaxBytes`），并保证错误行和尾部被保留。
 * - `unknown`：其余命令（含 `cat`/`sed` 这类读文件）。内容可能就是模型要的
 *   载荷，按高价值载荷对待：**宽阈值**、不说教、不计入升级。
 */

import { basename, splitSegments, stripRedirections, stripWrappers, tokenizeSegment } from "./scan-guard";

/** 命令归类。 */
export type CommandClass = "exhaust" | "build-test" | "unknown";

/**
 * 命令清单的**词汇表**参考 claude-code 的 BashTool
 * （packages/builtin-tools/src/tools/BashTool/BashTool.tsx:95-150 的
 * BASH_SEARCH_COMMANDS / BASH_READ_COMMANDS / BASH_LIST_COMMANDS /
 * BASH_SEMANTIC_NEUTRAL_COMMANDS / BASH_SILENT_COMMANDS）。
 *
 * 但**用途不同**：那边只用于「UI 是否折叠」，这里用于「用哪档字节阈值」。所以
 * 我们沿用它的命令清单，并按本插件的策略做了增补（每组注释里标了「本插件增补」）。
 */

/** 搜索 / 列举类：输出是「命中清单 / 命中行」，典型过程输出。 */
const SEARCH_COMMANDS = new Set([
	// claude-code BASH_SEARCH_COMMANDS
	"find",
	"grep",
	"rg",
	"ag",
	"ack",
	"locate",
	"which",
	"whereis",
	// claude-code BASH_LIST_COMMANDS（列举同样是过程输出）
	"ls",
	"tree",
	"du",
	// 本插件增补：常见别名 / 现代替代 / 环境与进程转储
	"egrep",
	"fgrep",
	"fd",
	"env",
	"printenv",
	"ps",
]);

/**
 * 读文件 / 转换类：内容很可能就是模型要的载荷，所以**单独一类**，不并入
 * `exhaust`；单独出现时按 `unknown`（宽阈值）对待。
 */
const READ_COMMANDS = new Set([
	// claude-code BASH_READ_COMMANDS
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"stat",
	"file",
	"strings",
	"jq",
	"awk",
	"cut",
	"sort",
	"uniq",
	"tr",
	// 本插件增补
	"sed",
	"bat",
	"nl",
]);

/** claude-code BASH_SEMANTIC_NEUTRAL_COMMANDS：纯输出/状态，不影响管道性质。 */
const SEMANTIC_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

/** claude-code BASH_SILENT_COMMANDS：正常时没有 stdout 的副作用命令，判定时跳过。 */
const SILENT_COMMANDS = new Set([
	"mv",
	"cp",
	"rm",
	"mkdir",
	"rmdir",
	"chmod",
	"chown",
	"chgrp",
	"touch",
	"ln",
	"cd",
	"export",
	"unset",
	"wait",
]);

/** 构建 / 测试类命令：失败输出信号密度高。 */
const BUILD_COMMANDS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"cargo",
	"go",
	"make",
	"pytest",
	"jest",
	"vitest",
	"mvn",
	"mvnw",
	"gradle",
	"gradlew",
	"dotnet",
	"tsc",
	"eslint",
	"biome",
	"ruff",
	"cmake",
	"ninja",
	"bazel",
	"swift",
	"xcodebuild",
]);

/** 单个命令段（已剥掉包装器与重定向）的类别。 */
type SegmentKind = "search" | "read" | "build" | "other";

/** git 全局选项中需要独立消费一个值的选项。 */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

/** 找到 git 全局选项之后的真实子命令。 */
function gitSubcommand(tokens: string[]): string | undefined {
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") return tokens[i + 1];
		if (token.startsWith("-")) {
			if (!token.includes("=") && GIT_GLOBAL_VALUE_FLAGS.has(token)) i++;
			continue;
		}
		return token;
	}
	return undefined;
}

/** 判断一个命令段属于哪一类；白名单之外一律 `other`。 */
function segmentKind(tokens: string[]): SegmentKind {
	const base = basename(tokens[0] ?? "");
	if (SEARCH_COMMANDS.has(base)) return "search";
	if (READ_COMMANDS.has(base)) return "read";
	if (BUILD_COMMANDS.has(base)) return "build";
	// `git log` 无界时是典型过程噪声；`git diff` / `git status` 的输出更可能是载荷。
	if (base === "git" && gitSubcommand(tokens) === "log") return "search";
	return "other";
}

/**
 * 把命令归为 `exhaust` / `build-test` / `unknown`。判定顺序：
 *
 * 1. 没有任何非中性命令（例如只有 `echo`）→ `unknown`；
 * 2. 出现白名单之外的命令段 → `unknown`；
 * 3. 全是构建 / 测试命令 → `build-test`；
 * 4. 含搜索 / 列举类、且不含构建类 → `exhaust`
 *    （读文件类与之组合时也算，例如 `cat x | rg y`）；
 * 5. 其余（例如只有 `cat`）→ `unknown`。
 */
export function classifyCommand(command: string): CommandClass {
	const kinds: SegmentKind[] = [];
	for (const segment of splitSegments(command)) {
		const raw = tokenizeSegment(stripRedirections(segment));
		const stripped = stripWrappers(raw);
		// `env` / `xargs` 等既是包装器又是命令：剥完为空时退回原始 token，
		// 避免把单独一条 `env`（环境转储）误当成空段。
		const tokens = stripped.length > 0 ? stripped : raw;
		if (tokens.length === 0) continue;
		const base = basename(tokens[0]);
		if (SEMANTIC_NEUTRAL_COMMANDS.has(base) || SILENT_COMMANDS.has(base)) continue;
		kinds.push(segmentKind(tokens));
	}

	if (kinds.length === 0) return "unknown";
	if (kinds.includes("other")) return "unknown";

	const hasSearch = kinds.includes("search");
	const hasRead = kinds.includes("read");
	const hasBuild = kinds.includes("build");

	if (hasBuild && !hasSearch && !hasRead) return "build-test";
	if (hasSearch && !hasBuild) return "exhaust";
	return "unknown";
}
