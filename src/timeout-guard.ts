/**
 * Pure helper: timeout cap for search commands.
 *
 * Only search commands (`find` / `grep` (any) / `rg` / `du` / `tree`) are time-limited, at 5
 * minutes. Missing `timeout` injects 300s; a larger value is also pulled down to 300; a smaller one
 * is respected (300 is a ceiling, not an override). Non-search commands are left alone.
 *
 * A search program that only filters a pipe (`build 2>&1 | grep -E "FAIL"`) does not count. There the
 * search reads another program's stdout, not a tree, and the pipe's producer is the thing that needs
 * the time: real history had `timeout 600 … pre-commit run --all-files | grep -E "Failed|error"`
 * pulled to 300s and killed mid-run. Only a segment that starts on its own (`;`, `&&`, `||`, newline)
 * is a scan worth capping.
 */

import { parseScanCommands } from "./scan-guard";

/** Hard cap for search commands, in seconds: 5 minutes. */
export const SEARCH_TIMEOUT_SECONDS = 300;

/**
 * Whether the command is a search scan (`find` / any `grep` / `rg` / `du` / `tree`) that does real
 * work rather than filtering another command's output.
 */
export function isSearchCommand(command: string): boolean {
	return parseScanCommands(command).some((scan) => !scan.piped);
}

/**
 * Compute the `timeout` (seconds) to inject or rewrite; null means leave it as is.
 *
 * - Not a search command (or a pipe-fed search filter) → null (hands off).
 * - Search command with `timeout ≤ 300` → null (respect the smaller model-set budget).
 * - Search command missing `timeout` or with `timeout > 300` → 300.
 */
export function searchTimeoutInjection(command: string, input: { timeout?: unknown }): number | null {
	if (!isSearchCommand(command)) return null;
	const existing = typeof input.timeout === "number" ? input.timeout : undefined;
	if (existing !== undefined && existing <= SEARCH_TIMEOUT_SECONDS) return null;
	return SEARCH_TIMEOUT_SECONDS;
}
