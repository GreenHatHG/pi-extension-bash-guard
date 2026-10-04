import { homedir } from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime, type MockRuntime } from "./helpers/mockPi";

function bigOutput(n = 500, prefix = "line"): string {
	// ~50 bytes per line, so the default 8KB limit fires (bytes only, no line cap)
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

describe("Session-start discipline injection", () => {
	test("First agent run injects [BASH OUTPUT DISCIPLINE], once only", async () => {
		const rt = await setup();
		const first = await rt.startAgent();
		expect(first?.message?.customType).toBe("bash-guard-framing");
		expect(first?.message?.content).toContain("[BASH OUTPUT DISCIPLINE]");
		expect(first?.message?.content).toContain("BASH OUTPUT GUARD");
		const second = await rt.startAgent();
		expect(second).toBeUndefined();
	});

	test("Discipline note is saved to a session entry", async () => {
		const rt = await setup();
		await rt.startAgent();
		expect(rt.sessionEntries.some((e) => e.customType === "bash-guard-framing")).toBe(true);
	});
});

describe("tool_result interception", () => {
	test("Small output passes through (no rewrite)", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ text: "hello\nworld", command: "echo hi" });
		expect(result).toBeUndefined();
	});

	test("Bytes only: many short lines under 8KB pass", async () => {
		const rt = await setup();
		const manyShortLines = Array.from({ length: 2000 }, () => "a").join("\n");
		const result = await rt.runToolResult({ text: manyShortLines, command: "seq a" });
		expect(result).toBeUndefined();
	});

	test("Non bash/powershell tools pass", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ toolName: "read", text: bigOutput(), command: "read" });
		expect(result).toBeUndefined();
	});

	test("Large output is replaced: guard header, preview, full path, rewrite hints", async () => {
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
		// details are left untouched
		expect(result.details).toBeUndefined();
	});

	test("Repeated lines fold into (×N)", async () => {
		const rt = await setup();
		const text = Array.from({ length: 300 }, () => `same line ${"y".repeat(40)}`).join("\n");
		const result = await rt.runToolResult({ text, command: "rg same ." });
		expect(resultText(result)).toContain("(×");
	});

	test("Failed command keeps the error tail and notes the failure", async () => {
		const rt = await setup();
		const body = [
			...Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`),
			"Error: boom at the end",
		].join("\n");
		const result = await rt.runToolResult({ text: body, command: "rg line .", isError: true });
		const text = resultText(result);
		expect(text).toContain("Command failed (non-zero exit)");
		expect(text).toContain("Error: boom at the end");
		expect(text).toContain("Error/warning lines:");
	});

	test("When built-in truncation already hit, reuse its full-output path and say so", async () => {
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

	test("Built-in truncation totals come from truncation details, not the truncated text", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({
			text: "only the retained tail",
			command: "rg foo .",
			details: {
				truncation: { truncated: true, totalLines: 10241, totalBytes: 3_200_000 },
				fullOutputPath: "/tmp/builtin/full.txt",
			},
		});
		const text = resultText(result);
		expect(text).toContain("Output withheld: 10241 lines / 3.1MB");
	});

	test("Repeating the same command says it was already intercepted", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(200), command: "rg x ." });
		const second = await rt.runToolResult({ text: bigOutput(200), command: "rg x ." });
		expect(resultText(second)).toContain("You already ran this exact command");
	});

	test("Escalation warning appears on the 3rd interception, then only once", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(200), command: "rg a ." });
		await rt.runToolResult({ text: bigOutput(200), command: "rg b ." });
		const third = await rt.runToolResult({ text: bigOutput(200), command: "rg c ." });
		const fourth = await rt.runToolResult({ text: bigOutput(200), command: "rg d ." });
		expect(resultText(third)).toContain("fired 3 times this session");
		expect(resultText(fourth)).not.toContain("fired 4 times this session");
	});

	test("CJK guard message is cut to the UTF-8 byte budget", async () => {
		const rt = await setup();
		const text = Array.from({ length: 40 }, (_, i) => `错误 ${i} ${"中文".repeat(250)}`).join("\n");
		const result = await rt.runToolResult({ text, command: "rg error ." });
		expect(Buffer.byteLength(resultText(result), "utf8")).toBeLessThanOrEqual(8 * 1024);
	});

	test("Status bar shows the hit count", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(200), command: "rg x ." });
		expect(rt.statusBars.get("bash-guard")).toContain("×1");
	});
});

describe("Wider behavior for valuable payloads", () => {
	test("cat output over 8KB but under 30KB passes through", async () => {
		const rt = await setup();
		const text = bigOutput(300); // ~15KB, between the tight 8KB and wide 30KB limits
		const result = await rt.runToolResult({ text, command: "cat big.log" });
		expect(result).toBeUndefined();
	});

	test("cat output over 30KB is saved to disk, with no lecturing or rewrite hints", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ text: bigOutput(800), command: "cat big.log" });
		const text = resultText(result);
		expect(text).toContain("[BASH OUTPUT GUARD]");
		expect(text).toContain("Large result saved to disk");
		expect(text).toContain("Full output saved to:");
		expect(text).not.toContain("Rewrite the command instead of repeating it");
		expect(text).not.toContain("Do NOT re-run");
	});

	test("Build failure under the payload limit passes (error lines stay visible)", async () => {
		const rt = await setup();
		const body = [...Array.from({ length: 300 }, (_, i) => `build line ${i} ${"x".repeat(40)}`), "Error: boom"].join(
			"\n",
		);
		const result = await rt.runToolResult({ text: body, command: "pnpm build", isError: true });
		expect(result).toBeUndefined();
	});

	test("Payload class doesn't count toward escalation", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(800), command: "cat a.log" });
		await rt.runToolResult({ text: bigOutput(800), command: "cat b.log" });
		const third = await rt.runToolResult({ text: bigOutput(800), command: "cat c.log" });
		expect(resultText(third)).not.toContain("fired");
	});

	test("Repeating the same payload command doesn't say 'already intercepted'", async () => {
		const rt = await setup();
		await rt.runToolResult({ text: bigOutput(800), command: "cat same.log" });
		const second = await rt.runToolResult({ text: bigOutput(800), command: "cat same.log" });
		expect(resultText(second)).not.toContain("You already ran this exact command");
	});

	test("The payload subcommand adjusts the wide limit on its own", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "payload 400");
		const result = await rt.runToolResult({ text: bigOutput(20), command: "cat x.log" });
		expect(resultText(result)).toContain("[BASH OUTPUT GUARD]");
	});

	test("bytes 0 turns off only the tight limit; payload tier still works (tiers are independent)", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "bytes 0");
		const result = await rt.runToolResult({ text: bigOutput(800), command: "cat big.log" });
		expect(resultText(result)).toContain("[BASH OUTPUT GUARD]");
	});

	test("payload 0 turns off only the wide limit; tight tier still works (tiers are independent)", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "payload 0");
		const payloadResult = await rt.runToolResult({ text: bigOutput(800), command: "cat big.log" });
		expect(payloadResult).toBeUndefined();
		const exhaustResult = await rt.runToolResult({ text: bigOutput(200), command: "rg x ." });
		expect(resultText(exhaustResult)).toContain("[BASH OUTPUT GUARD]");
	});
});

describe("tool_call pre-run block of unbounded scans", () => {
	const toolCall = (rt: MockRuntime, command: string, timeout?: number) => {
		const input: { command: string; timeout?: number } = { command };
		if (timeout !== undefined) input.timeout = timeout;
		return rt.emit("tool_call", { toolName: "bash", input });
	};

	test("rg rooted at / is blocked, with narrowing hints", async () => {
		const rt = await setup();
		const res = await toolCall(rt, "rg foo /");
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("[BASH SCAN GUARD]");
		expect(res?.reason).toContain("mdfind");
	});

	test("find rooted at $HOME is blocked", async () => {
		const rt = await setup();
		const res = await toolCall(rt, `find ${homedir()} -name x`);
		expect(res?.block).toBe(true);
	});

	test("Narrowing to a subdir passes", async () => {
		const rt = await setup();
		// `rg foo ~/Projects` isn't the whole home, so scan-guard passes it; only the 5-minute cap is injected (no block).
		expect(await toolCall(rt, "rg foo ~/Projects")).toBeUndefined();
	});

	test("rg rooted at system dir /etc is blocked", async () => {
		const rt = await setup();
		const res = await toolCall(rt, "rg foo /etc");
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("/etc");
	});

	test("Non bash/powershell tools pass", async () => {
		const rt = await setup();
		expect(await rt.emit("tool_call", { toolName: "read", input: { command: "rg foo /" } })).toBeUndefined();
	});

	test("scan off lets it pass", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "scan off");
		// with scan-guard off, `rg foo /` is no longer blocked (only the 5-minute cap remains)
		expect(await toolCall(rt, "rg foo /")).toBeUndefined();
	});

	test("master switch off lets it pass", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		expect(await toolCall(rt, "rg foo /")).toBeUndefined();
	});

	test("scan switch is saved to a session entry", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "scan off");
		const entry = rt.sessionEntries.filter((e) => e.customType === "bash-guard-config").at(-1);
		expect((entry?.data as any)?.scanBlock).toBe(false);
	});
});

describe("tool_call timeout cap for search commands", () => {
	const emitCall = async (rt: MockRuntime, command: string, timeout?: number) => {
		const input: { command: string; timeout?: number } = { command };
		if (timeout !== undefined) input.timeout = timeout;
		const res = await rt.emit("tool_call", { toolName: "bash", input });
		return { res, input };
	};

	test("Search command with no timeout gets 300s, no block", async () => {
		const rt = await setup();
		const { res, input } = await emitCall(rt, "rg foo src");
		expect(res).toBeUndefined();
		expect(input.timeout).toBe(300);
	});

	test("Search command over 300 is pulled to 300", async () => {
		const rt = await setup();
		const { input } = await emitCall(rt, 'rg -n "x" src tests | head -30', 900);
		expect(input.timeout).toBe(300);
	});

	test("Search command under 300 keeps its value (300 is a ceiling, not an override)", async () => {
		const rt = await setup();
		const { input } = await emitCall(rt, "rg foo src", 60);
		expect(input.timeout).toBe(60);
	});

	test("Non-search commands are untouched (no timeout injected)", async () => {
		const rt = await setup();
		const { res, input } = await emitCall(rt, "git status");
		expect(res).toBeUndefined();
		expect(input.timeout).toBeUndefined();
	});

	test("Non-search command's input object is left completely alone", async () => {
		const rt = await setup();
		const input: { command: string; timeout?: number } = { command: "tail -f app.log" };
		const before = { ...input };
		await rt.emit("tool_call", { toolName: "bash", input });
		expect(input).toEqual(before);
		expect(Object.keys(input)).toEqual(["command"]);
	});

	test("An explicit large timeout on a non-search command is left alone too (hands off)", async () => {
		const rt = await setup();
		const { input } = await emitCall(rt, "pnpm install", 999999);
		expect(input.timeout).toBe(999999);
	});

	test("Cap still applies when scan is off (the two switches are independent)", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "scan off");
		const { input } = await emitCall(rt, "rg foo src");
		expect(input.timeout).toBe(300);
	});

	test("Master switch off leaves everything alone", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		const { res, input } = await emitCall(rt, "rg foo src");
		expect(res).toBeUndefined();
		expect(input.timeout).toBeUndefined();
	});

	test("Second real-world case: recursive grep with no timeout is pulled to 300 (no more 86-minute runs)", async () => {
		const rt = await setup();
		// roots are ~/.pi, ~/Projects, ~/ensoai — not $HOME or /, so scan-guard passes it;
		// but it's a search command, so it gets the 5-minute cap.
		const command =
			`grep -rln "@pi_running\\|@pi_win\\|@pi_total" ${homedir()}/.pi ${homedir()}/Projects ${homedir()}/ensoai 2>/dev/null ` +
			`| grep -v "/sessions/" | grep -v "\\.git/" | head -30`;
		const { res, input } = await emitCall(rt, command);
		expect(res).toBeUndefined();
		expect(input.timeout).toBe(300);
	});
});

describe("Timeout error hint", () => {
	test("A search command's timeout error gets the rewrite hint", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({
			text: "Command timed out after 600 seconds",
			command: "rg foo .",
			isError: true,
		});
		expect(resultText(result)).toContain("[BASH TIMEOUT GUARD]");
	});

	test("A non-search command's timeout isn't rewritten (not our cap)", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({
			text: "Command timed out after 600 seconds",
			command: "npm run build",
			isError: true,
		});
		expect(result).toBeUndefined();
	});

	test("A normal, non-timeout error isn't rewritten", async () => {
		const rt = await setup();
		const result = await rt.runToolResult({ text: "some small failure", command: "false", isError: true });
		expect(result).toBeUndefined();
	});
});

describe("/bash-guard config command", () => {
	test("After off, no more interception and the status bar clears", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		expect(rt.statusBars.get("bash-guard")).toBeUndefined();
		const result = await rt.runToolResult({ text: bigOutput(500), command: "cmd" });
		expect(result).toBeUndefined();
	});

	test("After off, no discipline note is injected either", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "off");
		expect(await rt.startAgent()).toBeUndefined();
	});

	test("After lowering bytes, smaller output is intercepted too", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "bytes 200");
		const result = await rt.runToolResult({ text: bigOutput(10), command: "rg x ." });
		expect(resultText(result)).toContain("[BASH OUTPUT GUARD]");
	});

	test("Config is saved to a session entry", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "bytes 2048");
		const entry = rt.sessionEntries.filter((e) => e.customType === "bash-guard-config").at(-1);
		expect((entry?.data as any)?.maxBytes).toBe(2048);
	});

	test("status reports the current config", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "status");
		expect(rt.notifications.at(-1)?.msg).toContain("bash-guard: on");
	});

	test("Bad arguments produce an error notification", async () => {
		const rt = await setup();
		await rt.runCommand("bash-guard", "lines abc");
		expect(rt.notifications.at(-1)?.kind).toBe("error");
	});
});
