import { describe, expect, test } from "vitest";
import { isSearchCommand, SEARCH_TIMEOUT_SECONDS, searchTimeoutInjection } from "../src/timeout-guard";

const inject = (command: string, timeout?: number) =>
	searchTimeoutInjection(command, timeout === undefined ? {} : { timeout });

describe("isSearchCommand", () => {
	test.each([
		"find . -name x",
		"find",
		"rg foo",
		"rg foo src tests",
		"grep -r foo src",
		"grep -rn x .",
		"du -sh .",
		"tree",
		"sudo find /tmp -name x",
		'/usr/bin/rg -n "a|b" src',
	])("搜索命令：%s", (command) => {
		expect(isSearchCommand(command)).toBe(true);
	});

	test.each([
		"grep foo file.txt", // 非递归 grep
		"grep -n foo file.txt",
		"ls",
		"git status",
		"tail -f app.log",
		"watch date",
		"cat file",
		"pnpm install",
		"echo rg",
	])("非搜索命令：%s", (command) => {
		expect(isSearchCommand(command)).toBe(false);
	});
});

describe("searchTimeoutInjection — 搜索命令封顶 5 分钟", () => {
	test("缺 timeout 的搜索命令注入 300", () => {
		expect(inject("rg foo src")).toBe(SEARCH_TIMEOUT_SECONDS);
		expect(inject("find . -name x")).toBe(300);
		expect(inject("grep -r foo .")).toBe(300);
	});

	test("显式更大的 timeout 压到 300（5 分钟是硬上限）", () => {
		expect(inject("rg foo src", 900)).toBe(300);
		expect(inject("find . -name x", SEARCH_TIMEOUT_SECONDS + 1)).toBe(300);
	});

	test("显式更小的 timeout 保留（300 是上限不是覆盖）", () => {
		expect(inject("rg foo src", 60)).toBeNull();
		expect(inject("find . -name x", SEARCH_TIMEOUT_SECONDS)).toBeNull();
	});

	test("非搜索命令一律不动（全放开）", () => {
		expect(inject("grep foo file.txt")).toBeNull();
		expect(inject("git status")).toBeNull();
		expect(inject("tail -f app.log")).toBeNull();
		expect(inject("pnpm install", 999999)).toBeNull();
	});
});
