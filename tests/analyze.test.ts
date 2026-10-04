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
	test("Output under the byte limit doesn't fire", () => {
		const a = assessOutput(lines(10), cfg);
		expect(a.exceeded).toBe(false);
		expect(a.totalLines).toBe(10);
	});

	test("Exactly at the limit doesn't fire (only strictly greater is intercepted)", () => {
		const text = "x".repeat(cfg.maxBytes);
		const a = assessOutput(text, cfg);
		expect(a.totalBytes).toBe(cfg.maxBytes);
		expect(a.exceeded).toBe(false);
	});

	test("Over the byte limit fires", () => {
		const a = assessOutput("x".repeat(cfg.maxBytes + 1), cfg);
		expect(a.totalLines).toBe(1);
		expect(a.exceeded).toBe(true);
	});

	test("Bytes only: many short lines under the total don't fire", () => {
		const onlyBytes = { maxBytes: 5120 };
		const manyShortLines = Array.from({ length: 2000 }, () => "a").join("\n");
		expect(assessOutput(manyShortLines, onlyBytes).exceeded).toBe(false);
		expect(assessOutput("x".repeat(6000), onlyBytes).exceeded).toBe(true);
	});

	test("maxBytes=0 means no limit", () => {
		expect(assessOutput("x".repeat(100000), { maxBytes: 0 }).exceeded).toBe(false);
	});
});

describe("describeLimit", () => {
	test("Shows the byte limit; 0 shows unlimited", () => {
		expect(describeLimit({ maxBytes: 8192 })).toBe("8.0KB");
		expect(describeLimit({ maxBytes: 0 })).toBe("unlimited");
	});
});

describe("formatBytes", () => {
	test("Switches units by size", () => {
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(10 * 1024)).toBe("10.0KB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0MB");
	});
});

describe("stripBuiltinFooter", () => {
	test("Drops the built-in [Showing lines ...] footer", () => {
		const text = `a\nb\n\n[Showing lines 1-2 of 900. Full output: /tmp/x]`;
		expect(stripBuiltinFooter(text)).toBe("a\nb\n");
	});

	test("Returns text unchanged when there is no footer", () => {
		expect(stripBuiltinFooter("a\nb")).toBe("a\nb");
	});
});

describe("buildPreview", () => {
	test("When total fits head+tail, returns everything and shows no omission", () => {
		const p = buildPreview(lines(20), 20, 15);
		expect(p.headLines).toHaveLength(20);
		expect(p.tailLines).toHaveLength(0);
		expect(p.omittedLines).toBe(0);
	});

	test("When over, takes head and tail, and omission count is the middle part", () => {
		const p = buildPreview(lines(1000), 20, 15);
		expect(p.headLines).toHaveLength(20);
		expect(p.tailLines).toHaveLength(15);
		expect(p.omittedLines).toBe(1000 - 35);
		expect(p.headLines[0]).toBe("line 0");
		expect(p.tailLines.at(-1)).toBe("line 999");
	});
});

describe("collapseRepeats", () => {
	test("Folds runs of identical lines; non-adjacent ones don't merge", () => {
		const collapsed = collapseRepeats(["a", "a", "a", "b", "a"]);
		expect(collapsed).toEqual([
			{ line: "a", count: 3 },
			{ line: "b", count: 1 },
			{ line: "a", count: 1 },
		]);
	});
});

describe("extractSignalLines", () => {
	test("Pulls error/warning lines, dedupes, respects the cap", () => {
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

	test("limit 0 returns empty", () => {
		expect(extractSignalLines("Error: x", 0)).toEqual([]);
	});
});
