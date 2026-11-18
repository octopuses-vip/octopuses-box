import { useCallback } from "react";
import { useAppStore } from "../app/state";
import { useAgentRun, type AgentRunOutcome } from "../hooks/useAgentRun";
import { indexPendingKnowledge } from "../knowledge/indexer";
import { useKnowledgeModel } from "../knowledge/model";
import { appendRunSuggestions } from "./suggestions";

const running = new Map<string, Promise<AgentRunOutcome | null>>();

/** Manual and scheduled runs share the same dispatch and status recording. */
export function useAutomationRunner() {
  const { run } = useAgentRun();
  return useCallback((id: string, trigger: "schedule" | "manual"): Promise<AgentRunOutcome | null> => {
    const state = useAppStore.getState();
    const scope = state.cachePath;
    const task = state.automations.find((item) => item.id === id);
    const key = JSON.stringify([scope, id]);
    const existing = running.get(key);
    if (existing) return existing;
    if (!task) return Promise.resolve(null);
    const request = state.startAutomationRun(id, trigger);
    if (!request) return Promise.resolve(null);

    const handle = (async (): Promise<AgentRunOutcome> => {
      try {
        if (task.kind === "knowledge-index") {
          state.updateAutomationRun(request.runId, { status: "running" });
          if (!scope) throw new Error("未配置知识库缓存目录");
          const model = useKnowledgeModel.getState();
          if (!model.status || model.busy === "checking") await model.refresh();
          const status = useKnowledgeModel.getState();
          if (!status.status?.enabled || !status.status.ready) {
            throw new Error(status.error || "向量模型未启用或尚未准备完成");
          }
          const stats = await indexPendingKnowledge(scope);
          state.updateAutomationRun(request.runId, {
            status: "success",
            finishedAt: Date.now(),
            result: `索引进度 ${stats.indexed}/${stats.chunks} 个分块`,
          });
          return "success";
        }

        const outcome = await run(request.threadId, request.prompt, [], {
          mode: "queue",
          source: "automation",
          automationRunId: request.runId,
        });
        const recorded = useAppStore.getState().automationRuns.find((item) => item.id === request.runId);
        if (recorded?.status === "queued" || recorded?.status === "running") {
          state.updateAutomationRun(request.runId, {
            status: outcome,
            finishedAt: Date.now(),
            error: outcome === "failed" ? "任务未能进入会话执行队列" : null,
          });
        }
        void appendRunSuggestions(request.threadId, request.runId);
        return outcome;
      } catch (error) {
        state.updateAutomationRun(request.runId, {
          status: "failed",
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
        return "failed";
      }
    })().finally(() => { running.delete(key); });
    running.set(key, handle);
    return handle;
  }, [run]);
}
