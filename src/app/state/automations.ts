/** 状态辅助层：automations。不依赖 Store 实例，调用方显式传入上下文。 */
import { writeCacheFile } from "../desktop/cache";
import { type Automation, type AutomationRun } from "../types";

/* ============================ 自动化落盘与读回 ============================ */

/** 运行记录本地保留的条数上限，超出后丢弃最旧的记录 */
export const AUTOMATION_RUN_LIMIT = 50;

/** 校验一条从磁盘读回的自动化任务 */
export function isAutomation(value: unknown): value is Automation {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.name === "string" &&
    typeof item.prompt === "string" &&
    typeof item.projectId === "string" &&
    typeof item.intervalMinutes === "number" &&
    typeof item.enabled === "boolean" &&
    (item.lastRunAt === null || typeof item.lastRunAt === "number")
  );
}

/** 校验一条从磁盘读回的运行记录 */
export function isAutomationRun(value: unknown): value is AutomationRun {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.automationId === "string" &&
    typeof item.name === "string" &&
    (item.trigger === "manual" || item.trigger === "schedule") &&
    typeof item.startedAt === "number" &&
    typeof item.threadId === "string"
  );
}

/**
 * 给一条自动化运行记录补默认值（开发者 Jan）。
 *
 * 运行记录会长期落盘，字段随版本增删，读回时按「缺失即补默认」处理，
 * 这样旧记录不必迁移即可展示；suggestions 补空数组尤其重要，
 * 否则界面层每处渲染建议都要判空。
 */
export function normalizeAutomationRun(run: AutomationRun): AutomationRun {
  return {
    ...run,
    status: run.status ?? "success",
    finishedAt: run.finishedAt ?? run.startedAt,
    error: run.error ?? null,
    // 旧记录没有建议字段：补空数组，避免界面层到处判空
    suggestions: run.suggestions ?? [],
  };
}

/**
 * 给旧任务文件补默认值：`cron` / `timezone` / `nextRunAt` / `threadId` 都是本版新增的可选字段，
 * 老文件里没有，读回时统一补齐——因此**不需要任何迁移脚本**。
 */
export function normalizeAutomation(task: Automation): Automation {
  return {
    ...task,
    kind: task.kind ?? "agent",
    cron: task.cron ?? null,
    timezone: task.timezone ?? null,
    nextRunAt: task.nextRunAt ?? null,
    threadId: task.threadId ?? null,
    // 旧任务文件没有绑定字段：补 null，表示用普通会话运行
    agentId: task.agentId ?? null,
  };
}

/** 解析任务文件；文件缺失返回 null（由调用方写入示例任务），损坏返回空表 */
export function parseAutomations(body: string | null): Automation[] | null {
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAutomation).map(normalizeAutomation);
  } catch {
    return [];
  }
}

/** 解析运行记录文件；缺失或损坏都返回空表 */
export function parseAutomationRuns(body: string | null): AutomationRun[] {
  if (body === null) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAutomationRun).map(normalizeAutomationRun);
  } catch {
    return [];
  }
}

/** 把自动化任务与运行记录写入缓存目录；未配置缓存目录时只在内存里生效 */
export function persistAutomations(cachePath: string | null, tasks: Automation[], runs: AutomationRun[]): void {
  if (!cachePath) return;
  void Promise.allSettled([
    writeCacheFile(cachePath, "automations/tasks.json", JSON.stringify(tasks, null, 2)),
    writeCacheFile(cachePath, "automations/runs.json", JSON.stringify(runs, null, 2)),
  ]);
}
