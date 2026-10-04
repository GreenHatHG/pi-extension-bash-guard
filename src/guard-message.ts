/**
 * Build the guard text that goes back to the model.
 *
 * The goal isn't to cut output, it's to get the model the info it needs in the right way:
 *
 * - `exhaust` (process output like search/list/dump): a few key lines, the full-file path, rewrite
 *   hints for the original command, and a clear "don't repeat it or pipe it to less".
 * - everything else (valuable payload): likely the answer itself, so no lecturing — just where the
 *   full output is and how to pull only what's needed, so it isn't forced into "save + read in slices".
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

/** Max signal lines to show. */
const SIGNAL_LINE_LIMIT = 15;
/** Max chars per line, so one giant line can't flood the screen. */
const MAX_LINE_CHARS = 400;
/** Max bytes for the guard text; the real budget is also capped by the current output tier. */
const MAX_MESSAGE_BYTES = 12 * 1024;

/** Cut by UTF-8 bytes so a UTF-16 slice can't split a surrogate pair. */
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
	text: string;
	assessment: Assessment;
	/** The original command. */
	command: string;
	/** Command bucket: picks tight-limit lecturing or wide-limit retrieval hints. */
	commandClass: CommandClass;
	/** Full-output path on disk (reused built-in truncation file, or one we made). */
	fullPath: string;
	/** Whether the built-in bash tool already truncated this call. */
	builtinTruncated: boolean;
	isError: boolean;
	cfg: GuardConfig;
	/** Running count of process-output interceptions this session (1-based); only this class triggers escalation. */
	escalationCount: number;
	/** Whether to emit the one-time escalation warning in this message. */
	showEscalationWarning?: boolean;
	/** Whether this same normalized command was already intercepted before. */
	repeatCommand: boolean;
}

/** Trim an over-long line and add an ellipsis marker. */
export function clipLine(line: string, max = MAX_LINE_CHARS): string {
	if (line.length <= max) return line;
	return `${line.slice(0, max)}… [+${line.length - max} chars]`;
}

function renderCollapsed(lines: CollapsedLine[], indent: string): string[] {
	return lines.map(({ line, count }) => `${indent}${clipLine(line)}${count > 1 ? `  (×${count})` : ""}`);
}

/** Build the guard text. */
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
