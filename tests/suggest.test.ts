import { describe, expect, test } from "vitest";
import { suggestRewrites } from "../src/suggest";

describe("suggestRewrites", () => {
	test("cat on a big file -> suggests read tool / sed / head", () => {
		const hints = suggestRewrites("cat src/big.ts");
		expect(hints.join(" ")).toContain("read");
	});

	test("Unbounded rg -> suggests -l / -c / -m", () => {
		const hints = suggestRewrites('rg "TODO" .');
		expect(hints.join(" ")).toMatch(/-l|-c|--max-count/);
	});

	test("Unbounded git log -> suggests --oneline -n", () => {
		const hints = suggestRewrites("git log");
		expect(hints.join(" ")).toContain("--oneline");
		expect(suggestRewrites("git --no-pager log").join(" ")).toContain("--oneline");
		expect(suggestRewrites("git -C /tmp log").join(" ")).toContain("--oneline");
	});

	test("git diff -> suggests --stat", () => {
		const hints = suggestRewrites("git diff");
		expect(hints.join(" ")).toContain("--stat");
	});

	test("Recursive directory listing -> suggests capping", () => {
		const hints = suggestRewrites("ls -R");
		expect(hints.join(" ")).toMatch(/head|tree -L/);
	});

	test("Already-bounded command gets the generic hint", () => {
		const hints = suggestRewrites("rg -n -m 5 foo . | head -n 20");
		expect(hints).toHaveLength(1);
		expect(hints[0]).toContain("wc -l");
	});

	test("Returns at most 3 hints", () => {
		const hints = suggestRewrites("find . -type f | xargs cat | git log");
		expect(hints.length).toBeLessThanOrEqual(3);
		expect(hints.length).toBeGreaterThan(0);
	});
});
