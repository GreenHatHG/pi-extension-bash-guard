/**
 * 阈值配置：默认值、环境变量初值、`/bash-guard` 参数解析。
 *
 * 配置通过 `pi.appendEntry(CONFIG_CUSTOM_TYPE, cfg)` 持久化进会话，resume 时从
 * 活动分支重放；环境变量只在会话里没有任何持久化配置时作为初值。
 */

/** 会话条目 customType，用于持久化配置。 */
export const CONFIG_CUSTOM_TYPE = "bash-guard-config";

export interface GuardConfig {
	/** 总开关。关闭后不注入开局提示、不拦截任何输出。 */
	enabled: boolean;
	/** 事前扫描拦截：根目录为 `$HOME`、`/` 或系统目录（`/etc` 等）的 find/grep/rg 直接 block。 */
	scanBlock: boolean;
	/** 过程输出（搜索/列举/转储）的字节阈值。0 = 该档不限制字节；总开关是 `enabled`。 */
	maxBytes: number;
	/**
	 * 高价值载荷类命令（非搜索/列举类）的字节阈值。0 = 该档不限制。
	 * 搜索/列举类用 `maxBytes`，其余用这个更宽的值，避免把模型真正需要的内容
	 * 也逼去「落盘 + 分段读」。两档相互独立。
	 */
	payloadMaxBytes: number;
	/** 预览保留的头部行数。 */
	previewHead: number;
	/** 预览保留的尾部行数。 */
	previewTail: number;
	/** 命令失败（非零退出）时的尾部预览行数，错误通常在尾部，多给几行。 */
	errorPreviewTail: number;
}

export const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	scanBlock: true,
	maxBytes: 8 * 1024,
	payloadMaxBytes: 30 * 1024,
	previewHead: 20,
	previewTail: 15,
	errorPreviewTail: 25,
};

function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 与 positiveInt 相同，但接受 0（0 表示不限制）。 */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isFalsey(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const v = raw.trim().toLowerCase();
	return v === "0" || v === "false" || v === "off" || v === "no";
}

/**
 * 从环境变量构造初值。非法值静默忽略，退回默认值。
 * 支持：PI_BASH_GUARD_DISABLED / PI_BASH_GUARD_ENABLED=0 / PI_BASH_GUARD_SCAN_BLOCK=0 /
 * PI_BASH_GUARD_MAX_BYTES / PREVIEW_HEAD / PREVIEW_TAIL / ERROR_TAIL
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
	const cfg: GuardConfig = { ...DEFAULT_CONFIG };

	const disabled = env.PI_BASH_GUARD_DISABLED;
	if (disabled !== undefined && disabled.trim() !== "" && !isFalsey(disabled)) {
		cfg.enabled = false;
	}
	if (isFalsey(env.PI_BASH_GUARD_ENABLED)) {
		cfg.enabled = false;
	}
	if (isFalsey(env.PI_BASH_GUARD_SCAN_BLOCK)) {
		cfg.scanBlock = false;
	}

	cfg.maxBytes = nonNegativeInt(env.PI_BASH_GUARD_MAX_BYTES, cfg.maxBytes);
	cfg.payloadMaxBytes = nonNegativeInt(env.PI_BASH_GUARD_PAYLOAD_MAX_BYTES, cfg.payloadMaxBytes);
	cfg.previewHead = positiveInt(env.PI_BASH_GUARD_PREVIEW_HEAD, cfg.previewHead);
	cfg.previewTail = positiveInt(env.PI_BASH_GUARD_PREVIEW_TAIL, cfg.previewTail);
	cfg.errorPreviewTail = positiveInt(env.PI_BASH_GUARD_ERROR_TAIL, cfg.errorPreviewTail);

	return cfg;
}

/** `/bash-guard` 参数解析结果。纯数据，不产生副作用。 */
export type CommandParseResult =
	| { kind: "config"; config: GuardConfig }
	| { kind: "status" }
	| { kind: "error"; message: string };

/**
 * 解析 `/bash-guard` 参数。
 *
 * - 空参数：开/关切换
 * - `on` / `off`
 * - `status`
 * - `scan on` / `scan off`
 * - `bytes <n>`（n=0 表示不限制）
 * - `preview <head> [tail]`
 */
export function parseCommandArgs(args: string, current: GuardConfig): CommandParseResult {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return { kind: "config", config: { ...current, enabled: !current.enabled } };
	}

	const [cmd, ...rest] = tokens;
	switch (cmd.toLowerCase()) {
		case "on":
		case "enable":
			return { kind: "config", config: { ...current, enabled: true } };
		case "off":
		case "disable":
			return { kind: "config", config: { ...current, enabled: false } };
		case "status":
			return { kind: "status" };
		case "scan": {
			const value = rest[0]?.toLowerCase();
			if (value === "on" || value === "off") {
				return { kind: "config", config: { ...current, scanBlock: value === "on" } };
			}
			return { kind: "error", message: `scan expects on|off, got: ${rest[0] ?? "(nothing)"}` };
		}
		case "bytes": {
			const n = Number.parseInt(rest[0] ?? "", 10);
			if (!Number.isFinite(n) || n < 0) {
				return {
					kind: "error",
					message: `bytes expects a non-negative integer (0 = unlimited), got: ${rest[0] ?? "(nothing)"}`,
				};
			}
			return { kind: "config", config: { ...current, maxBytes: n } };
		}
		case "payload": {
			const n = Number.parseInt(rest[0] ?? "", 10);
			if (!Number.isFinite(n) || n < 0) {
				return {
					kind: "error",
					message: `payload expects a non-negative integer (0 = unlimited), got: ${rest[0] ?? "(nothing)"}`,
				};
			}
			return { kind: "config", config: { ...current, payloadMaxBytes: n } };
		}
		case "preview": {
			const head = Number.parseInt(rest[0] ?? "", 10);
			if (!Number.isFinite(head) || head < 0) {
				return { kind: "error", message: `preview expects <head> [tail], got: ${rest[0] ?? "(nothing)"}` };
			}
			const tail = rest[1] === undefined ? current.previewTail : Number.parseInt(rest[1], 10);
			if (!Number.isFinite(tail) || tail < 0) {
				return { kind: "error", message: `preview tail must be a non-negative integer, got: ${rest[1]}` };
			}
			return { kind: "config", config: { ...current, previewHead: head, previewTail: tail } };
		}
		default:
			return {
				kind: "error",
				message: `Unknown /bash-guard argument: ${cmd}. Use: on | off | status | scan <on|off> | bytes <n> | payload <n> | preview <head> [tail]`,
			};
	}
}

/** 从会话分支条目里重放最后一次持久化的配置；没有则返回 undefined。 */
export function readPersistedConfig(
	branch: Array<{ type?: string; customType?: string; data?: unknown }>,
): GuardConfig | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "custom" && entry.customType === CONFIG_CUSTOM_TYPE) {
			const data = entry.data as Partial<GuardConfig> | undefined;
			if (!data || typeof data !== "object" || Array.isArray(data)) continue;
			return { ...DEFAULT_CONFIG, ...data };
		}
	}
	return undefined;
}
