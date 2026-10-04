/**
 * Limit config: defaults, env-var seeds, and `/bash-guard` argument parsing.
 *
 * Config is saved into the session with `pi.appendEntry(CONFIG_CUSTOM_TYPE, cfg)` and replayed from
 * the active branch on resume; env vars only seed it when the session has no saved config yet.
 */

/** Session entry customType used to save config. */
export const CONFIG_CUSTOM_TYPE = "bash-guard-config";

export interface GuardConfig {
	/** Master switch. When off, no opening hint and no output interception. */
	enabled: boolean;
	/** Pre-scan block: find/grep/rg rooted at `$HOME`, `/`, or a system dir (`/etc`, etc.) is blocked outright. */
	scanBlock: boolean;
	/** Byte limit for process output (search/list/dump). 0 = no limit for this tier. */
	maxBytes: number;
	/**
	 * Byte limit for valuable-payload commands (not search/list). 0 = no limit for this tier.
	 * Search/list uses `maxBytes`; everything else gets this wider value, so content the model needs
	 * isn't pushed into "save to disk + read in slices".
	 */
	payloadMaxBytes: number;
	/** Preview lines kept from the head. */
	previewHead: number;
	/** Preview lines kept from the tail. */
	previewTail: number;
	/** Tail preview lines when the command fails (non-zero exit) — errors are usually at the end, so show more. */
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

/** Same as positiveInt but allows 0 (0 = no limit). */
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
 * Build the starting config from env vars; bad values quietly fall back to defaults.
 * Reads PI_BASH_GUARD_DISABLED / ENABLED / SCAN_BLOCK / MAX_BYTES / PAYLOAD_MAX_BYTES /
 * PREVIEW_HEAD / PREVIEW_TAIL / ERROR_TAIL.
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

/** Result of parsing `/bash-guard` arguments. */
export type CommandParseResult =
	| { kind: "config"; config: GuardConfig }
	| { kind: "status" }
	| { kind: "error"; message: string };

/**
 * Parse `/bash-guard` args: empty toggles on/off; `on`/`off`; `status`; `scan <on|off>`;
 * `bytes <n>`; `payload <n>`; `preview <head> [tail]` (n = 0 means no limit).
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

/** Replay the last saved config from session branch entries, or undefined if there is none. */
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
