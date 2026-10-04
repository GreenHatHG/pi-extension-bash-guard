/**
 * Pure helper: sort a shell command into one of three buckets, which picks the byte limit and the tone.
 *
 * It's a strict allowlist: `exhaust` only if every part (after dropping neutral commands) is a known
 * "process output" command. One part we can't parse, or a command off the list, drops it to
 * `unknown` (treated as valuable payload). So a wrong call still leans toward giving the model more,
 * never swallowing what it needs.
 *
 * - `exhaust`: listing / search / env dump / history. Usually process noise, so tight `maxBytes`,
 *   plus rewrite hints and repeat/escalation warnings.
 * - `build-test`: build / test commands. Failures are error-dense, so wide `payloadMaxBytes`,
 *   and keep error lines and the tail.
 * - `unknown`: everything else (including file reads like `cat`/`sed`). Might be the payload the
 *   model wants, so wide limit, no lecturing, no escalation count.
 */

import { basename, splitSegments, stripRedirections, stripWrappers, tokenizeSegment } from "./scan-guard";

/** Command bucket. */
export type CommandClass = "exhaust" | "build-test" | "unknown";

/**
 * Command lists come from claude-code BashTool (BASH_SEARCH_COMMANDS / BASH_READ_COMMANDS /
 * BASH_LIST_COMMANDS / BASH_SEMANTIC_NEUTRAL_COMMANDS / BASH_SILENT_COMMANDS), with extras for us.
 * There it only decides if the UI folds output; here it decides the byte limit.
 */

/** Search / list commands: hits or match lines, classic process output. */
const SEARCH_COMMANDS = new Set([
	"find",
	"grep",
	"rg",
	"ag",
	"ack",
	"locate",
	"which",
	"whereis",
	// listing is process output too
	"ls",
	"tree",
	"du",
	// common aliases, modern swaps, env and process dumps
	"egrep",
	"fgrep",
	"fd",
	"env",
	"printenv",
	"ps",
]);

/** File read / convert commands: content is likely the payload the model wants, so keep them out of `exhaust`. */
const READ_COMMANDS = new Set([
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
	"sed",
	"bat",
	"nl",
]);

/** Pure output / status commands; they don't change how a pipeline behaves. */
const SEMANTIC_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

/** Side-effect commands with no stdout in normal runs; skip them when classifying. */
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

/** Build / test commands: failures carry dense error signals. */
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

/** Kind of one command segment (wrappers and redirections already stripped). */
type SegmentKind = "search" | "read" | "build" | "other";

/** git global flags that eat the next token as their value. */
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

/** Find the real subcommand after git's global flags. */
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

/** Bucket one command segment; anything off the list is `other`. */
function segmentKind(tokens: string[]): SegmentKind {
	const base = basename(tokens[0] ?? "");
	if (SEARCH_COMMANDS.has(base)) return "search";
	if (READ_COMMANDS.has(base)) return "read";
	if (BUILD_COMMANDS.has(base)) return "build";
	// unbounded `git log` is process noise; `git diff` / `git status` output is more likely the payload.
	if (base === "git" && gitSubcommand(tokens) === "log") return "search";
	return "other";
}

/**
 * Sort a command into `exhaust` / `build-test` / `unknown`. Order: no real command, or a segment
 * off the list → `unknown`; all build/test → `build-test`; has search/list and no build →
 * `exhaust` (read commands combined count too, e.g. `cat x | rg y`); the rest (e.g. only `cat`) → `unknown`.
 */
export function classifyCommand(command: string): CommandClass {
	const kinds: SegmentKind[] = [];
	for (const segment of splitSegments(command)) {
		const raw = tokenizeSegment(stripRedirections(segment));
		const stripped = stripWrappers(raw);
		// `env` / `xargs` are both wrapper and command: fall back to raw tokens when stripping
		// leaves nothing, so a lone `env` dump isn't treated as an empty segment.
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
