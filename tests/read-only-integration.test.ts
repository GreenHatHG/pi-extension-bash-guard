import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime, type MockRuntime } from "./helpers/mockPi";

const MODE_ENV = "PI_BASH_GUARD_MODE";

async function setup(): Promise<MockRuntime> {
	vi.resetModules();
	const rt = createMockRuntime();
	await rt.newPlugin();
	await rt.emit("session_start", { reason: "startup" });
	return rt;
}

/** Fire a bash tool_call, the way pi does before running the command. */
function callBash(rt: MockRuntime, command: string) {
	return rt.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command } });
}

let savedMode: string | undefined;
let savedEnabled: string | undefined;

beforeEach(() => {
	savedMode = process.env[MODE_ENV];
	savedEnabled = process.env.PI_BASH_GUARD_ENABLED;
	delete process.env[MODE_ENV];
	delete process.env.PI_BASH_GUARD_ENABLED;
	vi.resetModules();
});

afterEach(() => {
	if (savedMode === undefined) delete process.env[MODE_ENV];
	else process.env[MODE_ENV] = savedMode;
	if (savedEnabled === undefined) delete process.env.PI_BASH_GUARD_ENABLED;
	else process.env.PI_BASH_GUARD_ENABLED = savedEnabled;
});

describe("read-only fence wiring", () => {
	test("no mode: bash is untouched by the fence", async () => {
		const rt = await setup();
		const result = await callBash(rt, "pnpm test");
		// The scan/timeout logic may return undefined, but it never blocks a normal command
		expect(result?.block).toBeUndefined();
	});

	test("advisor mode: a mutating command is blocked with the fence reason", async () => {
		process.env[MODE_ENV] = "advisor";
		const rt = await setup();
		const result = await callBash(rt, "pnpm test");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("[BASH READ-ONLY FENCE]");
	});

	test("advisor mode: read-only commands still run", async () => {
		process.env[MODE_ENV] = "advisor";
		const rt = await setup();
		for (const cmd of [
			"sed -n '1,60p' src/index.ts",
			"rg -l -m 5 advisor src/",
			"git log --oneline -n 20",
			"bun /Users/jooooody/Projects/pi-vcc/cli/main.ts recall /tmp/s.jsonl keyword",
			"tmux -L pi-sub capture-pane -t s -p | tail -30",
		]) {
			const result = await callBash(rt, cmd);
			expect(result?.block, cmd).toBeUndefined();
		}
	});

	test("advisor mode: redirects are blocked", async () => {
		process.env[MODE_ENV] = "advisor";
		const rt = await setup();
		const result = await callBash(rt, "git log > /tmp/out.txt");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("redirect");
	});

	test("an unknown mode fails closed: all bash blocked", async () => {
		process.env[MODE_ENV] = "advisr";
		const rt = await setup();
		const result = await callBash(rt, "sed -n '1,5p' f");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("unknown");
	});

	test("the fence applies even when the output guard is switched off", async () => {
		process.env[MODE_ENV] = "advisor";
		process.env.PI_BASH_GUARD_ENABLED = "0";
		const rt = await setup();
		expect((await callBash(rt, "pnpm test"))?.block).toBe(true);
		expect((await callBash(rt, "head -n 5 f"))?.block).toBeUndefined();
	});

	test("the status bar shows the read-only fence and counts blocks", async () => {
		process.env[MODE_ENV] = "advisor";
		const rt = await setup();
		expect(rt.statusBars.get("bash-guard")).toBe("🛡 read-only");
		await callBash(rt, "pnpm test");
		expect(rt.statusBars.get("bash-guard")).toBe("🛡 read-only ×1");
	});

	test("the opening notice explains the fence", async () => {
		process.env[MODE_ENV] = "advisor";
		const rt = await setup();
		const started = await rt.startAgent();
		expect(started?.message?.content).toContain("[READ-ONLY SESSION]");
		expect(started?.message?.content).toContain("[BASH READ-ONLY FENCE]");
	});

	test("no fence notice when the mode is unset", async () => {
		const rt = await setup();
		const started = await rt.startAgent();
		expect(started?.message?.content).not.toContain("[READ-ONLY SESSION]");
	});
});
