import { describe, expect, test } from "vitest";
import {
	checkNumber,
	checkPath,
	checkString,
	countParentSegments,
	hasDominantSegment,
	MAX_PATH_LENGTH,
	validateToolArgs,
} from "../src/arg-guard";

describe("hasDominantSegment", () => {
	test("a path with one segment repeated hugely is degenerate", () => {
		// The exact production incident: `claude-code` appears ~1937 times.
		expect(hasDominantSegment(`/home/u/projects/claude-code/${"../claude-code/".repeat(1937)}`)).toBe(true);
	});

	test("a normal path is not degenerate", () => {
		expect(hasDominantSegment("/home/user/projects/app/src/main.ts")).toBe(false);
	});

	test("a deep but varied monorepo path is not degenerate", () => {
		const path = "/repo/packages/a/src/index.ts";
		expect(hasDominantSegment(path)).toBe(false);
	});

	test("a path with a repeated directory but under the threshold is not degenerate", () => {
		// `node_modules` repeating a handful of times is normal in monorepos.
		const path = "/a/node_modules/b/node_modules/c/node_modules/d/file.ts";
		expect(hasDominantSegment(path)).toBe(false);
	});

	test("short paths never trip (fewer segments than the threshold)", () => {
		expect(hasDominantSegment("/a/b/c/d/e/f")).toBe(false);
	});
});

describe("countParentSegments", () => {
	test("counts only literal .. segments", () => {
		expect(countParentSegments("/a/b/c")).toBe(0);
		expect(countParentSegments("a/../b")).toBe(1);
		expect(countParentSegments("../../..")).toBe(3);
	});
});

describe("checkPath", () => {
	test("a normal absolute path passes", () => {
		expect(checkPath("/home/user/projects/app/src/main.ts")).toEqual({ ok: true });
	});

	test("a too-long path is refused", () => {
		expect(checkPath("x".repeat(MAX_PATH_LENGTH + 1))).toMatchObject({ ok: false });
	});

	test("a parent-segment storm is refused", () => {
		expect(checkPath(`/home/x/${"../".repeat(20)}f`)).toMatchObject({ ok: false });
	});

	test("a modest parent climb (a few levels) passes", () => {
		// Legit "walk up two dirs" is fine; the fence is about storms, not any `..`.
		expect(checkPath("/a/../../b/file.ts")).toEqual({ ok: true });
	});

	test("a degenerate repeated path is refused", () => {
		// The exact production incident.
		const bad = `/home/jooooody0710/projects/claude-code/${"../claude-code/".repeat(1937)}`;
		const verdict = checkPath(bad);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/ARG GUARD/);
	});

	test("non-string path is ignored (not our shape)", () => {
		expect(checkPath(123)).toEqual({ ok: true });
	});
});

describe("checkNumber", () => {
	test("finite non-negative numbers pass", () => {
		expect(checkNumber(0)).toEqual({ ok: true });
		expect(checkNumber(500)).toEqual({ ok: true });
		expect(checkNumber(1800)).toEqual({ ok: true }); // legit long timeout
		expect(checkNumber(1_000_000)).toEqual({ ok: true });
	});

	test("Infinity and NaN are refused", () => {
		expect(checkNumber(Infinity)).toMatchObject({ ok: false });
		expect(checkNumber(Number.NaN)).toMatchObject({ ok: false });
	});

	test("negative numbers are refused", () => {
		expect(checkNumber(-5)).toMatchObject({ ok: false });
	});

	test("absurdly large numbers are refused", () => {
		expect(checkNumber(1e15)).toMatchObject({ ok: false });
	});
});

describe("checkString", () => {
	test("normal strings pass", () => {
		expect(checkString("hello")).toEqual({ ok: true });
	});

	test("absurdly long strings are refused", () => {
		expect(checkString("x".repeat(200_000))).toMatchObject({ ok: false });
	});
});

describe("validateToolArgs", () => {
	test("empty input passes", () => {
		expect(validateToolArgs({})).toEqual({ ok: true });
		expect(validateToolArgs(undefined)).toEqual({ ok: true });
	});

	test("a read call with a sane path + offset/limit passes", () => {
		expect(validateToolArgs({ path: "/project/src/main.ts", offset: 0, limit: 50 })).toEqual({ ok: true });
	});

	test("a read call with a degenerate path is blocked", () => {
		const verdict = validateToolArgs({
			path: `/p/${"../p/".repeat(1937)}`,
			offset: 0,
			limit: 100,
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/ARG GUARD/);
	});

	test("a negative limit is blocked", () => {
		expect(validateToolArgs({ path: "/p/f.ts", limit: -3 })).toMatchObject({ ok: false });
	});

	test("a path over the length cap is blocked", () => {
		expect(validateToolArgs({ path: "x".repeat(MAX_PATH_LENGTH + 1) })).toMatchObject({ ok: false });
	});

	test("write tool content is not length-checked (payload is exempt)", () => {
		// Writing a 60KB file is a normal call and must not be refused on length.
		expect(validateToolArgs({ path: "/p/big.ts", content: "x".repeat(60_000) })).toEqual({ ok: true });
	});

	test("edit tool newText is not length-checked (payload is exempt)", () => {
		expect(validateToolArgs({ path: "/p/f.ts", newText: "y".repeat(60_000) })).toEqual({ ok: true });
	});

	test("a command over the string cap is blocked (instruction key)", () => {
		expect(validateToolArgs({ command: "x".repeat(60_000) })).toMatchObject({ ok: false });
	});

	test("a pattern over the string cap is blocked (instruction key)", () => {
		expect(validateToolArgs({ pattern: "x".repeat(60_000) })).toMatchObject({ ok: false });
	});
});
