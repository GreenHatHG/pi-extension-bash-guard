/**
 * 纯函数：搜索命令的**超时上限**。
 *
 * 新模式：只有搜索类命令（`find` / 递归 `grep` / `rg` / `du` / `tree`）受时间约束，
 * 最多 5 分钟。缺 `timeout` 就注入 300 秒；模型显式给了更大的值也压到 300；给了更小的值
 * 则尊重（300 是上限，不是覆盖）。非搜索命令一律放行，不做任何 timeout 干预。
 *
 * 早先版本是「缺 timeout 就 block、要求模型显式重发」，且把 `tail -f` / `watch` /
 * 前台 server 等形态也纳入。用户明确改成「搜索封顶五分钟、其余全放开」，故删除那些分支。
 */

import { parseScanCommands } from "./scan-guard";

/** 搜索命令的硬上限（秒）：5 分钟。 */
export const SEARCH_TIMEOUT_SECONDS = 300;

/** 命令是否为搜索类扫描（`find` / 递归 `grep` / `rg` / `du` / `tree`）。 */
export function isSearchCommand(command: string): boolean {
	return parseScanCommands(command).length > 0;
}

/**
 * 计算要注入/覆写的 `timeout`（秒）；无需改动返回 null。
 *
 * - 非搜索命令 → null（完全不管）。
 * - 搜索命令且已有 `timeout ≤ 300` → null（尊重模型更小的显式预算）。
 * - 搜索命令且缺 `timeout` 或 `timeout > 300` → 300。
 */
export function searchTimeoutInjection(command: string, input: { timeout?: unknown }): number | null {
	if (!isSearchCommand(command)) return null;
	const existing = typeof input.timeout === "number" ? input.timeout : undefined;
	if (existing !== undefined && existing <= SEARCH_TIMEOUT_SECONDS) return null;
	return SEARCH_TIMEOUT_SECONDS;
}
