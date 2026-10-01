/**
 * 组装最终返回给模型的 guard 文本。
 *
 * 目标不是「把输出截断」，而是「让模型用对的方式拿到它需要的信息」：
 *
 * - `exhaust`（搜索/列举/转储这类过程输出）：给少量核心行、给全文路径、
 *   给针对原命令的具体改写建议，并明确禁止重复原命令 / 改用 less。
 * - 其他（高价值载荷）：内容很可能就是模型要的答案，所以**不说教**，
 *   只给「全文在哪、怎么按需取」的指引，避免逼它走「落盘 + 分段读」的绕路。
 */

import {
	type Assessment,
	buildPreview,
	type CollapsedLine,
	collapseRepeats,
	describeLimit,
	extractSignalLines,
	formatBytes,
	stripBuiltinFooter,
} from "./analyze";
import type { CommandClass } from "./classify";
import type { GuardConfig } from "./config";
import { suggestRewrites } from "./suggest";

/** 信号行最多展示条数。 */
const SIGNAL_LINE_LIMIT = 15;
/** 单行最大字符数，防止把「一行刷屏」的超长行原样带回。 */
const MAX_LINE_CHARS = 400;
/** guard 文本的字节上限，兜底防御。 */
const MAX_MESSAGE_BYTES = 12 * 1024;

export interface GuardMessageInput {
	/** 工具返回的原始文本。 */
	text: string;
	assessment: Assessment;
	/** 原始命令。 */
	command: string;
	/** 命令归类，决定用紧阈值说教还是宽阈值给取回指引。 */
	commandClass: CommandClass;
	/** 全文落盘路径（复用内建或本插件自建）。 */
	fullPath: string;
	/** 内建 bash 工具在本次调用中是否已经触发过截断。 */
	builtinTruncated: boolean;
	isError: boolean;
	cfg: GuardConfig;
	/** 本会话中「过程输出」类被拦截的累计次数（1-based）；仅该类参与升级警告。 */
	escalationCount: number;
	/** 归一化后的同一命令之前是否已被拦截过。 */
	repeatCommand: boolean;
}

/** 截断超长单行，追加省略标记。 */
export function clipLine(line: string, max = MAX_LINE_CHARS): string {
	if (line.length <= max) return line;
	return `${line.slice(0, max)}… [+${line.length - max} chars]`;
}

function renderCollapsed(lines: CollapsedLine[], indent: string): string[] {
	return lines.map(({ line, count }) => `${indent}${clipLine(line)}${count > 1 ? `  (×${count})` : ""}`);
}

/** 组装 guard 文本。纯函数，便于单测。 */
export function buildGuardMessage(input: GuardMessageInput): string {
	const {
		text,
		assessment,
		command,
		commandClass,
		fullPath,
		builtinTruncated,
		isError,
		cfg,
		escalationCount,
		repeatCommand,
	} = input;

	const isExhaust = commandClass === "exhaust";
	const effectiveLimit = isExhaust ? cfg.maxBytes : cfg.payloadMaxBytes;

	const cleaned = stripBuiltinFooter(text);
	const preview = buildPreview(cleaned, cfg.previewHead, isError ? cfg.errorPreviewTail : cfg.previewTail);
	const signalLines = extractSignalLines(cleaned, SIGNAL_LINE_LIMIT);

	const parts: string[] = [];

	if (isExhaust) {
		parts.push(
			`[BASH OUTPUT GUARD] Output withheld: ${assessment.totalLines} lines / ${formatBytes(assessment.totalBytes)} ` +
				`(limit ${describeLimit({ maxBytes: effectiveLimit })}).`,
		);
	} else {
		parts.push(
			`[BASH OUTPUT GUARD] Large result saved to disk: ${assessment.totalLines} lines / ` +
				`${formatBytes(assessment.totalBytes)} (inline limit ${describeLimit({ maxBytes: effectiveLimit })}).`,
		);
	}

	if (isError) {
		parts.push("Command failed (non-zero exit) — the error tail is preserved below.");
	}

	const hasTail = preview.tailLines.length > 0 && preview.omittedLines > 0;
	if (hasTail) {
		parts.push(`Preview — first ${preview.headLines.length} lines:`);
		parts.push(...renderCollapsed(collapseRepeats(preview.headLines), "  "));
		parts.push(`  ... [${preview.omittedLines} lines omitted] ...`);
		parts.push(`Preview — last ${preview.tailLines.length} lines:`);
		parts.push(...renderCollapsed(collapseRepeats(preview.tailLines), "  "));
	} else {
		parts.push("Preview:");
		parts.push(...renderCollapsed(collapseRepeats(preview.headLines), "  "));
	}

	if (signalLines.length > 0) {
		parts.push("Error/warning lines:");
		parts.push(...signalLines.map((line) => `  ${clipLine(line)}`));
	}

	parts.push(`Full output saved to: ${fullPath}`);
	if (builtinTruncated) {
		parts.push("Note: pi's built-in output cap was already hit; the file above holds the complete command output.");
	}
	parts.push(
		`Read it selectively: the \`read\` tool with offset/limit, or the \`grep\` tool pointed at this file ` +
			`(or \`rg <pattern> ${fullPath}\`).`,
	);

	if (isExhaust) {
		parts.push("");
		parts.push(
			"Rewrite the command instead of repeating it. Do NOT re-run the same command, and do NOT just pipe it to " +
				"`less`/`more`. Suggestions:",
		);
		for (const hint of suggestRewrites(command)) {
			parts.push(`  - ${hint}`);
		}

		if (repeatCommand) {
			parts.push("");
			parts.push("You already ran this exact command and it was guarded. Repeating it will not help.");
		}
		if (escalationCount >= 3) {
			parts.push("");
			parts.push(`The guard has now fired ${escalationCount} times this session — stop issuing unbounded commands.`);
		}
	} else {
		parts.push("");
		parts.push(
			"This looks like the content you asked for, so it was capped at the wider payload limit rather than the " +
				"process-output limit. The full output is in the file above; read only the parts you need, and do not " +
				"re-run the command.",
		);
	}

	let message = parts.join("\n");
	if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
		message = `${message.slice(0, MAX_MESSAGE_BYTES)}\n… [guard message truncated]`;
	}
	return message;
}
