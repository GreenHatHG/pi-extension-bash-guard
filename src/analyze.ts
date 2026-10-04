/**
 * Pure helpers: size checks, footer cleanup, preview trimming, repeat folding, signal-line pickup.
 * No pi runtime needed, so unit tests stay simple.
 */

import type { GuardConfig } from "./config";

export interface Assessment {
	exceeded: boolean;
	totalLines: number;
	totalBytes: number;
}

/** Check if output is over the byte limit. 0 means no limit; line count is only for display. */
export function assessOutput(text: string, cfg: Pick<GuardConfig, "maxBytes">): Assessment {
	const totalLines = text.split("\n").length;
	const totalBytes = Buffer.byteLength(text, "utf8");
	const overBytes = cfg.maxBytes > 0 && totalBytes > cfg.maxBytes;
	return { exceeded: overBytes, totalLines, totalBytes };
}

export function describeLimit(cfg: Pick<GuardConfig, "maxBytes">): string {
	return cfg.maxBytes > 0 ? formatBytes(cfg.maxBytes) : "unlimited";
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)}MB`;
	return `${(mb / 1024).toFixed(1)}GB`;
}

const BUILTIN_FOOTER = /^\[Showing (?:lines|last) /;

/** Drop the `[Showing ...]` footer the built-in bash tool adds on truncation — we give the full-file path ourselves, so it's just preview noise. */
export function stripBuiltinFooter(text: string): string {
	if (!text.includes("[Showing ")) return text;
	return text
		.split("\n")
		.filter((line) => !BUILTIN_FOOTER.test(line))
		.join("\n");
}

export interface Preview {
	headLines: string[];
	tailLines: string[];
	omittedLines: number;
	totalLines: number;
}

/** Build a head/tail preview. If the text fits in head+tail, it all goes in headLines and tailLines stays empty. */
export function buildPreview(text: string, head: number, tail: number): Preview {
	const lines = text.split("\n");
	const totalLines = lines.length;
	if (totalLines <= head + tail) {
		return { headLines: lines, tailLines: [], omittedLines: 0, totalLines };
	}
	return {
		headLines: lines.slice(0, head),
		tailLines: tail > 0 ? lines.slice(-tail) : [],
		omittedLines: totalLines - head - tail,
		totalLines,
	};
}

export interface CollapsedLine {
	line: string;
	count: number;
}

/** Fold runs of identical lines into `{ line, count }`; the UI shows `(×N)` when count > 1. */
export function collapseRepeats(lines: string[]): CollapsedLine[] {
	const out: CollapsedLine[] = [];
	for (const line of lines) {
		const last = out[out.length - 1];
		if (last && last.line === line) {
			last.count++;
		} else {
			out.push({ line, count: 1 });
		}
	}
	return out;
}

const SIGNAL_PATTERNS: RegExp[] = [
	/^\s*(error|err|fatal|panic)\b/i,
	/\b(error|err|failed|failure|fatal|panic|exception|traceback)\b/i,
	/\b(denied|refused|forbidden|unauthorized)\b/i,
	/\b(not found|no such file|does not exist|cannot|unable to)\b/i,
	/^\s*at\s+.*\(?.*:\d+:\d+\)?/, // stack frame
	/^\s*File ".*", line \d+/, // Python traceback
	/^npm ERR!/,
	/^\s*E[:\s]/,
	/^\s*error\[E\d+\]/,
	/^\s*warning:/i,
];

/** Pull error/warning lines in order, deduped, max `limit` — errors often hide in the middle of progress noise. */
export function extractSignalLines(text: string, limit: number): string[] {
	if (limit <= 0) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (!SIGNAL_PATTERNS.some((p) => p.test(trimmed))) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(line);
		if (out.length >= limit) break;
	}
	return out;
}
