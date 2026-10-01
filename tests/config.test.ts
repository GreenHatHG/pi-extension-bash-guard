import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, loadEnvConfig, parseCommandArgs, readPersistedConfig } from "../src/config";

describe("loadEnvConfig", () => {
	test("默认值", () => {
		expect(loadEnvConfig({})).toEqual(DEFAULT_CONFIG);
		expect(DEFAULT_CONFIG.maxBytes).toBe(8192);
		expect(DEFAULT_CONFIG.payloadMaxBytes).toBe(30 * 1024);
	});

	test("合法覆盖生效，非法值忽略", () => {
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

	test("PI_BASH_GUARD_DISABLED 关闭", () => {
		expect(loadEnvConfig({ PI_BASH_GUARD_DISABLED: "1" }).enabled).toBe(false);
		expect(loadEnvConfig({ PI_BASH_GUARD_ENABLED: "0" }).enabled).toBe(false);
		expect(loadEnvConfig({ PI_BASH_GUARD_DISABLED: "0" }).enabled).toBe(true);
	});

	test("0 表示不限字节", () => {
		const cfg = loadEnvConfig({ PI_BASH_GUARD_MAX_BYTES: "0" });
		expect(cfg.maxBytes).toBe(0);
		expect(loadEnvConfig({ PI_BASH_GUARD_PAYLOAD_MAX_BYTES: "0" }).payloadMaxBytes).toBe(0);
	});
});

describe("parseCommandArgs", () => {
	test("空参数切换开关", () => {
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

	test("bytes 设置阈值，0 表示不限制；lines 已被移除", () => {
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

	test("payload 设置载荷阈值，0 表示不限制", () => {
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

	test("preview 支持只改 head 或同时改 head/tail", () => {
		expect(parseCommandArgs("preview 30", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, previewHead: 30 },
		});
		expect(parseCommandArgs("preview 30 5", DEFAULT_CONFIG)).toEqual({
			kind: "config",
			config: { ...DEFAULT_CONFIG, previewHead: 30, previewTail: 5 },
		});
	});

	test("未知参数报错", () => {
		expect(parseCommandArgs("bogus", DEFAULT_CONFIG).kind).toBe("error");
	});
});

describe("readPersistedConfig", () => {
	test("无条目返回 undefined", () => {
		expect(readPersistedConfig([])).toBeUndefined();
	});

	test("取最后一条并用默认值补齐缺失字段", () => {
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
});
