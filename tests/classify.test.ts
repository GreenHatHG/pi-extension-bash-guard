import { describe, expect, test } from "vitest";
import { classifyCommand } from "../src/classify";

describe("classifyCommand", () => {
	test("Search / list / dump commands are exhaust", () => {
		for (const cmd of [
			"rg foo .",
			"grep -rn foo src",
			"grep -r foo src | head -30",
			"find . -name '*.ts'",
			"du -sh ~/Projects",
			"tree src",
			"ls -R",
			"env",
			"printenv PATH",
			"ps aux",
			"git log",
		]) {
			expect(classifyCommand(cmd), cmd).toBe("exhaust");
		}
	});

	test("Build / test commands are build-test", () => {
		for (const cmd of ["pnpm build", "npm test", "cargo build", "pytest -q", "make", "go test ./..."]) {
			expect(classifyCommand(cmd), cmd).toBe("build-test");
		}
	});

	test("File reads alone are treated as payload (unknown)", () => {
		for (const cmd of ["cat big.log", "head -n 50 app.log", "sed -n '1,80p' file.ts", "tail -f app.log"]) {
			expect(classifyCommand(cmd), cmd).toBe("unknown");
		}
	});

	test("File reads combined with search are exhaust (e.g. cat | rg)", () => {
		expect(classifyCommand("cat big.log | rg error")).toBe("exhaust");
		expect(classifyCommand("cat big.log | grep -n error")).toBe("exhaust");
	});

	test("git subcommands differ: log is exhaust, diff/status are payload", () => {
		expect(classifyCommand("git log --oneline -n 20")).toBe("exhaust");
		expect(classifyCommand("git --no-pager log")).toBe("exhaust");
		expect(classifyCommand("git -C /tmp log")).toBe("exhaust");
		expect(classifyCommand("git diff")).toBe("unknown");
		expect(classifyCommand("git status")).toBe("unknown");
	});

	test("Commands off the list are always unknown", () => {
		for (const cmd of ["python train.py", "node server.js", "curl https://example.com", "docker build ."]) {
			expect(classifyCommand(cmd), cmd).toBe("unknown");
		}
	});

	test("Only neutral commands means unknown", () => {
		expect(classifyCommand("echo hi")).toBe("unknown");
		expect(classifyCommand("true")).toBe("unknown");
		expect(classifyCommand("cd /tmp && echo done")).toBe("unknown");
	});

	test("Mixed search and build is unknown (conservative pass)", () => {
		expect(classifyCommand("rg foo . && pnpm build")).toBe("unknown");
	});

	test("Wrappers / assignments / redirections don't change the call", () => {
		expect(classifyCommand("sudo rg foo /tmp")).toBe("exhaust");
		expect(classifyCommand("FOO=bar rg foo .")).toBe("exhaust");
		expect(classifyCommand("rg foo . 2>/dev/null")).toBe("exhaust");
		expect(classifyCommand("rg -n foo . > /tmp/out.txt")).toBe("exhaust");
	});

	test("Absolute-path calls (/usr/bin/grep) are recognized", () => {
		expect(classifyCommand("/usr/bin/rg foo .")).toBe("exhaust");
	});

	test("Uses claude-code's search list: locate / which / whereis count as process output", () => {
		for (const cmd of ["locate node", "which node", "whereis rg"]) {
			expect(classifyCommand(cmd), cmd).toBe("exhaust");
		}
	});

	test("Uses claude-code's read/convert list: wc / jq / sort alone are payload", () => {
		for (const cmd of ["wc -l file.ts", "jq '.a' f.json", "sort names.txt", "stat file.ts", "strings a.bin"]) {
			expect(classifyCommand(cmd), cmd).toBe("unknown");
		}
	});

	test("SILENT commands (mv/mkdir/cd…) are skipped, not dragged back to unknown", () => {
		expect(classifyCommand("mv a b && rg foo .")).toBe("exhaust");
		expect(classifyCommand("mkdir -p out && find . -name '*.ts'")).toBe("exhaust");
	});

	test("Empty command is unknown", () => {
		expect(classifyCommand("")).toBe("unknown");
	});

	test("An unparseable part or one off the list drags it back to unknown (leans toward passing)", () => {
		// includes a command off the list (awk is a read, but python is clearer here)
		expect(classifyCommand("rg foo . | python -c 'print(1)'")).toBe("unknown");
	});
});
