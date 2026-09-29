/**
 * 纯函数：输出尺寸评估、内建截断 footer 剔除、预览裁剪、连续重复行折叠、信号行抽取。
 * 不依赖 pi 运行时，方便单测。
 */

import type { GuardConfig } from "./config";

export interface Assessment {
	exceeded: boolean;
	totalLines: number;
	totalBytes: number;
}

/** 评估输出是否超过字节阈值。阈值为 0 表示不限制。行数不参与判断，仅作为展示信息。 */
export function assessOutput(text: string, cfg: Pick<GuardConfig, "maxBytes">): Assessment {
	const totalLines = text.split("\n").length;
	const totalBytes = Buffer.byteLength(text, "utf8");
	const overBytes = cfg.maxBytes > 0 && totalBytes > cfg.maxBytes;
	return { exceeded: overBytes, totalLines, totalBytes };
}

/** 把阈值描述成人类可读文案，如 `8.0KB` / `unlimited`。 */
export function describeLimit(cfg: Pick<GuardConfig, "maxBytes">): string {
	return cfg.maxBytes > 0 ? formatBytes(cfg.maxBytes) : "unlimited";
}

/** 人类可读的字节数（B / KB / MB / GB）。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)}MB`;
	return `${(mb / 1024).toFixed(1)}GB`;
}

const BUILTIN_FOOTER = /^\[Showing (?:lines|last) /;

/**
 * 去掉内建 bash 工具在截断时追加的 footer 行（`[Showing lines ...]` /
 * `[Showing last ...]`）。这些行只对内建截断语义有意义，混进预览里是噪声，
 * 真正的「全文在哪」信息由本插件统一给出。
 */
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
	/** 被省略的中间行数。 */
	omittedLines: number;
	totalLines: number;
}

/**
 * 生成头/尾预览。总行数不超过 head+tail 时全量返回于 headLines，tailLines 为空，
 * 不显示省略。
 */
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

/** 把连续相同的行折叠为 `{ line, count }`，渲染时非 1 的 count 显示为 `(×N)`。 */
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
	/^\s*at\s+.*\(?.*:\d+:\d+\)?/, // 栈帧
	/^\s*File ".*", line \d+/, // Python traceback
	/^npm ERR!/,
	/^\s*E[:\s]/,
	/^\s*error\[E\d+\]/,
	/^\s*warning:/i,
];

/**
 * 抽取可能的关键行（报错/警告/异常）。按出现顺序去重，最多 limit 条。
 * 目的：当输出尾部是进度噪声、错误却夹在中间时，把信号顶到模型眼前。
 */
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
