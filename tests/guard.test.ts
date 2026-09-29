import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime, type MockRuntime } from "./helpers/mockPi";

function bigOutput(n = 500, prefix = "line"): string {
	// 每行约 50 字节，确保默认 8KB 字节阈值被触发（只看字节，不限行数）
	return Array.from({ length: n }, (_, i) => `${prefix} ${i} ${"x".repeat(40)}`).join("\n");
}

async function setup(): Promise<MockRuntime> {
	vi.resetModules();
	const rt = createMockRuntime();
	await rt.newPlugin();
	await rt.emit("session_start", { reason: "startup" });
	return rt;
}

function resultText(result: any): string {
	return result?.content?.[0]?.text ?? "";
}

beforeEach(() => {
	vi.resetModules();
});

describe("开局纪律注入", () => {
	test("首次 agent run 注入 [BASH OUTPUT DISCIPLINE]，且只注入一次", async () => {
		const rt = await setup();
		const first = await rt.startAgent();
		expect(first?.message?.customType).toBe("bash-guard-framing");
		expect(first?.message?.content).toContain("[BASH OUTPUT DISCIPLINE]");
		expect(first?.message?.content).toContain("BASH OUTPUT GUARD");
		const second = await rt.startAgent();
		expect(second).toBeUndefined();
	});

	test("纪律说明持久化进会话条目", async () => {
		const rt = await setup();
		await rt.startAgent();
		expect(rt.sessionEntries.some((e) => e.customType === "bash-guard-framing")).toBe(true);
	});
});

describe("tool_result 拦截", () => {
	test("小输出原样放行（不返回改写）", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ text: "hello\nworld", command: "echo hi" });
		expect(result).toBeUndefined();
	});

	test("只看字节：很多短行但字节没超 8KB 时放行", async () => {
		const rt = await setup();
		const manyShortLines = Array.from({ length: 2000 }, () => "a").join("\n");
		const result = await rt.runToolResult({ text: manyShortLines, command: "seq a" });
		expect(result).toBeUndefined();
	});

	test("非 bash/powershell 工具放行", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ toolName: "read", text: bigOutput(), command: "read" });
		expect(result).toBeUndefined();
	});

	test("大输出被替换：含 guard 标题、预览、全文路径与重写建议", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ text: bigOutput(500), command: 'rg "TODO" .' });
		const text = resultText(result);
		expect(text).toContain("[BASH OUTPUT GUARD]");
		expect(text).toContain("Output withheld: 500 lines");
		expect(text).toContain("Preview — first");
		expect(text).toContain("lines omitted");
		expect(text).toContain("Full output saved to:");
		expect(text).toContain("pi-bash-guard-");
		expect(text).toContain("Rewrite the command instead of repeating it");
		expect(text).toContain("Do NOT re-run the same command");
		expect(text).toContain("--max-count");
		// details 不被改写
		expect(result.details).toBeUndefined();
	});

	test("连续重复行被折叠为 (×N)", async () => {
		const rt = await setup();
		const text = Array.from({ length: 300 }, () => `same line ${"y".repeat(40)}`).join("\n");
		const result = await rt.runToolResult({ text, command: "cat spam.log" });
		expect(resultText(result)).toContain("(×");
	});

	test("失败命令保留错误尾部并给出失败提示", async () => {
		const rt = await setup();
		const body = [
			...Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`),
			"Error: boom at the end",
		].join("\n");
		const result = await rt.runToolResult({ text: body, command: "cat big.log", isError: true });
		const text = resultText(result);
		expect(text).toContain("Command failed (non-zero exit)");
		expect(text).toContain("Error: boom at the end");
		expect(text).toContain("Error/warning lines:");
	});

	test("内建已截断时复用其完整输出路径并注明", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({
			text: bigOutput(500),
			command: "rg foo .",
			details: { truncation: { truncated: true }, fullOutputPath: "/tmp/builtin/out.txt" },
		});
		const text = resultText(result);
		expect(text).toContain("/tmp/builtin/out.txt");
		expect(text).toContain("built-in output cap was already hit");
	});

	test("同一命令重复触发时提示已拦截过", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(200), command: "rg x ." });
		const second = await rt.runToolResult({ text: bigOutput(200), command: "rg x ." });
		expect(resultText(second)).toContain("You already ran this exact command");
	});

	test("第 3 次拦截出现升级警告", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(200), command: "cmd one" });
		await rt.runToolResult({ text: bigOutput(200), command: "cmd two" });
		const third = await rt.runToolResult({ text: bigOutput(200), command: "cmd three" });
		expect(resultText(third)).toContain("fired 3 times this session");
	});

	test("命中的状态栏显示计数", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(200), command: "cmd" });
		expect(rt.statusBars.get("bash-guard")).toContain("×1");
	});
});

describe("/bash-guard 配置命令", () => {
	test("off 后不再拦截，且状态栏清空", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		expect(rt.statusBars.get("bash-guard")).toBeUndefined();
		const result = await rt.runToolResult({ text: bigOutput(500), command: "cmd" });
		expect(result).toBeUndefined();
	});

	test("off 后也不再注入纪律说明", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		expect(await rt.startAgent()).toBeUndefined();
	});

	test("bytes 调低阈值后更小的输出也被拦截", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "bytes 200");
		const result = await rt.runToolResult({ text: bigOutput(10), command: "cmd" });
		expect(resultText(result)).toContain("[BASH OUTPUT GUARD]");
	});

	test("配置持久化进会话条目", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "bytes 2048");
		const entry = rt.sessionEntries.filter((e) => e.customType === "bash-guard-config").at(-1);
		expect((entry?.data as any)?.maxBytes).toBe(2048);
	});

	test("status 报告当前配置", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "status");
		expect(rt.notifications.at(-1)?.msg).toContain("bash-guard: on");
	});

	test("非法参数给出错误通知", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "lines abc");
		expect(rt.notifications.at(-1)?.kind).toBe("error");
	});
});
