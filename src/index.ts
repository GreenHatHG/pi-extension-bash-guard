/**
 * pi-extension-bash-guard
 *
 * 两件事：
 * 1. 会话开局注入一次 `[BASH OUTPUT DISCIPLINE]`，让模型主动写出有界输出。
 * 2. `tool_result` 阶段拦截 bash/powershell 的大输出，替换成
 *    「少量核心行 + 全文落盘路径 + 针对性重写建议」，逼模型重写命令。
 *
 * 设计约束（与 plan-mode 一致）：不修改 systemPrompt、不动工具集、不注册 `context`
 * 处理器——content 替换是历史尾部 append-only 的一次性结果，零 prompt-cache 重建。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessOutput, describeLimit } from "./analyze";
import { CONFIG_CUSTOM_TYPE, type GuardConfig, loadEnvConfig, parseCommandArgs, readPersistedConfig } from "./config";
import { buildGuardMessage } from "./guard-message";

/** 状态栏 key。 */
const STATUS_KEY = "bash-guard";
/** 开局纪律消息与配置持久化的 customType。 */
const FRAMING_CUSTOM_TYPE = "bash-guard-framing";
/** 被 guard 的工具。 */
const GUARDED_TOOLS = new Set(["bash", "powershell"]);
/** 已拦截命令集合的上限，超过则清空，避免无限增长。 */
const MAX_TRACKED_COMMANDS = 200;

/** 归一化命令用于「同一命令重复触发」判定。 */
export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/** 开局注入的输出纪律文案。 */
export function buildDisciplineText(cfg: GuardConfig): string {
	const limit = describeLimit(cfg);
	return [
		"[BASH OUTPUT DISCIPLINE]",
		`An extension guards shell output. Any bash/powershell result above ${limit} is replaced with a short preview, ` +
			"the error/warning lines, and a path to the full output. Treat that as a nudge to rewrite the command, not as a failure.",
		"",
		"Bound output before you run:",
		"- Search: prefer the grep/find tools, or use `rg -n -m 5 <pattern> <path>`, `rg -l` (files only), `rg -c` (counts). Never scan a huge tree unbounded.",
		"- Read files: use the `read` tool with offset/limit. For spot checks use `sed -n '1,80p' <file>` or `head -n 80 <file>` — not `cat`.",
		"- Logs/lists: `tail -n 50`, `git log --oneline -n 20`, `git diff --stat`, `ls | head`.",
		"- Aggregate first: `| wc -l`, `| sort | uniq -c`, `-q`/`--quiet`/`-s`. Write big output to a file, then read/grep it selectively.",
		"",
		"When a result starts with `[BASH OUTPUT GUARD]`: do NOT re-run the same command and do NOT pipe it to `less`/`more`. " +
			"Rewrite it with tighter filters, or query the saved full-output file with the `read` tool (offset/limit) or `rg`/`sed`.",
	].join("\n");
}

interface OutputDetails {
	truncation?: unknown;
	fullOutputPath?: string;
}

/** 复用内建截断时落盘的完整输出；否则把当前文本写到本插件自己的临时文件。 */
async function resolveFullOutputPath(
	text: string,
	details: OutputDetails | undefined,
	builtinTruncated: boolean,
	tempDirs: Set<string>,
): Promise<string> {
	if (builtinTruncated && details?.fullOutputPath) return details.fullOutputPath;
	try {
		const dir = await mkdtemp(join(tmpdir(), "pi-bash-guard-"));
		tempDirs.add(dir);
		const file = join(dir, "output.txt");
		await writeFile(file, text, "utf8");
		return file;
	} catch {
		return details?.fullOutputPath ?? "(temporary file unavailable)";
	}
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	let cfg = loadEnvConfig();
	let hitCount = 0;
	let framingDelivered = false;
	const guardedCommands = new Set<string>();
	const tempDirs = new Set<string>();

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
		framingDelivered = false;
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

	// ── 超阈值硬拦截 ───────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled) return;
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const textParts = event.content.filter((part) => part.type === "text");
		if (textParts.length === 0) return;
		const text = textParts.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		const assessment = assessOutput(text, cfg);
		if (!assessment.exceeded) return;

		const input = event.input as { command?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";
		const details = event.details as OutputDetails | undefined;
		const builtinTruncated = Boolean(details?.truncation);

		const fullPath = await resolveFullOutputPath(text, details, builtinTruncated, tempDirs);

		const normalized = normalizeCommand(command);
		const repeatCommand = normalized !== "" && guardedCommands.has(normalized);
		if (normalized !== "") {
			if (guardedCommands.size >= MAX_TRACKED_COMMANDS) guardedCommands.clear();
			guardedCommands.add(normalized);
		}
		hitCount++;
		updateStatus(ctx);

		const guardText = buildGuardMessage({
			text,
			assessment,
			command,
			fullPath,
			builtinTruncated,
			isError: event.isError,
			cfg,
			hitCount,
			repeatCommand,
		});

		return { content: [{ type: "text" as const, text: guardText }] };
	});

	// ── /bash-guard 配置命令 ───────────────────────────────────────
	pi.registerCommand("bash-guard", {
		description: "Toggle or configure the bash output guard (on | off | status | bytes <n> | preview <head> [tail])",
		handler: async (args, ctx) => {
			const result = parseCommandArgs(args, cfg);
			if (result.kind === "error") {
				ctx.ui.notify(result.message, "error");
				return;
			}
			if (result.kind === "status") {
				ctx.ui.notify(
					`bash-guard: ${cfg.enabled ? "on" : "off"}; limit ${describeLimit(cfg)}; ` +
						`preview head ${cfg.previewHead} / tail ${cfg.previewTail} (errors ${cfg.errorPreviewTail}); hits ${hitCount}`,
					"info",
				);
				return;
			}
			cfg = result.config;
			persistConfig();
			updateStatus(ctx);
			ctx.ui.notify(cfg.enabled ? `bash-guard on: limit ${describeLimit(cfg)}` : "bash-guard off", "info");
		},
	});

	// ── 清理本插件创建的临时目录 ───────────────────────────────────
	pi.on("session_shutdown", async () => {
		const dirs = [...tempDirs];
		tempDirs.clear();
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
	});
}
