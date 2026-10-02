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
/** guard 文本的最大字节上限；实际预算还会受当前输出档位限制。 */
const MAX_MESSAGE_BYTES = 12 * 1024;

/** 按 UTF-8 字节截取，避免 UTF-16 slice 切断 surrogate pair。 */
function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

	let bytes = 0;
	let end = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		end += character.length;
	}
	return text.slice(0, end);
}

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
	/** 是否应在本条消息中发出一次性升级警告。 */
	showEscalationWarning?: boolean;
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
		showEscalationWarning = false,
		repeatCommand,
	} = input;

	const isExhaust = commandClass === "exhaust";
	const effectiveLimit = isExhaust ? cfg.maxBytes : cfg.payloadMaxBytes;

	const cleaned = stripBuiltinFooter(text);
	const preview = buildPreview(cleaned, cfg.previewHead, isError ? cfg.errorPreviewTail : cfg.previewTail);
	const displayedPreviewLines = preview.headLines.length + preview.tailLines.length;
	const omittedLines = builtinTruncated
		? Math.max(preview.omittedLines, assessment.totalLines - displayedPreviewLines)
		: preview.omittedLines;
	const previewLineKeys = new Set([...preview.headLines, ...preview.tailLines].map((line) => line.trim()));
	const allSignalLines = extractSignalLines(cleaned, SIGNAL_LINE_LIMIT);
	const signalLines = allSignalLines.filter((line) => !previewLineKeys.has(line.trim()));

	const parts: string[] = [];

	if (isExhaust) {
		parts.push(
			`[BASH OUTPUT GUARD] Output withheld: ${assessment.totalLines} lines / ${formatBytes(assessment.totalBytes)} ` +
				`(limit ${describeLimit({ maxBytes: effectiveLimit })}).`,
		);
	} else if (commandClass === "build-test") {
		parts.push(
			`[BASH OUTPUT GUARD] Build/test result saved to disk: ${assessment.totalLines} lines / ` +
				`${formatBytes(assessment.totalBytes)} (inline limit ${describeLimit({ maxBytes: effectiveLimit })}).`,
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

	const hasTail = preview.tailLines.length > 0 && omittedLines > 0;
	if (hasTail) {
		parts.push(`Preview — first ${preview.headLines.length} lines:`);
		parts.push(...renderCollapsed(collapseRepeats(preview.headLines), "  "));
		parts.push(`  ... [${omittedLines} lines omitted] ...`);
		parts.push(`Preview — last ${preview.tailLines.length} lines:`);
		parts.push(...renderCollapsed(collapseRepeats(preview.tailLines), "  "));
	} else {
		parts.push("Preview:");
		parts.push(...renderCollapsed(collapseRepeats(preview.headLines), "  "));
		if (omittedLines > 0) parts.push(`  ... [${omittedLines} lines omitted] ...`);
	}

	if (signalLines.length > 0) {
		parts.push("Error/warning lines:");
		parts.push(...signalLines.map((line) => `  ${clipLine(line)}`));
	} else if (allSignalLines.length > 0) {
		parts.push("Error/warning lines:");
		parts.push("  (already shown in the preview above)");
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
		if (showEscalationWarning && escalationCount >= 3) {
			parts.push("");
			parts.push(`The guard has now fired ${escalationCount} times this session — stop issuing unbounded commands.`);
		}
	} else if (commandClass === "build-test") {
		parts.push("");
		parts.push(
			"This is build/test output, so the wider payload limit was used. The complete result is in the file above; " +
				"read only the relevant error or test sections instead of re-running the command.",
		);
	} else {
		parts.push("");
		parts.push(
			"This looks like the content you asked for, so it was capped at the wider payload limit rather than the " +
				"process-output limit. The full output is in the file above; read only the parts you need, and do not " +
				"re-run the command.",
		);
	}

	let message = parts.join("\n");
	const messageBudget = effectiveLimit > 0 ? Math.min(MAX_MESSAGE_BYTES, effectiveLimit) : MAX_MESSAGE_BYTES;
	if (Buffer.byteLength(message, "utf8") > messageBudget) {
		const marker = "\n… [guard message truncated]";
		const markerBytes = Buffer.byteLength(marker, "utf8");
		if (messageBudget <= markerBytes) {
			message = truncateUtf8(marker, messageBudget);
		} else {
			message = `${truncateUtf8(message, messageBudget - markerBytes)}${marker}`;
		}
	}
	return message;
}
