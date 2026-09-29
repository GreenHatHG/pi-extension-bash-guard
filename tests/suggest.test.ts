import { describe, expect, test } from "vitest";
import { suggestRewrites } from "../src/suggest";

describe("suggestRewrites", () => {
	test("cat 大文件 -> 建议 read 工具/sed/head", () => {
		const hints = suggestRewrites("cat src/big.ts");
		expect(hints.join(" ")).toContain("read");
	});

	test("无界 rg -> 建议 -l / -c / -m", () => {
		const hints = suggestRewrites('rg "TODO" .');
		expect(hints.join(" ")).toMatch(/-l|-c|--max-count/);
	});

	test("git log 无界 -> 建议 --oneline -n", () => {
		const hints = suggestRewrites("git log");
		expect(hints.join(" ")).toContain("--oneline");
	});

	test("git diff -> 建议 --stat", () => {
		const hints = suggestRewrites("git diff");
		expect(hints.join(" ")).toContain("--stat");
	});

	test("递归目录列举 -> 建议限量", () => {
		const hints = suggestRewrites("ls -R");
		expect(hints.join(" ")).toMatch(/head|tree -L/);
	});

	test("已有限的命令走通用建议", () => {
		const hints = suggestRewrites("rg -n -m 5 foo . | head -n 20");
		expect(hints).toHaveLength(1);
		expect(hints[0]).toContain("wc -l");
	});

	test("最多返回 3 条建议", () => {
		const hints = suggestRewrites("find . -type f | xargs cat | git log");
		expect(hints.length).toBeLessThanOrEqual(3);
		expect(hints.length).toBeGreaterThan(0);
	});
});
