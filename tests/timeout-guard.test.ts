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
		"grep foo file.txt", // any grep counts, recursive or not (a bad regex on a huge file hangs too)
		"grep -n foo file.txt",
		"grep foo /",
		"egrep foo file.txt",
	])("search command: %s", (command) => {
		expect(isSearchCommand(command)).toBe(true);
	});

	test.each(["ls", "git status", "tail -f app.log", "watch date", "cat file", "pnpm install", "echo rg"])(
		"not a search command: %s",
		(command) => {
			expect(isSearchCommand(command)).toBe(false);
		},
	);
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
		expect(inject("git status")).toBeNull();
		expect(inject("tail -f app.log")).toBeNull();
		expect(inject("pnpm install", 999999)).toBeNull();
	});

	test("A single-file grep gets the cap too (the 643s bundle-regex case)", () => {
		expect(inject("grep -o 'function buildSystemPrompt(.\\{0,4500\\}' dist/bundle/chunk.js | head -c 4600")).toBe(
			SEARCH_TIMEOUT_SECONDS,
		);
	});
});

describe("a search program that only filters a pipe is not the workload", () => {
	// Real case: pi-kitmux 2026-10-26T08-15-44-560Z, a deliberately long pre-commit run was pulled to
	// 300s and killed mid-run because a trailing `| grep` made the whole command count as a scan.
	const preCommitPipe =
		'cd /home/jooooody0710/projects/pi-kitmux && timeout 600 env PRE_COMMIT_HOME="$PWD/cache" ' +
		'uv run pre-commit run --all-files 2>&1 | grep -E "Failed|error" | head -10';

	test("a long build piped into grep keeps its own budget", () => {
		expect(inject(preCommitPipe)).toBeNull();
	});

	test("stdin-fed grep is not a scan, but a standalone grep in the same command is", () => {
		expect(inject("cat log.txt | grep -n error")).toBeNull();
		expect(inject("cat log.txt | grep -n error; grep -rn error src")).toBe(SEARCH_TIMEOUT_SECONDS);
	});

	test("`||` is a fallback, not a pipe: the search still runs against files", () => {
		expect(inject("rg foo src || echo none")).toBe(SEARCH_TIMEOUT_SECONDS);
	});

	test("a pipe inside a quoted pattern does not make the command a filter", () => {
		expect(inject('rg -n "a|b" src')).toBe(SEARCH_TIMEOUT_SECONDS);
	});

	test("a newline right after the pipe is a continuation, not a new command", () => {
		// Real shape: a long runner wrapped over two lines with the filter on the second line.
		expect(inject('npm run build 2>&1 |\n  grep -E "FAIL|error"')).toBeNull();
		expect(inject('pre-commit run --all-files |\n  grep -E "Failed|error"')).toBeNull();
		expect(inject("printf 'a\\n' |& \nrg foo ~")).toBeNull();
		expect(inject("a | \n rg foo src")).toBeNull();
	});
});
