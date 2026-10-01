import { homedir } from "node:os";
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

describe("tool_call 无界扫描事前拦截", () => {
	const toolCall = (rt: MockRuntime, command: string, timeout?: number) => {
		const input: { command: string; timeout?: number } = { command };
		if (timeout !== undefined) input.timeout = timeout;
		return rt.emit("tool_call", { toolName: "bash", input });
	};

	test("根目录为 / 的 rg 被 block，并给出收窄建议", async () => {
		const rt = await setup();
		const res = await toolCall(rt, "rg foo /");
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("[BASH SCAN GUARD]");
		expect(res?.reason).toContain("mdfind");
	});

	test("根目录为 $HOME 的 find 被 block", async () => {
		const rt = await setup();
		const res = await toolCall(rt, `find ${homedir()} -name x`);
		expect(res?.block).toBe(true);
	});

	test("收窄到子目录放行", async () => {
		const rt = await setup();
		// `rg foo ~/Projects` 不是整个 home，scan-guard 不拦；仅注入 5 分钟封顶（不 block）。
		expect(await toolCall(rt, "rg foo ~/Projects")).toBeUndefined();
	});

	test("根目录为系统目录 /etc 的 rg 被 block", async () => {
		const rt = await setup();
		const res = await toolCall(rt, "rg foo /etc");
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("/etc");
	});

	test("非 bash/powershell 工具放行", async () => {
		const rt = await setup();
		expect(await rt.emit("tool_call", { toolName: "read", input: { command: "rg foo /" } })).toBeUndefined();
	});

	test("scan off 后放行", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "scan off");
		// scan-guard 关掉后 `rg foo /` 不再 block（只剩 5 分钟封顶，不 block）
		expect(await toolCall(rt, "rg foo /")).toBeUndefined();
	});

	test("总开关 off 后放行", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		expect(await toolCall(rt, "rg foo /")).toBeUndefined();
	});

	test("scan 开关持久化进会话条目", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "scan off");
		const entry = rt.sessionEntries.filter((e) => e.customType === "bash-guard-config").at(-1);
		expect((entry?.data as any)?.scanBlock).toBe(false);
	});
});

describe("tool_call 搜索命令超时封顶", () => {
	const emitCall = async (rt: MockRuntime, command: string, timeout?: number) => {
		const input: { command: string; timeout?: number } = { command };
		if (timeout !== undefined) input.timeout = timeout;
		const res = await rt.emit("tool_call", { toolName: "bash", input });
		return { res, input };
	};

	test("无 timeout 的搜索命令被注入 300 秒且不 block", async () => {
		const rt = await setup();
		const { res, input } = await emitCall(rt, "rg foo src");
		expect(res).toBeUndefined();
		expect(input.timeout).toBe(300);
	});

	test("显式大于 300 的搜索命令压到 300", async () => {
		const rt = await setup();
		const { input } = await emitCall(rt, 'rg -n "x" src tests | head -30', 900);
		expect(input.timeout).toBe(300);
	});

	test("显式小于 300 的搜索命令保留原值（300 是上限不是覆盖）", async () => {
		const rt = await setup();
		const { input } = await emitCall(rt, "rg foo src", 60);
		expect(input.timeout).toBe(60);
	});

	test("非搜索命令完全不动（不注入 timeout）", async () => {
		const rt = await setup();
		const { res, input } = await emitCall(rt, "git status");
		expect(res).toBeUndefined();
		expect(input.timeout).toBeUndefined();
	});

	test("非搜索命令的 input 对象整体未被改写", async () => {
		const rt = await setup();
		const input: { command: string; timeout?: number } = { command: "tail -f app.log" };
		const before = { ...input };
		await rt.emit("tool_call", { toolName: "bash", input });
		expect(input).toEqual(before);
		expect(Object.keys(input)).toEqual(["command"]);
	});

	test("非搜索命令显式的大 timeout 也不动（全放开）", async () => {
		const rt = await setup();
		const { input } = await emitCall(rt, "pnpm install", 999999);
		expect(input.timeout).toBe(999999);
	});

	test("scan off 时封顶仍生效（两个开关独立）", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "scan off");
		const { input } = await emitCall(rt, "rg foo src");
		expect(input.timeout).toBe(300);
	});

	test("总开关 off 时完全不动", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		const { res, input } = await emitCall(rt, "rg foo src");
		expect(res).toBeUndefined();
		expect(input.timeout).toBeUndefined();
	});

	test("第二个事故命令：递归 grep 无 timeout 被压到 300（不再跑 86 分钟）", async () => {
		const rt = await setup();
		// 根目录为 ~/.pi、~/Projects、~/ensoai —— 非 $HOME/`/`，scan-guard 不 block；
		// 但它是搜索命令，封顶 5 分钟。
		const command =
			`grep -rln "@pi_running\\|@pi_win\\|@pi_total" ${homedir()}/.pi ${homedir()}/Projects ${homedir()}/ensoai 2>/dev/null ` +
			`| grep -v "/sessions/" | grep -v "\\.git/" | head -30`;
		const { res, input } = await emitCall(rt, command);
		expect(res).toBeUndefined();
		expect(input.timeout).toBe(300);
	});
});

describe("timeout 错误引导", () => {
	test("搜索命令的超时错误被追加改写引导", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({
			text: "Command timed out after 600 seconds",
			command: "rg foo .",
			isError: true,
		});
		expect(resultText(result)).toContain("[BASH TIMEOUT GUARD]");
	});

	test("非搜索命令的超时不被改写（超时非本插件造成）", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({
			text: "Command timed out after 600 seconds",
			command: "npm run build",
			isError: true,
		});
		expect(result).toBeUndefined();
	});

	test("非超时的普通错误不被改写", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ text: "some small failure", command: "false", isError: true });
		expect(result).toBeUndefined();
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
