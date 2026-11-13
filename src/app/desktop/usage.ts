/** 桌面适配层：usage。运行环境差异在此处理，界面只调用公开函数。 */
import { type UsageRecord, type UsageSummary } from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ 用量记录 ============================ */

/** 浏览器演示环境下的用量镜像：无法写 SQLite，改为在内存里累积，界面同样可读 */
export const browserUsage: UsageRecord[] = [];

/**
 * 写入一次运行的 token 用量（按运行 id 覆盖，重试不重复累计）。
 *
 * 用量是观测数据，写失败只影响统计展示，因此调用方不需要为失败中断主流程。
 */
export async function recordUsage(cachePath: string | null, record: UsageRecord): Promise<void> {
  if (!cachePath) return;
  if (!isDesktopRuntime()) {
    const index = browserUsage.findIndex((item) => item.id === record.id);
    if (index >= 0) browserUsage[index] = record;
    else browserUsage.push(record);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("usage_record", { cacheDir: cachePath, record });
}

/** 汇总用量；两个过滤条件都可省略（省略即不按该维度过滤） */
export async function fetchUsageSummary(
  cachePath: string | null,
  filter: { conversationId?: string; projectId?: string } = {},
): Promise<UsageSummary> {
  const empty: UsageSummary = {
    runs: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    lastAt: null,
  };
  if (!cachePath) return empty;
  if (!isDesktopRuntime()) {
    const matched = browserUsage.filter(
      (item) =>
        (filter.conversationId === undefined || item.conversationId === filter.conversationId)
        && (filter.projectId === undefined || item.projectId === filter.projectId),
    );
    if (matched.length === 0) return empty;
    return {
      runs: matched.length,
      promptTokens: matched.reduce((sum, item) => sum + item.promptTokens, 0),
      completionTokens: matched.reduce((sum, item) => sum + item.completionTokens, 0),
      reasoningTokens: matched.reduce((sum, item) => sum + item.reasoningTokens, 0),
      totalTokens: matched.reduce((sum, item) => sum + item.totalTokens, 0),
      lastAt: matched.reduce((latest, item) => Math.max(latest, item.createdAt), 0),
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UsageSummary>("usage_summary", {
    cacheDir: cachePath,
    conversationId: filter.conversationId ?? null,
    projectId: filter.projectId ?? null,
  });
}
