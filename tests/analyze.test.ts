import { describe, expect, test } from "vitest";
import {
	assessOutput,
	buildPreview,
	collapseRepeats,
	describeLimit,
	extractSignalLines,
	formatBytes,
	stripBuiltinFooter,
} from "../src/analyze";

const cfg = { maxBytes: 10 * 1024 };

function lines(n: number, prefix = "line"): string {
	return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");
}

describe("assessOutput", () => {
	test("字节未超阈值不触发", () => {
		const a = assessOutput(lines(10), cfg);
		expect(a.exceeded).toBe(false);
		expect(a.totalLines).toBe(10);
	});

	test("恰好等于阈值不触发（严格大于才拦截）", () => {
		const text = "x".repeat(cfg.maxBytes);
		const a = assessOutput(text, cfg);
		expect(a.totalBytes).toBe(cfg.maxBytes);
		expect(a.exceeded).toBe(false);
	});

	test("超过字节阈值触发", () => {
		const a = assessOutput("x".repeat(cfg.maxBytes + 1), cfg);
		expect(a.totalLines).toBe(1);
		expect(a.exceeded).toBe(true);
	});

	test("只看字节：很多短行但总量不超就不触发", () => {
		const onlyBytes = { maxBytes: 5120 };
		const manyShortLines = Array.from({ length: 2000 }, () => "a").join("\n");
		expect(assessOutput(manyShortLines, onlyBytes).exceeded).toBe(false);
		expect(assessOutput("x".repeat(6000), onlyBytes).exceeded).toBe(true);
	});

	test("maxBytes=0 表示不限制", () => {
		expect(assessOutput("x".repeat(100000), { maxBytes: 0 }).exceeded).toBe(false);
	});
});

describe("describeLimit", () => {
	test("显示字节阈值，0 显示 unlimited", () => {
		expect(describeLimit({ maxBytes: 8192 })).toBe("8.0KB");
		expect(describeLimit({ maxBytes: 0 })).toBe("unlimited");
	});
});

describe("formatBytes", () => {
	test("按量级切换单位", () => {
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(10 * 1024)).toBe("10.0KB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0MB");
	});
});

describe("stripBuiltinFooter", () => {
	test("剔除内建 [Showing lines ...] footer", () => {
		const text = `a\nb\n\n[Showing lines 1-2 of 900. Full output: /tmp/x]`;
		expect(stripBuiltinFooter(text)).toBe("a\nb\n");
	});

	test("无 footer 时原样返回", () => {
		expect(stripBuiltinFooter("a\nb")).toBe("a\nb");
	});
});

describe("buildPreview", () => {
	test("总量不超过 head+tail 时全量返回，不显示省略", () => {
		const p = buildPreview(lines(20), 20, 15);
		expect(p.headLines).toHaveLength(20);
		expect(p.tailLines).toHaveLength(0);
		expect(p.omittedLines).toBe(0);
	});

	test("超出时头尾各取，且省略数为中间部分", () => {
		const p = buildPreview(lines(1000), 20, 15);
		expect(p.headLines).toHaveLength(20);
		expect(p.tailLines).toHaveLength(15);
		expect(p.omittedLines).toBe(1000 - 35);
		expect(p.headLines[0]).toBe("line 0");
		expect(p.tailLines.at(-1)).toBe("line 999");
	});
});

describe("collapseRepeats", () => {
	test("连续相同行折叠计数，非连续不合并", () => {
		const collapsed = collapseRepeats(["a", "a", "a", "b", "a"]);
		expect(collapsed).toEqual([
			{ line: "a", count: 3 },
			{ line: "b", count: 1 },
			{ line: "a", count: 1 },
		]);
	});
});

describe("extractSignalLines", () => {
	test("抽取错误/警告类行并去重，遵守上限", () => {
		const text = [
			"progress 1%",
			"Error: boom",
			"at foo (bar.ts:1:1)",
			"Error: boom",
			"warning: deprecated",
			"npm ERR! code 1",
			"done",
		].join("\n");
		const sig = extractSignalLines(text, 10);
		expect(sig).toContain("Error: boom");
		expect(sig).toContain("warning: deprecated");
		expect(sig).toContain("npm ERR! code 1");
		expect(sig.filter((l) => l === "Error: boom")).toHaveLength(1);
	});

	test("limit 为 0 返回空", () => {
		expect(extractSignalLines("Error: x", 0)).toEqual([]);
	});
});
