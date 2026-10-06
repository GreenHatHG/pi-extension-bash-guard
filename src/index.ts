/**
 * pi-extension-bash-guard
 *
 * Three jobs:
 * 1. Inject `[BASH OUTPUT DISCIPLINE]` once at session start, so the model writes bounded output up front.
 * 2. On `tool_call`: block find/grep/rg rooted at `$HOME`, `/`, or a system dir (`/etc`, etc.);
 *    and cap search commands at a 5-minute timeout (missing `timeout` or over 300s both become 300).
 * 3. On `tool_result`: intercept large bash/powershell output and swap in "a few key lines + full-file
 *    path + targeted rewrite hints", nudging the model to rewrite the command.
 *
 * Design rule (same as plan-mode): don't touch systemPrompt, the tool set, or `context` handlers —
 * content swaps are append-only edits at the tail of history, so no prompt-cache rebuild.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessOutput, describeLimit } from "./analyze";
import { classifyCommand } from "./classify";
import { CONFIG_CUSTOM_TYPE, type GuardConfig, loadEnvConfig, parseCommandArgs, readPersistedConfig } from "./config";
import { buildGuardMessage } from "./guard-message";
import { judgeReadOnlyCommand, MODE_ENV, READ_ONLY_MODE, readOnlyMode } from "./read-only";
import { detectBlockedScan } from "./scan-guard";
import { isSearchCommand, SEARCH_TIMEOUT_SECONDS, searchTimeoutInjection } from "./timeout-guard";

/** Status bar key. */
const STATUS_KEY = "bash-guard";
/** customType for the opening discipline message and config persistence. */
const FRAMING_CUSTOM_TYPE = "bash-guard-framing";
/** Tools the guard watches. */
const GUARDED_TOOLS = new Set(["bash", "powershell"]);
/** Cap on the intercepted-command set; clear it when full so it can't grow forever. */
const MAX_TRACKED_COMMANDS = 200;
/** Marker for pi's bash timeout error (e.g. `Command timed out after 600 seconds`). */
const TIMEOUT_SIGNAL = /timed out after \d+ seconds/i;
/**
 * Hint added when we hit a timeout and output is small (so the size guard never fired).
 *
 * Search commands only: we silently cap those at 300s and the model can't see that edit. Other
 * timeouts come from a `timeout` the model or user set, and pi's own error is enough.
 */
const TIMEOUT_HINT =
	"[BASH TIMEOUT GUARD] Search commands are capped at 300s by bash-guard. Raising the timeout past 300s won't help — the cap is re-applied " +
	"(a smaller explicit timeout is honored). This scan was killed mid-run, so its results may be incomplete. Narrow it instead: " +
	"`rg -l <pattern> <dir>` with `-g '!**/node_modules/**'` exclusions (a trailing `| grep -v dir` still reads every file), or use `mdfind -name`.";

/** Normalize a command so "same command again" can be detected. */
export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/** The output-discipline text injected at session start. */
export function buildDisciplineText(cfg: GuardConfig, readOnly = false): string {
	const exhaustLimit = describeLimit({ maxBytes: cfg.maxBytes });
	const payloadLimit = describeLimit({ maxBytes: cfg.payloadMaxBytes });
	const timeoutLine =
		"Search commands (`find`, recursive `grep`, `rg`, `du`, `tree`) are capped at 5 minutes (300 seconds) automatically; " +
		"scans rooted at `$HOME`, `/`, or a system directory like `/etc` are blocked before they run. " +
		"Everything else runs with no timeout guard — pass an explicit `timeout` for anything that can hang (log follow, foreground servers).";
	const fenceLines = readOnly
		? [
				"",
				"[READ-ONLY SESSION] This session is fenced to read-only bash: every command is checked before it runs, and " +
					"anything that writes, deletes, installs, builds, tests, or reaches the network is blocked with a " +
					"`[BASH READ-ONLY FENCE]` reason. Read files with the `read` tool; use the recall CLI for session history; " +
					"keep shell checks to bounded, read-only commands (`rg -l`, `sed -n`, `head`, `tail`, `wc`, `git log/show/diff`, `tmux capture-pane`). " +
					"Two things that look harmless are blocked on purpose: anything that hands the command to another " +
					"program (a wrapper like `sudo`/`env`/`xargs`, `rg --pre`, an interpreter), and `enclave`/`unboxexec` " +
					"(a sandbox privilege channel, not a read-only command).",
			]
		: [];
	return [
		"[BASH OUTPUT DISCIPLINE]",
		`An extension guards shell output. Search/listing/dump commands (e.g. \`rg\`, recursive \`grep\`, \`find\`, \`ls -R\`, ` +
			`\`env\`, \`ps\`, \`git log\`) are capped at ${exhaustLimit}; other commands are capped at ${payloadLimit}. ` +
			"Above the cap, the result is replaced with a short preview, the error/warning lines, and a path to the full output. " +
			"Guarded results are marked `[BASH OUTPUT GUARD]`. Treat it as a nudge to rewrite the command, or to read the file, not as a failure.",
		"",
		"Bound output before you run:",
		"- Content search: use the `grep` tool (`limit` caps matches; it respects .gitignore). In bash, `rg -l` lists matching files only, `-c` counts per file, `-m 5` caps matches per file. Never scan a huge tree unbounded.",
		"- Read files: use the `read` tool with offset/limit. For spot checks use `sed -n '1,80p' <file>` or `head -n 80 <file>` — not `cat`.",
		"- Logs/lists: `tail -n 50`, `git log --oneline -n 20`, `git diff --stat`, `ls | head`.",
		"- Aggregate first: `| wc -l`, `| sort | uniq -c`, `-q`/`--quiet`/`-s`. Write big output to a file, then read/grep it selectively.",
		"",
		timeoutLine,
		...fenceLines,
	].join("\n");
}

interface OutputTruncation {
	truncated?: boolean;
	totalLines?: number;
	totalBytes?: number;
}

interface OutputDetails {
	truncation?: OutputTruncation;
	fullOutputPath?: string;
}

interface TempStorage {
	dir?: string;
	dirPromise?: Promise<string>;
	nextFile: number;
}

/** Reuse the built-in truncation file when present; otherwise write the text to our own temp file. */
async function resolveFullOutputPath(
	text: string,
	details: OutputDetails | undefined,
	builtinTruncated: boolean,
	tempDirs: Set<string>,
	storage: TempStorage,
): Promise<string> {
	if (builtinTruncated && details?.fullOutputPath) return details.fullOutputPath;
	try {
		if (!storage.dir) {
			if (!storage.dirPromise) {
				storage.dirPromise = mkdtemp(join(tmpdir(), "pi-bash-guard-")).then((dir) => {
					storage.dir = dir;
					tempDirs.add(dir);
					return dir;
				});
			}
			await storage.dirPromise;
		}
		const file = join(storage.dir as string, `output-${storage.nextFile++}.txt`);
		await writeFile(file, text, "utf8");
		return file;
	} catch {
		return details?.fullOutputPath ?? "(temporary file unavailable)";
	}
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	let cfg = loadEnvConfig();
	let hitCount = 0;
	let exhaustHits = 0;
	/** Fence hits: kept apart from output-guard hits, they mean different things. */
	let fenceHits = 0;
	let framingDelivered = false;
	let escalationWarningDelivered = false;
	const guardedCommands = new Set<string>();
	const tempDirs = new Set<string>();
	const tempStorage: TempStorage = { nextFile: 0 };

	function persistConfig(): void {
		try {
			pi.appendEntry(CONFIG_CUSTOM_TYPE, { ...cfg });
		} catch {
			// Save failure isn't fatal: config is still right in this process, just lost on resume
		}
	}

	function updateStatus(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		const mode = readOnlyMode();
		try {
			// In a fenced process the mode matters even when the output guard is off, so show it either way
			if (!cfg.enabled && mode === undefined) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const label = mode === undefined ? "🛡 bash-guard" : mode === READ_ONLY_MODE ? "🛡 read-only" : `🛡 ${mode}`;
			const hits = mode === undefined ? hitCount : fenceHits;
			ctx.ui.setStatus(STATUS_KEY, hits > 0 ? `${label} ×${hits}` : label);
		} catch {
			// No-UI setups like print mode: ignore
		}
	}

	// ── Session restore: replay config and framing latch, reset counters ───────────
	pi.on("session_start", (_event, ctx) => {
		hitCount = 0;
		exhaustHits = 0;
		fenceHits = 0;
		framingDelivered = false;
		escalationWarningDelivered = false;
		tempStorage.dir = undefined;
		tempStorage.dirPromise = undefined;
		tempStorage.nextFile = 0;
		guardedCommands.clear();
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		const persisted = readPersistedConfig(branch);
		cfg = persisted ?? loadEnvConfig();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
			if (entry?.type === "custom" && entry.customType === FRAMING_CUSTOM_TYPE) {
				framingDelivered = (entry.data as { delivered?: boolean } | undefined)?.delivered === true;
				break;
			}
		}
		updateStatus(ctx);
	});

	// ── Opening soft hint: inject once, cache-safe ────────────────────────────────
	pi.on("before_agent_start", () => {
		// A fenced process always needs the notice, even if the output guard is off
		const mode = readOnlyMode();
		if ((!cfg.enabled && mode === undefined) || framingDelivered) return;
		framingDelivered = true;
		try {
			pi.appendEntry(FRAMING_CUSTOM_TYPE, { delivered: true });
		} catch {
			// Ignore: the next resume just re-injects the discipline text, harmless
		}
		return {
			message: {
				customType: FRAMING_CUSTOM_TYPE,
				content: buildDisciplineText(cfg, mode === READ_ONLY_MODE),
				display: false,
			},
		};
	});

	// Compaction can drop the earlier custom message; re-inject on the next agent run.
	pi.on("session_compact", () => {
		framingDelivered = false;
	});

	// ── Pre-run block: fence the command, then block unbounded scans, then cap search timeouts ──
	pi.on("tool_call", (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const input = event.input as { command?: unknown; timeout?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";

		// Read-only fence runs first: a denied command should never reach the output guard's logic.
		// It is env-driven, so it applies even if the output guard itself is switched off.
		const mode = readOnlyMode();
		if (mode !== undefined) {
			if (mode !== READ_ONLY_MODE) {
				// Unknown mode value means the injection is broken; fail closed instead of handing out bash
				return {
					block: true,
					reason: `[BASH READ-ONLY FENCE] unknown ${MODE_ENV}="${mode}"; all bash is blocked until it is fixed.`,
				};
			}
			if (command !== "") {
				const verdict = judgeReadOnlyCommand(command);
				if (!verdict.ok) {
					fenceHits++;
					updateStatus(ctx);
					return { block: true, reason: `[BASH READ-ONLY FENCE] ${verdict.reason}` };
				}
			}
		}

		if (!cfg.enabled) return;
		if (command === "") return;

		if (cfg.scanBlock) {
			const hit = detectBlockedScan(command, { home: homedir() });
			if (hit) {
				try {
					ctx.ui.notify(`Blocked unbounded scan: ${hit.tool} → ${hit.root}`, "warning");
				} catch {
					// No-UI setup: ignore
				}
				return { block: true, reason: hit.reason };
			}
		}

		// Cap search commands at 5 minutes: pi's `tool_call` input is mutable, so rewrite `timeout` in place.
		// Missing `timeout` or over 300s both become 300; a smaller model-set value is kept.
		const injection = searchTimeoutInjection(command, input ?? {});
		if (injection !== null && input) {
			const had = typeof input.timeout === "number" ? input.timeout : undefined;
			input.timeout = injection;
			if (had !== undefined && had > SEARCH_TIMEOUT_SECONDS) {
				try {
					ctx.ui.notify(`Capped search timeout ${had}s → ${injection}s`, "warning");
				} catch {
					// No-UI setup: ignore
				}
			}
		}
		return;
	});

	// ── Hard block when over the limit ────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled) return;
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const textParts = event.content.filter((part) => part.type === "text");
		if (textParts.length === 0) return;
		const text = textParts.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		const input = event.input as { command?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";

		const commandClass = classifyCommand(command);
		// Process output uses the tight limit (maxBytes); everything else uses the wide payload limit.
		// Each tier is separate: either 0 means no byte limit for that tier; the master switch is `cfg.enabled`.
		const effectiveLimit = commandClass === "exhaust" ? cfg.maxBytes : cfg.payloadMaxBytes;
		const details = event.details as OutputDetails | undefined;
		const truncation = details?.truncation;
		const builtinTruncated = truncation?.truncated === true;
		const measuredAssessment = assessOutput(text, { maxBytes: effectiveLimit });
		const assessment =
			builtinTruncated && typeof truncation.totalLines === "number" && typeof truncation.totalBytes === "number"
				? {
						...measuredAssessment,
						exceeded: effectiveLimit > 0 && truncation.totalBytes > effectiveLimit,
						totalLines: truncation.totalLines,
						totalBytes: truncation.totalBytes,
					}
				: measuredAssessment;
		if (!assessment.exceeded) {
			// Timeout errors are usually tiny, so the size limit misses them; only our silently-capped search commands need the hint.
			if (event.isError && TIMEOUT_SIGNAL.test(text) && isSearchCommand(command)) {
				return { content: [{ type: "text" as const, text: `${text}\n\n${TIMEOUT_HINT}` }] };
			}
			return;
		}

		const fullPath = await resolveFullOutputPath(text, details, builtinTruncated, tempDirs, tempStorage);

		// Only process output gets repeat and escalation warnings; re-reading valuable payload is fine.
		let repeatCommand = false;
		let showEscalationWarning = false;
		if (commandClass === "exhaust") {
			const normalized = normalizeCommand(command);
			repeatCommand = normalized !== "" && guardedCommands.has(normalized);
			if (normalized !== "") {
				if (guardedCommands.size >= MAX_TRACKED_COMMANDS) guardedCommands.clear();
				guardedCommands.add(normalized);
			}
			exhaustHits++;
			showEscalationWarning = exhaustHits >= 3 && !escalationWarningDelivered;
			if (showEscalationWarning) escalationWarningDelivered = true;
		}
		hitCount++;
		updateStatus(ctx);

		const guardText = buildGuardMessage({
			text,
			assessment,
			command,
			commandClass,
			fullPath,
			builtinTruncated,
			isError: event.isError,
			cfg,
			escalationCount: exhaustHits,
			showEscalationWarning,
			repeatCommand,
		});

		return { content: [{ type: "text" as const, text: guardText }] };
	});

	// ── /bash-guard config command ─────────────────────────────────────────────────
	pi.registerCommand("bash-guard", {
		description:
			"Toggle or configure the bash output guard (on | off | status | scan <on|off> | bytes <n> | payload <n> | preview <head> [tail])",
		handler: async (args, ctx) => {
			const result = parseCommandArgs(args, cfg);
			if (result.kind === "error") {
				ctx.ui.notify(result.message, "error");
				return;
			}
			if (result.kind === "status") {
				const mode = readOnlyMode();
				const fenceLine =
					mode === undefined
						? "readonly fence: off (PI_BASH_GUARD_MODE not set)"
						: mode === READ_ONLY_MODE
							? `readonly fence: on (advisor allow list); blocked ${fenceHits}`
							: `readonly fence: UNKNOWN mode "${mode}" -> all bash blocked (fail-closed)`;
				ctx.ui.notify(
					`bash-guard: ${cfg.enabled ? "on" : "off"}; exhaust limit ${describeLimit({ maxBytes: cfg.maxBytes })}; ` +
						`payload ${describeLimit({ maxBytes: cfg.payloadMaxBytes })}; scan-block ${cfg.scanBlock ? "on" : "off"}; ` +
						`preview head ${cfg.previewHead} / tail ${cfg.previewTail} (errors ${cfg.errorPreviewTail}); hits ${hitCount}; ${fenceLine}`,
					"info",
				);
				return;
			}
			cfg = result.config;
			persistConfig();
			updateStatus(ctx);
			ctx.ui.notify(
				cfg.enabled
					? `bash-guard on: exhaust ${describeLimit({ maxBytes: cfg.maxBytes })} / payload ${describeLimit({ maxBytes: cfg.payloadMaxBytes })}`
					: "bash-guard off",
				"info",
			);
		},
	});

	// ── Clean up temp dirs we created ─────────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		const dirs = [...tempDirs];
		tempDirs.clear();
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
	});
}
