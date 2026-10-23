import { describe, expect, it } from "vitest";
import { measureSilentStreak, STREAK_BLOCK_AT, shapeOf, streakBlockMessage } from "../src/streak-guard";

type Entry = { type?: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown } };

function textPart(text: string) {
	return { type: "text", text };
}

function callPart(name: string, command: string) {
	return { type: "toolCall", id: "x", name, arguments: { command } };
}

function assistant(...parts: unknown[]): Entry {
	return { type: "message", message: { role: "assistant", content: parts } };
}

function user(text: string): Entry {
	return { type: "message", message: { role: "user", content: [textPart(text)] } };
}

describe("shapeOf", () => {
	it("reduces a command to program + subcommand", () => {
		expect(shapeOf("rg -l foo src/")).toBe("rg foo");
		// a quoted pattern is data, so grep stops at the program
		expect(shapeOf("grep -rn 'pattern' .")).toBe("grep");
		expect(shapeOf("git log --oneline -n 20")).toBe("git log");
		expect(shapeOf("git status")).toBe("git status");
	});

	it("drops the variable tail of CLI reads so different queries share a shape", () => {
		const a = shapeOf("bun /Users/x/Projects/pi-vcc/cli/main.ts recall /sessions/a.jsonl --query 'open args'");
		const b = shapeOf("bun /Users/x/Projects/pi-vcc/cli/main.ts recall /sessions/a.jsonl --query 'shim 消失'");
		expect(a).toBe(b);
		expect(a).toBe("bun main.ts recall");
	});

	it("skips navigation segments and judges the real command", () => {
		expect(shapeOf("cd /work && sed -n '1,80p' src/watchdog.ts")).toBe("sed");
		expect(shapeOf("cd /a; cd /b | rg x")).toBe("rg x");
	});

	it("skips wrappers and env assignments", () => {
		expect(shapeOf("FOO=1 rg x .")).toBe("rg x");
		expect(shapeOf("nohup bun server.ts start")).toBe("bun server.ts start");
		expect(shapeOf("timeout 30 rg x .")).toBe("rg x");
	});

	it("treats path/quoted arguments as data, not subcommands", () => {
		expect(shapeOf("sed -n '1,5p' src/x.ts")).toBe("sed");
		expect(shapeOf('cat "$HOME/file"')).toBe("cat");
		expect(shapeOf("wc -l")).toBe("wc");
	});

	it("returns null for navigation-only commands", () => {
		expect(shapeOf("cd /somewhere")).toBeNull();
		expect(shapeOf("")).toBeNull();
	});
});

describe("measureSilentStreak", () => {
	it("counts consecutive same-shape silent bash calls from the branch tail", () => {
		const branch: Entry[] = [
			user("go"),
			assistant(callPart("bash", "bun main.ts recall q1")),
			assistant(callPart("bash", "bun main.ts recall q2")),
			assistant(callPart("bash", "bun main.ts recall q3")),
		];
		expect(measureSilentStreak(branch, "bun main.ts recall")).toBe(3);
	});

	it("stops counting at assistant text — one line of progress resets the streak", () => {
		const branch: Entry[] = [
			user("go"),
			assistant(callPart("bash", "bun main.ts recall q1")),
			assistant(textPart("still no match, trying another keyword"), callPart("bash", "bun main.ts recall q2")),
			assistant(callPart("bash", "bun main.ts recall q3")),
		];
		expect(measureSilentStreak(branch, "bun main.ts recall")).toBe(1);
	});

	it("stops counting at a user message", () => {
		const branch: Entry[] = [
			assistant(callPart("bash", "rg 'x' .")),
			assistant(callPart("bash", "rg 'y' .")),
			user("status?"),
			assistant(callPart("bash", "rg 'z' .")),
		];
		expect(measureSilentStreak(branch, "rg")).toBe(1);
	});

	it("counts only the same shape — a different shape starts a new count", () => {
		const branch: Entry[] = [
			assistant(callPart("bash", "rg 'a' .")),
			assistant(callPart("bash", "rg 'b' .")),
			assistant(callPart("bash", "grep -c 'pattern' .")),
			assistant(callPart("bash", "rg 'd' .")),
		];
		expect(measureSilentStreak(branch, "rg")).toBe(1);
		// the grep call sits older than the newest rg, so it is no longer the running shape: 0
		expect(measureSilentStreak(branch, "grep")).toBe(0);
	});

	it("counts multiple identical calls inside one assistant message", () => {
		const branch: Entry[] = [
			assistant(callPart("bash", "bun main.ts recall q1"), callPart("bash", "bun main.ts recall q2")),
			assistant(callPart("bash", "bun main.ts recall q3")),
		];
		expect(measureSilentStreak(branch, "bun main.ts recall")).toBe(3);
	});

	it("ignores sibling non-bash tools instead of breaking the streak", () => {
		const branch: Entry[] = [
			assistant(callPart("bash", "rg 'a' .")),
			assistant(callPart("read", "/tmp/x"), callPart("bash", "rg 'b' .")),
			assistant(callPart("bash", "rg 'c' .")),
		];
		expect(measureSilentStreak(branch, "rg")).toBe(3);
	});

	it("ignores malformed or empty commands", () => {
		const branch: Entry[] = [
			assistant(callPart("bash", "cd /only")),
			assistant({ type: "toolCall", id: "x", name: "bash", arguments: {} }),
			assistant(callPart("bash", "rg 'a' .")),
			assistant(callPart("bash", "rg 'b' .")),
		];
		expect(measureSilentStreak(branch, "rg")).toBe(2);
	});

	it("skips non-message entries (custom, model changes)", () => {
		const branch: Entry[] = [
			{ type: "custom", customType: "bash-guard-framing", data: {} },
			{ type: "model_change" },
			assistant(callPart("bash", "rg 'a' .")),
			assistant(callPart("bash", "rg 'b' .")),
		];
		expect(measureSilentStreak(branch, "rg")).toBe(2);
	});
});

describe("STREAK_BLOCK_AT and message", () => {
	it("sits above the replayed normal-session max (28) and below both runaways (222, 402)", () => {
		expect(STREAK_BLOCK_AT).toBe(35);
	});

	it("tells the model both what went wrong and the way out", () => {
		const msg = streakBlockMessage(35);
		expect(msg).toContain("same kind of command");
		expect(msg).toContain("no commentary");
		expect(msg).toContain("one short line");
		expect(msg).toContain("read` tool");
	});
});
