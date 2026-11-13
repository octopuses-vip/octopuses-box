/** automations 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { localTimezone, nextRunAtForTask } from "../../../automations/cron";
import { DEFAULT_KNOWLEDGE_INDEX_AUTOMATION, SAMPLE_AUTOMATIONS } from "../../../automations/samples";
import { readCacheFile } from "../../desktop/cache";
import { nextId } from "../../ids";
import { type Automation, type AutomationRun } from "../../types";
import {
  parseAutomations,
  parseAutomationRuns,
  persistAutomations,
  AUTOMATION_RUN_LIMIT,
} from "../automations";

export const createAutomationsSlice: StoreSlice<
  | "automations"
  | "automationRuns"
  | "automationStatus"
  | "automationError"
  | "loadAutomations"
  | "createAutomation"
  | "updateAutomation"
  | "toggleAutomation"
  | "removeAutomation"
  | "disableAllAutomations"
  | "startAutomationRun"
  | "updateAutomationRun"
> = (set, get) => ({
  automations: [],

  automationRuns: [],

  automationStatus: "idle",

  automationError: null,

  loadAutomations: async () => {
    set({ automationStatus: "loading", automationError: null });
    try {
      const cachePath = get().cachePath;
      if (!cachePath) {
        set({ automations: [], automationRuns: [], automationStatus: "ready" });
        return;
      }
      const stored = parseAutomations(
        await readCacheFile(cachePath, "automations/tasks.json"),
      );
      const runs = parseAutomationRuns(
        await readCacheFile(cachePath, "automations/runs.json"),
      );
      // 首次使用写入示例任务；已有用户补入新的本地向量化任务，避免升级后缺少默认计划。
      const automations = stored
        ? stored.some((item) => item.id === DEFAULT_KNOWLEDGE_INDEX_AUTOMATION.id)
          ? stored
          : [...stored, DEFAULT_KNOWLEDGE_INDEX_AUTOMATION]
        : SAMPLE_AUTOMATIONS;
      set({ automations, automationRuns: runs, automationStatus: "ready" });
      if (stored === null || automations.length !== stored.length) persistAutomations(get().cachePath, automations, runs);
    } catch (error) {
      set({
        automationStatus: "error",
        automationError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  createAutomation: (input) => {
    const task: Automation = {
      id: nextId("auto"),
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      projectId: input.projectId,
      intervalMinutes: input.intervalMinutes,
      cron: input.cron?.trim().length ? input.cron.trim() : null,
      timezone: localTimezone(),
      // 新建后默认停用：先看清任务内容再启用，避免手滑立刻消耗模型额度
      enabled: false,
      // 未启用的任务不排程，启用时再算第一个未来时刻
      nextRunAt: null,
      threadId: null,
      agentId: input.agentId ?? null,
      lastRunAt: null,
    };
    const automations = [task, ...get().automations];
    set({ automations });
    persistAutomations(get().cachePath, automations, get().automationRuns);
  },

  updateAutomation: (id, patch) => {
    const automations = get().automations.map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    set({ automations });
    // 改了 Agent 绑定时把已复用会话的绑定一并跟上，否则下一轮仍会跑旧 Agent
    if (patch.agentId !== undefined) {
      const task = automations.find((item) => item.id === id);
      if (task?.threadId) {
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === task.threadId ? { ...thread, agentId: task.agentId } : thread,
          ),
        }));
      }
    }
    persistAutomations(get().cachePath, automations, get().automationRuns);
  },

  toggleAutomation: (id) => {
    const target = get().automations.find((item) => item.id === id);
    if (!target) return;
    const enabled = !target.enabled;
    // 启用即把计划时间设为「下一个未来时刻」：否则刚打开应用就会立刻补跑一轮
    get().updateAutomation(id, {
      enabled,
      nextRunAt: enabled ? nextRunAtForTask(target, Date.now()) : null,
    });
  },

  removeAutomation: (id) => {
    const automations = get().automations.filter((item) => item.id !== id);
    set({ automations });
    persistAutomations(get().cachePath, automations, get().automationRuns);
  },

  disableAllAutomations: () => {
    const automations = get().automations.map((item) => ({
      ...item,
      enabled: false,
      nextRunAt: null,
    }));
    set({ automations });
    persistAutomations(get().cachePath, automations, get().automationRuns);
  },

  startAutomationRun: (id, trigger) => {
    const state = get();
    const task = state.automations.find((item) => item.id === id);
    if (!task) return null;
    const duplicate = state.automationRuns.some(
      (run) => run.automationId === id && (run.status === "queued" || run.status === "running"),
    );
    if (duplicate) return null;
    // 复用既有会话：首轮创建线程并回写 threadId，之后每轮接在同一线程里。
    // 线程可能已被用户删除，此时按新会话处理，避免往不存在的会话里排队。
    const reusable =
      task.threadId !== null && state.threads.some((thread) => thread.id === task.threadId);
    const threadId =
      reusable && task.threadId !== null
        ? task.threadId
        : state.createThread(task.name, task.projectId, trigger === "manual", task.agentId);
    const startedAt = Date.now();
    const record: AutomationRun = {
      id: nextId("run"),
      automationId: task.id,
      name: task.name,
      trigger,
      startedAt,
      status: "queued",
      finishedAt: null,
      error: null,
      threadId,
      suggestions: [],
    };
    const automationRuns = [record, ...state.automationRuns].slice(0, AUTOMATION_RUN_LIMIT);
    const automations = state.automations.map((item) =>
      item.id === id
        ? {
          ...item,
          threadId,
          lastRunAt: startedAt,
          // 触发即推进计划时间：进程内 tick 与系统定时项都不会重复触发这一轮
          nextRunAt: nextRunAtForTask(item, startedAt),
        }
        : item,
    );
    set({ automations, automationRuns });
    persistAutomations(get().cachePath, automations, automationRuns);
    return { threadId, runId: record.id, prompt: task.prompt };
  },

  updateAutomationRun: (runId, patch) => {
    const automationRuns = get().automationRuns.map((run) =>
      run.id === runId ? { ...run, ...patch } : run,
    );
    set({ automationRuns });
    persistAutomations(get().cachePath, get().automations, automationRuns);
  }
});
