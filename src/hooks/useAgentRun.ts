import { generateMemories } from "../memories/generate";
import { messagePlainText } from "../conversation/transcript";
import { journalUpdate } from "../tasks/journal";
import { changeGoal, taskKey, taskState } from "../tasks/store";
import { useCallback } from "react";

import { nextId } from "../app/ids";
import { useAppStore } from "../app/state";
import type {
  MessageAttachment,
  RunStopReason,
} from "../app/types";

/**
 * 一次运行里最多保留几张截图回灌给模型：截图体积大，无限累积会撑爆上下文
 */
import { AgentRequest, AgentRunOptions, AgentRunOutcome, persistRunSnapshot, runSlot, enqueueRequest, stopThreadRun } from "./useAgentRunShared";
import { createAgentExecutor } from "./useAgentExecutor";
import { useMemo } from "react";
export * from "./useAgentRunShared";
/** Agent 运行 Hook：暴露排队、执行与中断入口（开发者 Jan）。 */
export function useAgentRun() {
  const persistFinish = useCallback(
    (threadId: string, prompt: string, status: "done" | "aborted", reason: RunStopReason) => {
      persistRunSnapshot(threadId, prompt, status, runSlot(threadId).startedAt, reason);
    },
    [],
  );

  /**
   * 停止某个会话的运行；不指定会话时停止当前打开的会话。
   *
   * 入参只认字符串会话 id（开发者 Jan）：本函数常被直接挂成按钮回调，React 会把点击事件
   * 当作第一个参数传进来；若不拦住，事件对象会被当成会话 id 去查（并新建）一个空运行槽，
   * 那个槽上的 abort 恒为 null，停止就成了空操作。
   */
  const stop = useCallback((threadId?: string) => {
    const target = typeof threadId === "string" ? threadId : useAppStore.getState().activeThreadId;
    const goalKey = taskKey(useAppStore.getState().cachePath, target);
    if (taskState(goalKey).goal?.status === "active") changeGoal(goalKey, "paused");
    stopThreadRun(target);
  }, []);

  const execute = useMemo(() => createAgentExecutor(persistFinish), [persistFinish]);
  const run = useCallback(
    (
      threadId: string,
      prompt: string,
      attachments: MessageAttachment[],
      options: AgentRunOptions = {},
    ): Promise<AgentRunOutcome> => new Promise((resolve) => {
      const scope = useAppStore.getState().cachePath;
      const requestId = nextId("request");
      const request: AgentRequest = {
        id: requestId,
        threadId,
        prompt,
        attachments,
        source: options.source ?? "user",
        automationRunId: options.automationRunId ?? null,
        regenerateFrom: options.regenerateFrom,
        resolve: (outcome) => {
          const current = useAppStore.getState(); const model = current.modelConfig;
          if (outcome === "success" && model && taskState(taskKey(scope, threadId)).mode !== "plan" && (!taskState(taskKey(scope, threadId)).goal || taskState(taskKey(scope, threadId)).goal?.status === "complete") && !current.messages[threadId]?.at(-1)?.items.some((i) => i.type === "question")) void generateMemories(scope, threadId, current.threads.find((t) => t.id === threadId)?.projectId ?? "", (current.messages[threadId] ?? []).filter((m) => m.role === "user" || m.role === "assistant").map((m) => `${m.role}: ${messagePlainText(m)}`).join("\n"), model).catch((error) => current.showNotice(`记忆提炼失败：${String(error)}`));
          void journalUpdate(scope, requestId, { status: outcome }).catch((error) => useAppStore.getState().showNotice(`任务日志保存失败：${String(error)}`)); resolve(outcome); },
      };
      // 默认模式按「目标会话」是否在运行判定：别的会话在跑不影响本会话直接开跑
      const mode = options.mode ?? (runSlot(threadId).active ? "queue" : "run");
      void journalUpdate(scope, request.id, { threadId, prompt, attachments, status: "queued", createdAt: Date.now() }).then(() => { if (useAppStore.getState().cachePath !== scope) { request.resolve("aborted"); return; } enqueueRequest(request, mode, execute); }).catch((error) => { useAppStore.getState().showNotice(`任务未启动，无法保存恢复日志：${String(error)}`); resolve("failed"); });
    }),
    [execute],
  );

  return { run, stop };
}

