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
	])("search command: %s", (command) => {
		expect(isSearchCommand(command)).toBe(true);
	});

	test.each([
		"grep foo file.txt", // non-recursive grep
		"grep -n foo file.txt",
		"ls",
		"git status",
		"tail -f app.log",
		"watch date",
		"cat file",
		"pnpm install",
		"echo rg",
	])("not a search command: %s", (command) => {
		expect(isSearchCommand(command)).toBe(false);
	});
});

describe("searchTimeoutInjection — caps search commands at 5 minutes", () => {
	test("Search command with no timeout gets 300", () => {
		expect(inject("rg foo src")).toBe(SEARCH_TIMEOUT_SECONDS);
		expect(inject("find . -name x")).toBe(300);
		expect(inject("grep -r foo .")).toBe(300);
	});

	test("An explicit larger timeout is pulled to 300 (5 minutes is the hard cap)", () => {
		expect(inject("rg foo src", 900)).toBe(300);
		expect(inject("find . -name x", SEARCH_TIMEOUT_SECONDS + 1)).toBe(300);
	});

	test("An explicit smaller timeout is kept (300 is a ceiling, not an override)", () => {
		expect(inject("rg foo src", 60)).toBeNull();
		expect(inject("find . -name x", SEARCH_TIMEOUT_SECONDS)).toBeNull();
	});

	test("Non-search commands are never touched (hands off)", () => {
		expect(inject("grep foo file.txt")).toBeNull();
		expect(inject("git status")).toBeNull();
		expect(inject("tail -f app.log")).toBeNull();
		expect(inject("pnpm install", 999999)).toBeNull();
	});
});
