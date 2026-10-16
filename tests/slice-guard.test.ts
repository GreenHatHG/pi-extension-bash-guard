import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	newFileSliceState,
	parseSlices,
	RAPID_MAX_GAP_SECONDS,
	RAPID_MIN_GAP_SECONDS,
	RAPID_REPEAT_LIMIT,
	RAPID_WINDOW_MS,
	recordSlice,
	SLICE_BLOCK_AFTER,
	SLICE_NUDGE_AFTER,
} from "../src/slice-guard";

/** Milliseconds per day, so fixture timestamps can be shifted to "now" in tests. */
const DAY = 24 * 60 * 60 * 1000;

describe("parseSlices", () => {
	test("single-range, double-range, quoted forms, and cd prefixes", () => {
		expect(parseSlices("sed -n '640,700p' src/watchdog.ts")).toEqual([
			{ file: "src/watchdog.ts", ranges: [[640, 700]] },
		]);
		expect(parseSlices('sed -n "10,20p" file.ts')).toEqual([{ file: "file.ts", ranges: [[10, 20]] }]);
		expect(parseSlices("sed -n 1,5p file.ts")).toEqual([{ file: "file.ts", ranges: [[1, 5]] }]);
		expect(parseSlices("sed -n '188,196p;580,585p;119,133p' f.ts")).toEqual([
			{
				file: "f.ts",
				ranges: [
					[188, 196],
					[580, 585],
					[119, 133],
				],
			},
		]);
		expect(parseSlices("cd /work && sed -n '1,5p' a.ts")).toEqual([{ file: "a.ts", ranges: [[1, 5]] }]);
	});

	test("skips non-slice seds and non-sed commands", () => {
		// Pattern address, no line numbers: no key to count.
		expect(parseSlices("sed -n /hello/p file.ts")).toEqual([]);
		expect(parseSlices("sed 's/a/b/' file.ts")).toEqual([]);
		expect(parseSlices("cat file.ts")).toEqual([]);
		expect(parseSlices("")).toEqual([]);
	});

	test("pipeline: file before the pipe counts, file after does not", () => {
		expect(parseSlices("sed -n '1,5p' f.ts | grep x")).toEqual([{ file: "f.ts", ranges: [[1, 5]] }]);
		expect(parseSlices("grep -n x f.ts | sed -n '1,5p'")).toEqual([]);
	});

	test("command substitutions are judged as their own commands", () => {
		expect(parseSlices("echo $(sed -n '3,4p' inner.ts)")).toEqual([{ file: "inner.ts", ranges: [[3, 4]] }]);
		expect(parseSlices("echo `sed -n '3,4p' inner.ts`")).toEqual([{ file: "inner.ts", ranges: [[3, 4]] }]);
		// Single-quoted substitution is literal text, not a command.
		expect(parseSlices("echo '$(sed -n 3,4p inner.ts)'")).toEqual([]);
	});
});

describe("normalizePath", () => {
	test("strips trailing punctuation and ./ prefix", () => {
		expect(new Set([parseSlices("sed -n '1,2p' a.ts;").map((s) => s.file)[0]])).toEqual(new Set(["a.ts"]));
		expect(parseSlices("sed -n '1,2p' ./a.ts")[0].file).toBe("a.ts");
	});
});

describe("recordSlice thresholds", () => {
	const mk = (ranges: Array<[number, number]>) => ({ file: "f.ts", ranges });
	const now = 1_000_000_000;

	test("pass until nudge, then pass, then volume block", () => {
		const state = newFileSliceState();
		// Same range, spaced far apart: never a fast re-read, only the volume counter moves.
		const gap = RAPID_MAX_GAP_SECONDS * 1000 + DAY;
		let verdict: ReturnType<typeof recordSlice> = { kind: "pass" };
		for (let i = 0; i < SLICE_NUDGE_AFTER - 1; i++) {
			verdict = recordSlice(state, mk([[1, 2]]), now + i * gap);
			expect(verdict.kind).toBe("pass");
		}
		verdict = recordSlice(state, mk([[1, 2]]), now + SLICE_NUDGE_AFTER * gap);
		expect(verdict).toMatchObject({ kind: "nudge" });
		// Nudge fires once; keep going to the volume cap.
		for (let i = SLICE_NUDGE_AFTER + 1; i < SLICE_BLOCK_AFTER; i++) {
			verdict = recordSlice(state, mk([[1, 2]]), now + i * gap);
			expect(verdict.kind).toBe("pass");
		}
		verdict = recordSlice(state, mk([[1, 2]]), now + SLICE_BLOCK_AFTER * gap);
		expect(verdict).toMatchObject({ kind: "block" });
		// Latched: every further read of this file stays blocked even if ranges change.
		verdict = recordSlice(state, mk([[9, 9]]), now + (SLICE_BLOCK_AFTER + 1) * gap);
		expect(verdict.kind).toBe("block");
	});

	test("fast re-reads inside the window trip the loop breaker", () => {
		const state = newFileSliceState();
		const tick = 60_000; // 1 min between reads: a fast gap.
		// Same range over and over. Call #1 is the first read (no prior read = no hit); each call
		// after adds one fast-re-read hit, so the loop breaker fires on call RAPID_REPEAT_LIMIT + 1.
		for (let i = 0; i < RAPID_REPEAT_LIMIT; i++) {
			const verdict = recordSlice(state, mk([[694, 716]]), now + i * tick);
			expect(verdict.kind).toBe("pass");
		}
		const verdict = recordSlice(state, mk([[694, 716]]), now + RAPID_REPEAT_LIMIT * tick);
		expect(verdict).toMatchObject({ kind: "block" });
	});

	test("re-reads older than the window fall out of the count", () => {
		const state = newFileSliceState();
		const tick = 60_000;
		// 5 fast hits, then a read beyond the 30-minute window, then more hits: still under the cap.
		for (let i = 0; i < 5; i++) recordSlice(state, mk([[1, 9]]), now + i * tick);
		const afterWindow = now + RAPID_WINDOW_MS + DAY;
		expect(recordSlice(state, mk([[1, 9]]), afterWindow).kind).toBe("pass");
		expect(recordSlice(state, mk([[1, 9]]), afterWindow + tick).kind).toBe("pass");
		expect(recordSlice(state, mk([[1, 9]]), afterWindow + 2 * tick).kind).toBe("pass");
	});

	test("gaps just past 10 minutes do not count as fast re-reads", () => {
		const state = newFileSliceState();
		const slowGap = (RAPID_MAX_GAP_SECONDS + 60) * 1000;
		for (let i = 0; i < 10; i++) {
			expect(recordSlice(state, mk([[5, 5]]), now + i * slowGap).kind).toBe("pass");
		}
		expect(state.rapidHits).toHaveLength(0);
	});

	test("gaps under 15 seconds are same-command retries, not loops", () => {
		const state = newFileSliceState();
		const fastGap = (RAPID_MIN_GAP_SECONDS - 1) * 1000;
		for (let i = 0; i < 12; i++) {
			expect(recordSlice(state, mk([[5, 5]]), now + i * fastGap).kind).toBe("pass");
		}
	});
});

/** One replayed call from a real session: command text + its original timestamp. */
interface FixtureCall {
	ts: string;
	command: string;
}

/** Replay a fixture and return the first block verdict's call index (-1 = never blocked). */
function replayFixture(calls: FixtureCall[]): number {
	const states = new Map<string, ReturnType<typeof newFileSliceState>>();
	const t0 = Date.parse(calls[0].ts);
	for (let i = 0; i < calls.length; i++) {
		for (const slice of parseSlices(calls[i].command)) {
			let state = states.get(slice.file);
			if (!state) {
				state = newFileSliceState();
				states.set(slice.file, state);
			}
			const verdict = recordSlice(state, slice, t0 + (Date.parse(calls[i].ts) - t0));
			if (verdict.kind === "block") return i;
		}
	}
	return -1;
}

function loadFixture(name: string): FixtureCall[] {
	// Fixtures live outside the repo (they carry full session commands); tests skip if absent.
	const path = join("/tmp/pi-slice-stats", `fixture-${name}.json`);
	try {
		return JSON.parse(readFileSync(path, "utf8")) as FixtureCall[];
	} catch {
		return [];
	}
}

describe("replayed real sessions", () => {
	test("repo-tutor (52 legit slice reads, no repeats) is never blocked", { timeout: 30_000 }, () => {
		const calls = loadFixture("repo-tutor");
		if (calls.length === 0) return expect(true).toBe(true); // fixture not present
		expect(replayFixture(calls)).toBe(-1);
	});

	test("farm tweak-loop is blocked within its 12 minutes", { timeout: 30_000 }, () => {
		const calls = loadFixture("farm-loop");
		if (calls.length === 0) return expect(true).toBe(true);
		const at = replayFixture(calls);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(at).toBeLessThan(calls.length);
	});

	test("runaway 8h session is blocked long before its 1220th read", { timeout: 60_000 }, () => {
		const calls = loadFixture("runaway-8h");
		if (calls.length === 0) return expect(true).toBe(true);
		const at = replayFixture(calls);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(at).toBeLessThan(500);
	});
});
