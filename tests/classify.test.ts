import { describe, expect, test } from "vitest";
import { classifyCommand } from "../src/classify";

describe("classifyCommand", () => {
	test("搜索 / 列举 / 转储类归为 exhaust", () => {
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

	test("构建 / 测试类归为 build-test", () => {
		for (const cmd of ["pnpm build", "npm test", "cargo build", "pytest -q", "make", "go test ./..."]) {
			expect(classifyCommand(cmd), cmd).toBe("build-test");
		}
	});

	test("读文件类单独出现时按载荷对待（unknown）", () => {
		for (const cmd of ["cat big.log", "head -n 50 app.log", "sed -n '1,80p' file.ts", "tail -f app.log"]) {
			expect(classifyCommand(cmd), cmd).toBe("unknown");
		}
	});

	test("读文件类与搜索组合时归为 exhaust（如 cat | rg）", () => {
		expect(classifyCommand("cat big.log | rg error")).toBe("exhaust");
		expect(classifyCommand("cat big.log | grep -n error")).toBe("exhaust");
	});

	test("git 子命令区分：log 是 exhaust，diff/status 是载荷", () => {
		expect(classifyCommand("git log --oneline -n 20")).toBe("exhaust");
		expect(classifyCommand("git diff")).toBe("unknown");
		expect(classifyCommand("git status")).toBe("unknown");
	});

	test("白名单之外的命令一律 unknown", () => {
		for (const cmd of ["python train.py", "node server.js", "curl https://example.com", "docker build ."]) {
			expect(classifyCommand(cmd), cmd).toBe("unknown");
		}
	});

	test("只有语义中性命令时 unknown", () => {
		expect(classifyCommand("echo hi")).toBe("unknown");
		expect(classifyCommand("true")).toBe("unknown");
		expect(classifyCommand("cd /tmp && echo done")).toBe("unknown");
	});

	test("混合搜索与构建时 unknown（保守放行）", () => {
		expect(classifyCommand("rg foo . && pnpm build")).toBe("unknown");
	});

	test("包装器 / 赋值 / 重定向不影响判定", () => {
		expect(classifyCommand("sudo rg foo /tmp")).toBe("exhaust");
		expect(classifyCommand("FOO=bar rg foo .")).toBe("exhaust");
		expect(classifyCommand("rg foo . 2>/dev/null")).toBe("exhaust");
		expect(classifyCommand("rg -n foo . > /tmp/out.txt")).toBe("exhaust");
	});

	test("路径调用（/usr/bin/grep）能识别", () => {
		expect(classifyCommand("/usr/bin/rg foo .")).toBe("exhaust");
	});

	test("采用 claude-code 的搜索清单：locate / which / whereis 也算过程输出", () => {
		for (const cmd of ["locate node", "which node", "whereis rg"]) {
			expect(classifyCommand(cmd), cmd).toBe("exhaust");
		}
	});

	test("采用 claude-code 的读/转换清单：wc / jq / sort 等单独出现按载荷", () => {
		for (const cmd of ["wc -l file.ts", "jq '.a' f.json", "sort names.txt", "stat file.ts", "strings a.bin"]) {
			expect(classifyCommand(cmd), cmd).toBe("unknown");
		}
	});

	test("SILENT 命令（mv/mkdir/cd…）被跳过，不拖回 unknown", () => {
		expect(classifyCommand("mv a b && rg foo .")).toBe("exhaust");
		expect(classifyCommand("mkdir -p out && find . -name '*.ts'")).toBe("exhaust");
	});

	test("空命令 unknown", () => {
		expect(classifyCommand("")).toBe("unknown");
	});

	test("解析失败 / 白名单外的一段会拖回 unknown（单向偏向放行）", () => {
		// 含一段白名单外的命令（awk 属于 read，但这里用 python 更直观）
		expect(classifyCommand("rg foo . | python -c 'print(1)'")).toBe("unknown");
	});
});
