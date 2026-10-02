/**
 * pi-extension-bash-guard
 *
 * 三件事：
 * 1. 会话开局注入一次 `[BASH OUTPUT DISCIPLINE]`，让模型主动写出有界输出。
 * 2. `tool_call` 阶段：拦截根目录为 `$HOME`/`/`/系统目录（`/etc` 等）的 find/grep/rg；
 *    并给搜索类命令注入 5 分钟超时上限（缺 `timeout` 或超过 300 秒都压到 300）。
 * 3. `tool_result` 阶段拦截 bash/powershell 的大输出，替换成
 *    「少量核心行 + 全文落盘路径 + 针对性重写建议」，逼模型重写命令。
 *
 * 设计约束（与 plan-mode 一致）：不修改 systemPrompt、不动工具集、不注册 `context`
 * 处理器——content 替换是历史尾部 append-only 的一次性结果，零 prompt-cache 重建。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessOutput, describeLimit } from "./analyze";
import { classifyCommand } from "./classify";
import { CONFIG_CUSTOM_TYPE, type GuardConfig, loadEnvConfig, parseCommandArgs, readPersistedConfig } from "./config";
import { buildGuardMessage } from "./guard-message";
import { detectBlockedScan } from "./scan-guard";
import { isSearchCommand, SEARCH_TIMEOUT_SECONDS, searchTimeoutInjection } from "./timeout-guard";

/** 状态栏 key。 */
const STATUS_KEY = "bash-guard";
/** 开局纪律消息与配置持久化的 customType。 */
const FRAMING_CUSTOM_TYPE = "bash-guard-framing";
/** 被 guard 的工具。 */
const GUARDED_TOOLS = new Set(["bash", "powershell"]);
/** 已拦截命令集合的上限，超过则清空，避免无限增长。 */
const MAX_TRACKED_COMMANDS = 200;
/** pi bash 超时错误的标志（如 `Command timed out after 600 seconds`）。 */
const TIMEOUT_SIGNAL = /timed out after \d+ seconds/i;
/**
 * 命中 timeout 且输出很小（未触发尺寸拦截）时追加的引导。
 *
 * 只对搜索命令使用：只有搜索类命令会被本插件静默封顶到 300s，模型看不到这次改写；
 * 其他命令的超时来自模型/用户显式设置的 `timeout`，pi 的原始报错已足够，无需打扰。
 */
const TIMEOUT_HINT =
	"[BASH TIMEOUT GUARD] Search commands are capped at 300s by bash-guard. Raising the timeout past 300s won't help — the cap is re-applied " +
	"(a smaller explicit timeout is honored). This scan was killed mid-run, so its results may be incomplete. Narrow it instead: " +
	"`rg -l <pattern> <dir>` with `-g '!**/node_modules/**'` exclusions (a trailing `| grep -v dir` still reads every file), or use `mdfind -name`.";

/** 归一化命令用于「同一命令重复触发」判定。 */
export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/** 开局注入的输出纪律文案。 */
export function buildDisciplineText(cfg: GuardConfig): string {
	const exhaustLimit = describeLimit({ maxBytes: cfg.maxBytes });
	const payloadLimit = describeLimit({ maxBytes: cfg.payloadMaxBytes });
	const timeoutLine =
		"Search commands (`find`, recursive `grep`, `rg`, `du`, `tree`) are capped at 5 minutes (300 seconds) automatically; " +
		"scans rooted at `$HOME`, `/`, or a system directory like `/etc` are blocked before they run. " +
		"Everything else runs with no timeout guard — pass an explicit `timeout` for anything that can hang (log follow, foreground servers).";
	return [
		"[BASH OUTPUT DISCIPLINE]",
		`An extension guards shell output. Search/listing/dump commands (e.g. \`rg\`, recursive \`grep\`, \`find\`, \`ls -R\`, ` +
			`\`env\`, \`ps\`, \`git log\`) are capped at ${exhaustLimit}; other commands are capped at ${payloadLimit}. ` +
			"Above the cap, the result is replaced with a short preview, the error/warning lines, and a path to the full output. " +
			"Guarded results are marked `[BASH OUTPUT GUARD]`. Treat it as a nudge to rewrite the command, or to read the file, not as a failure.",
		"",
		"Bound output before you run:",
		"- Content search: use the `grep` tool (`limit` caps matches; it respects .gitignore). In bash, `rg -l` lists matching files only, `-c` counts per file, `-m 5` caps matches per file. Never scan a huge tree unbounded.",
		"- Read files: use the `read` tool with offset/limit. For spot checks use `sed -n '1,80p' <file>` or `head -n 80 <file>` — not `cat`.",
		"- Logs/lists: `tail -n 50`, `git log --oneline -n 20`, `git diff --stat`, `ls | head`.",
		"- Aggregate first: `| wc -l`, `| sort | uniq -c`, `-q`/`--quiet`/`-s`. Write big output to a file, then read/grep it selectively.",
		"",
		timeoutLine,
	].join("\n");
}

interface OutputTruncation {
	truncated?: boolean;
	totalLines?: number;
	totalBytes?: number;
}

interface OutputDetails {
	truncation?: OutputTruncation;
	fullOutputPath?: string;
}

interface TempStorage {
	dir?: string;
	dirPromise?: Promise<string>;
	nextFile: number;
}

/** 复用内建截断时落盘的完整输出；否则把当前文本写到本插件自己的临时文件。 */
async function resolveFullOutputPath(
	text: string,
	details: OutputDetails | undefined,
	builtinTruncated: boolean,
	tempDirs: Set<string>,
	storage: TempStorage,
): Promise<string> {
	if (builtinTruncated && details?.fullOutputPath) return details.fullOutputPath;
	try {
		if (!storage.dir) {
			if (!storage.dirPromise) {
				storage.dirPromise = mkdtemp(join(tmpdir(), "pi-bash-guard-")).then((dir) => {
					storage.dir = dir;
					tempDirs.add(dir);
					return dir;
				});
			}
			await storage.dirPromise;
		}
		const file = join(storage.dir as string, `output-${storage.nextFile++}.txt`);
		await writeFile(file, text, "utf8");
		return file;
	} catch {
		return details?.fullOutputPath ?? "(temporary file unavailable)";
	}
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	let cfg = loadEnvConfig();
	let hitCount = 0;
	let exhaustHits = 0;
	let framingDelivered = false;
	let escalationWarningDelivered = false;
	const guardedCommands = new Set<string>();
	const tempDirs = new Set<string>();
	const tempStorage: TempStorage = { nextFile: 0 };

	function persistConfig(): void {
		try {
			pi.appendEntry(CONFIG_CUSTOM_TYPE, { ...cfg });
		} catch {
			// 持久化失败不致命：本进程内配置仍正确，仅 resume 后丢失
		}
	}

	function updateStatus(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		try {
			if (!cfg.enabled) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, hitCount > 0 ? `🛡 bash-guard ×${hitCount}` : "🛡 bash-guard");
		} catch {
			// print 模式等无 UI 环境：忽略
		}
	}

	// ── 会话恢复：重放配置与 framing 闩锁，重置统计 ─────────────────
	pi.on("session_start", (_event, ctx) => {
		hitCount = 0;
		exhaustHits = 0;
		framingDelivered = false;
		escalationWarningDelivered = false;
		tempStorage.dir = undefined;
		tempStorage.dirPromise = undefined;
		tempStorage.nextFile = 0;
		guardedCommands.clear();
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		const persisted = readPersistedConfig(branch);
		cfg = persisted ?? loadEnvConfig();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
			if (entry?.type === "custom" && entry.customType === FRAMING_CUSTOM_TYPE) {
				framingDelivered = (entry.data as { delivered?: boolean } | undefined)?.delivered === true;
				break;
			}
		}
		updateStatus(ctx);
	});

	// ── 开局软提示：只注入一次，缓存安全 ───────────────────────────
	pi.on("before_agent_start", () => {
		if (!cfg.enabled || framingDelivered) return;
		framingDelivered = true;
		try {
			pi.appendEntry(FRAMING_CUSTOM_TYPE, { delivered: true });
		} catch {
			// 忽略：下次 resume 会重新注入一次纪律说明，无害
		}
		return {
			message: {
				customType: FRAMING_CUSTOM_TYPE,
				content: buildDisciplineText(cfg),
				display: false,
			},
		};
	});

	// Compaction 可能裁掉早先注入的 custom message；下一次 agent run 时重新注入。
	pi.on("session_compact", () => {
		framingDelivered = false;
	});

	// ── 事前拦截：根目录为 $HOME、/ 或系统目录的无界扫描 ───────────
	pi.on("tool_call", (event, ctx) => {
		if (!cfg.enabled) return;
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const input = event.input as { command?: unknown; timeout?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";
		if (command === "") return;

		if (cfg.scanBlock) {
			const hit = detectBlockedScan(command, { home: homedir() });
			if (hit) {
				try {
					ctx.ui.notify(`Blocked unbounded scan: ${hit.tool} → ${hit.root}`, "warning");
				} catch {
					// 无 UI 环境：忽略
				}
				return { block: true, reason: hit.reason };
			}
		}

		// 搜索命令封顶 5 分钟：pi 的 `tool_call` input 可变，原地改写 `timeout`。
		// 缺 `timeout` 或超过 300 秒都压到 300；模型给了更小的值则保留。
		const injection = searchTimeoutInjection(command, input ?? {});
		if (injection !== null && input) {
			const had = typeof input.timeout === "number" ? input.timeout : undefined;
			input.timeout = injection;
			if (had !== undefined && had > SEARCH_TIMEOUT_SECONDS) {
				try {
					ctx.ui.notify(`Capped search timeout ${had}s → ${injection}s`, "warning");
				} catch {
					// 无 UI 环境：忽略
				}
			}
		}
		return;
	});

	// ── 超阈值硬拦截 ───────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled) return;
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const textParts = event.content.filter((part) => part.type === "text");
		if (textParts.length === 0) return;
		const text = textParts.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		const input = event.input as { command?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";

		const commandClass = classifyCommand(command);
		// 过程输出用紧阈值（maxBytes），其余按高价值载荷用宽阈值（payloadMaxBytes）。
		// 两档各自独立：任一为 0 表示该档不限制字节；总开关是 `cfg.enabled`。
		const effectiveLimit = commandClass === "exhaust" ? cfg.maxBytes : cfg.payloadMaxBytes;
		const details = event.details as OutputDetails | undefined;
		const truncation = details?.truncation;
		const builtinTruncated = truncation?.truncated === true;
		const measuredAssessment = assessOutput(text, { maxBytes: effectiveLimit });
		const assessment =
			builtinTruncated && typeof truncation.totalLines === "number" && typeof truncation.totalBytes === "number"
				? {
						...measuredAssessment,
						exceeded: effectiveLimit > 0 && truncation.totalBytes > effectiveLimit,
						totalLines: truncation.totalLines,
						totalBytes: truncation.totalBytes,
					}
				: measuredAssessment;
		if (!assessment.exceeded) {
			// 超时错误通常输出很小，阈值拦不到。只有搜索命令会被本插件静默封顶到 300s，
			// 模型看不到这次改写，才有必要补一句引导；其他命令的超时来自模型/用户显式
			// 设置的 `timeout`，pi 的原始报错已足够，不打扰。
			if (event.isError && TIMEOUT_SIGNAL.test(text) && isSearchCommand(command)) {
				return { content: [{ type: "text" as const, text: `${text}\n\n${TIMEOUT_HINT}` }] };
			}
			return;
		}

		const fullPath = await resolveFullOutputPath(text, details, builtinTruncated, tempDirs, tempStorage);

		// 只有「过程输出」参与重复提示与升级警告；高价值载荷被反复读取是合理的。
		let repeatCommand = false;
		let showEscalationWarning = false;
		if (commandClass === "exhaust") {
			const normalized = normalizeCommand(command);
			repeatCommand = normalized !== "" && guardedCommands.has(normalized);
			if (normalized !== "") {
				if (guardedCommands.size >= MAX_TRACKED_COMMANDS) guardedCommands.clear();
				guardedCommands.add(normalized);
			}
			exhaustHits++;
			showEscalationWarning = exhaustHits >= 3 && !escalationWarningDelivered;
			if (showEscalationWarning) escalationWarningDelivered = true;
		}
		hitCount++;
		updateStatus(ctx);

		const guardText = buildGuardMessage({
			text,
			assessment,
			command,
			commandClass,
			fullPath,
			builtinTruncated,
			isError: event.isError,
			cfg,
			escalationCount: exhaustHits,
			showEscalationWarning,
			repeatCommand,
		});

		return { content: [{ type: "text" as const, text: guardText }] };
	});

	// ── /bash-guard 配置命令 ───────────────────────────────────────
	pi.registerCommand("bash-guard", {
		description:
			"Toggle or configure the bash output guard (on | off | status | scan <on|off> | bytes <n> | payload <n> | preview <head> [tail])",
		handler: async (args, ctx) => {
			const result = parseCommandArgs(args, cfg);
			if (result.kind === "error") {
				ctx.ui.notify(result.message, "error");
				return;
			}
			if (result.kind === "status") {
				ctx.ui.notify(
					`bash-guard: ${cfg.enabled ? "on" : "off"}; exhaust limit ${describeLimit({ maxBytes: cfg.maxBytes })}; ` +
						`payload ${describeLimit({ maxBytes: cfg.payloadMaxBytes })}; scan-block ${cfg.scanBlock ? "on" : "off"}; ` +
						`preview head ${cfg.previewHead} / tail ${cfg.previewTail} (errors ${cfg.errorPreviewTail}); hits ${hitCount}`,
					"info",
				);
				return;
			}
			cfg = result.config;
			persistConfig();
			updateStatus(ctx);
			ctx.ui.notify(
				cfg.enabled
					? `bash-guard on: exhaust ${describeLimit({ maxBytes: cfg.maxBytes })} / payload ${describeLimit({ maxBytes: cfg.payloadMaxBytes })}`
					: "bash-guard off",
				"info",
			);
		},
	});

	// ── 清理本插件创建的临时目录 ───────────────────────────────────
	pi.on("session_shutdown", async () => {
		const dirs = [...tempDirs];
		tempDirs.clear();
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
	});
}
