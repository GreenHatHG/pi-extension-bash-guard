/**
 * Pure helper: timeout cap for search commands.
 *
 * Only search commands (`find` / recursive `grep` / `rg` / `du` / `tree`) are time-limited, at 5
 * minutes. Missing `timeout` injects 300s; a larger value is also pulled down to 300; a smaller one
 * is respected (300 is a ceiling, not an override). Non-search commands are left alone.
 */

import { parseScanCommands } from "./scan-guard";

/** Hard cap for search commands, in seconds: 5 minutes. */
export const SEARCH_TIMEOUT_SECONDS = 300;

/** Whether the command is a search scan (`find` / recursive `grep` / `rg` / `du` / `tree`). */
export function isSearchCommand(command: string): boolean {
	return parseScanCommands(command).length > 0;
}

/**
 * Compute the `timeout` (seconds) to inject or rewrite; null means leave it as is.
 *
 * - Not a search command → null (hands off).
 * - Search command with `timeout ≤ 300` → null (respect the smaller model-set budget).
 * - Search command missing `timeout` or with `timeout > 300` → 300.
 */
export function searchTimeoutInjection(command: string, input: { timeout?: unknown }): number | null {
	if (!isSearchCommand(command)) return null;
	const existing = typeof input.timeout === "number" ? input.timeout : undefined;
	if (existing !== undefined && existing <= SEARCH_TIMEOUT_SECONDS) return null;
	return SEARCH_TIMEOUT_SECONDS;
}
