import { describe, expect, test } from "vitest";
import { buildAuditPrompt, sessionDirForCwd, sessionsDir } from "../src/audit";
import { DEFAULT_CONFIG, loadEnvConfig, parseCommandArgs, readPersistedConfig } from "../src/config";

describe("loadEnvConfig", () => {
	test("Defaults", () => {
		expect(loadEnvConfig({})).toEqual(DEFAULT_CONFIG);
		expect(DEFAULT_CONFIG.maxBytes).toBe(8192);
		expect(DEFAULT_CONFIG.payloadMaxBytes).toBe(30 * 1024);
	});

	test("Valid overrides apply, invalid ones are ignored", () => {
		const cfg = loadEnvConfig({
			PI_BASH_GUARD_MAX_BYTES: "16384",
			PI_BASH_GUARD_PAYLOAD_MAX_BYTES: "40960",
			PI_BASH_GUARD_PREVIEW_HEAD: "-3",
			PI_BASH_GUARD_PREVIEW_TAIL: "abc",
		});
		expect(cfg.maxBytes).toBe(16384);
		expect(cfg.payloadMaxBytes).toBe(40960);
		expect(cfg.previewHead).toBe(DEFAULT_CONFIG.previewHead);
		expect(cfg.previewTail).toBe(DEFAULT_CONFIG.previewTail);
	});

	test("PI_BASH_GUARD_DISABLED turns it off", () => {
		expect(loadEnvConfig({ PI_BASH_GUARD_DISABLED: "1" }).enabled).toBe(false);
		expect(loadEnvConfig({ PI_BASH_GUARD_ENABLED: "0" }).enabled).toBe(false);
		expect(loadEnvConfig({ PI_BASH_GUARD_DISABLED: "0" }).enabled).toBe(true);
	});

	test("0 means no byte limit", () => {
		const cfg = loadEnvConfig({ PI_BASH_GUARD_MAX_BYTES: "0" });
		expect(cfg.maxBytes).toBe(0);
		expect(loadEnvConfig({ PI_BASH_GUARD_PAYLOAD_MAX_BYTES: "0" }).payloadMaxBytes).toBe(0);
	});
});

describe("parseCommandArgs", () => {
	test("Empty args toggle the switch", () => {
		expect(parseCommandArgs("", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, enabled: false },
		});
	});

	test("on / off", () => {
		expect(parseCommandArgs("on", { ...DEFAULT_CONFIG, enabled: false })).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, enabled: true },
		});
		expect(parseCommandArgs("off", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, enabled: false },
		});
	});

	test("status", () => {
		expect(parseCommandArgs("status", DEFAULT_CONFIG)).toEqual({ kind: "status" });
	});

	test("bytes sets the limit, 0 means no limit; lines was removed", () => {
		expect(parseCommandArgs("bytes 2048", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, maxBytes: 2048 },
		});
		expect(parseCommandArgs("bytes 0", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, maxBytes: 0 },
		});
		expect(parseCommandArgs("bytes abc", DEFAULT_CONFIG).kind).toBe("error");
		expect(parseCommandArgs("lines 120", DEFAULT_CONFIG).kind).toBe("error");
	});

	test("payload sets the payload limit, 0 means no limit", () => {
		expect(parseCommandArgs("payload 40960", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, payloadMaxBytes: 40960 },
		});
		expect(parseCommandArgs("payload 0", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, payloadMaxBytes: 0 },
		});
		expect(parseCommandArgs("payload abc", DEFAULT_CONFIG).kind).toBe("error");
	});

	test("preview can change head alone or head/tail together", () => {
		expect(parseCommandArgs("preview 30", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, previewHead: 30 },
		});
		expect(parseCommandArgs("preview 30 5", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, previewHead: 30, previewTail: 5 },
		});
	});

	test("hint toggles the opening-injection switch", () => {
		expect(parseCommandArgs("hint off", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, hint: false },
		});
		expect(parseCommandArgs("hint on", { ...DEFAULT_CONFIG, hint: false })).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, hint: true },
		});
		expect(parseCommandArgs("hint maybe", DEFAULT_CONFIG).kind).toBe("error");
		expect(parseCommandArgs("hint", DEFAULT_CONFIG).kind).toBe("error");
	});

	test("PI_BASH_GUARD_HINT=0 seeds hint off", () => {
		expect(loadEnvConfig({ PI_BASH_GUARD_HINT: "0" }).hint).toBe(false);
		expect(loadEnvConfig({ PI_BASH_GUARD_HINT: "1" }).hint).toBe(true);
		expect(loadEnvConfig({}).hint).toBe(true);
	});

	test("Unknown args error", () => {
		expect(parseCommandArgs("bogus", DEFAULT_CONFIG).kind).toBe("error");
	});
});

describe("audit", () => {
	test("session dirs are named by cwd: strip leading slash, map / \\ and : to -, wrap in --", () => {
		expect(sessionDirForCwd("/home/me/proj")).toBe("--home-me-proj--");
		expect(sessionDirForCwd("/")).toBe("----");
		expect(sessionDirForCwd("/home/me/a:b")).toBe("--home-me-a-b--");
		expect(sessionDirForCwd("/home/me/proj/")).toBe("--home-me-proj--");
		expect(sessionDirForCwd("//home//me/proj")).toBe("--home-me-proj--");
	});

	test("sessions dir follows the env overrides, default is ~/.pi/agent/sessions", () => {
		expect(sessionsDir({})).toBe("~/.pi/agent/sessions");
		expect(sessionsDir({ PI_CODING_AGENT_DIR: "/x/.pi" })).toBe("/x/.pi/sessions");
		expect(sessionsDir({ PI_CODING_AGENT_SESSION_DIR: "/custom/sessions" })).toBe("/custom/sessions");
	});

	test("project scope points at the project's session dir; all scope does not", () => {
		const project = buildAuditPrompt({ cwd: "/home/me/proj", scope: "project", env: {} });
		expect(project).toContain("~/.pi/agent/sessions/--home-me-proj--");
		expect(project).toContain("STOP");
		const all = buildAuditPrompt({ cwd: "/home/me/proj", scope: "all", env: {} });
		expect(all).toContain("ALL session directories under ~/.pi/agent/sessions");
		expect(all).not.toContain("--home-me-proj--");
	});

	test("a flat custom session dir is used as-is, not with an encoded-cwd suffix", () => {
		// pi writes <custom-dir>/<timestamp>_<id>.jsonl directly; appending --<cwd>-- names a dir that does not exist
		const env = { PI_CODING_AGENT_SESSION_DIR: "/custom/sessions" };
		const project = buildAuditPrompt({ cwd: "/home/me/proj", scope: "project", env });
		expect(project).toContain("the directory /custom/sessions.");
		expect(project).not.toContain("/custom/sessions/--");

		const all = buildAuditPrompt({ cwd: "/home/me/proj", scope: "all", env });
		expect(all).toContain("/custom/sessions/*.jsonl");
	});

	test("the real session dir from pi wins, and a nested one makes `all` scan its parent", () => {
		const nested = "/root/sessions/--home-me-proj--";
		expect(buildAuditPrompt({ cwd: "/home/me/proj", scope: "project", sessionDir: nested })).toContain(
			"the directory /root/sessions/--home-me-proj--.",
		);
		expect(buildAuditPrompt({ cwd: "/home/me/proj", scope: "all", sessionDir: nested })).toContain(
			"/root/sessions/<dir-encoded-cwd>/*.jsonl",
		);

		const flat = "/root/custom";
		const project = buildAuditPrompt({ cwd: "/home/me/proj", scope: "project", sessionDir: flat });
		expect(project).toContain("the directory /root/custom.");
		expect(project).toContain("/root/custom/*.jsonl");
		expect(buildAuditPrompt({ cwd: "/home/me/proj", scope: "all", sessionDir: flat })).toContain(
			"/root/custom/*.jsonl",
		);
	});

	test("the prompt states the live thresholds, not the defaults", () => {
		const prompt = buildAuditPrompt({
			cwd: "/x",
			scope: "project",
			cfg: { ...DEFAULT_CONFIG, maxBytes: 4096, payloadMaxBytes: 0, previewHead: 7 },
		});
		expect(prompt).toContain("4.0KB for search/list/dump output, no limit for everything else");
		expect(prompt).toContain("preview keeps 7 head");
		expect(prompt).not.toContain("8.0KB");
	});

	test("the prompt lists every guard marker so the agent can grep them", () => {
		const prompt = buildAuditPrompt({ cwd: "/x", scope: "all", env: {} });
		expect(prompt).toContain("[BASH OUTPUT GUARD]");
		expect(prompt).toContain("[BASH SCAN GUARD]");
		expect(prompt).toContain("[LOOP GUARD]");
		expect(prompt).toContain("[ARG GUARD]");
		expect(prompt).toContain("[BASH TIMEOUT GUARD]");
		expect(prompt).toContain("[BASH READ-ONLY FENCE]");
	});

	test("the prompt says only a line-start marker counts, so source-code hits are not counted", () => {
		// Reading this repo's own source/tests prints the marker strings; an audit that greps blindly
		// counted 27 hits in files where only 3 were real interventions.
		const prompt = buildAuditPrompt({ cwd: "/x", scope: "project", env: {} });
		expect(prompt).toContain("a reference, not an intervention");
		const caveat = prompt.split("\n").find((line) => line.includes("a reference, not an intervention"));
		expect(caveat).toContain("begins");
	});

	test("audit defaults to the whole agent history; `audit project` narrows, extras are errors", () => {
		expect(parseCommandArgs("audit", DEFAULT_CONFIG)).toEqual({ kind: "audit", scope: "all" });
		expect(parseCommandArgs("audit all", DEFAULT_CONFIG)).toEqual({ kind: "audit", scope: "all" });
		expect(parseCommandArgs("audit ALL", DEFAULT_CONFIG)).toEqual({ kind: "audit", scope: "all" });
		expect(parseCommandArgs("audit project", DEFAULT_CONFIG)).toEqual({ kind: "audit", scope: "project" });
		expect(parseCommandArgs("audit PROJECT", DEFAULT_CONFIG)).toEqual({ kind: "audit", scope: "project" });
		expect(parseCommandArgs("audit now", DEFAULT_CONFIG).kind).toBe("error");
		expect(parseCommandArgs("audit all extra", DEFAULT_CONFIG).kind).toBe("error");
		expect(parseCommandArgs("audit project extra", DEFAULT_CONFIG).kind).toBe("error");
	});
});

describe("readPersistedConfig", () => {
	test("No entries returns undefined", () => {
		expect(readPersistedConfig([])).toBeUndefined();
	});

	test("Takes the last one and fills missing fields with defaults", () => {
		const branch = [
			{ type: "custom", customType: "bash-guard-config", data: { maxBytes: 1024 } },
			{ type: "message" },
			{ type: "custom", customType: "bash-guard-config", data: { maxBytes: 4096, enabled: false } },
		];
		const cfg = readPersistedConfig(branch);
		expect(cfg?.maxBytes).toBe(4096);
		expect(cfg?.enabled).toBe(false);
		expect(cfg?.previewHead).toBe(DEFAULT_CONFIG.previewHead);
	});

	test("Skips a bad newest config entry and keeps looking for an older valid one", () => {
		const branch = [
			{ type: "custom", customType: "bash-guard-config", data: { maxBytes: 1024 } },
			{ type: "custom", customType: "bash-guard-config", data: null },
		];
		expect(readPersistedConfig(branch)?.maxBytes).toBe(1024);
	});
});
