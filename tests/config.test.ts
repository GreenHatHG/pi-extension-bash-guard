import { describe, expect, test } from "vitest";
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

	test("Unknown args error", () => {
		expect(parseCommandArgs("bogus", DEFAULT_CONFIG).kind).toBe("error");
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
