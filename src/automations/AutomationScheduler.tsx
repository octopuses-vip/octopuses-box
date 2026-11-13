import { useCallback, useEffect, useRef } from "react";

import { exitApp, installAutomationAgents, listenAutomationDue, listenAutomationWake, pruneAutomationAgents, releaseScheduledAutomation, syncAutomationScheduler, takeAutomationWake, type AgentSpec } from "../app/desktop/automation";
import { useAppStore } from "../app/state";
import { useAgentRun, type AgentRunOutcome } from "../hooks/useAgentRun";
import { agentSchedule, nextRunAtForTask } from "./cron";
import { appendRunSuggestions } from "./suggestions";
import { indexPendingKnowledge } from "../knowledge/indexer";
import { useKnowledgeModel } from "../knowledge/model";

/**
 * catch-up 允许补跑的最大错失时长。
 *
 * 应用可能整夜关闭：这段时间里到期的任务只补跑**最近一次**，且错失不超过 6 小时；
 * 超过这个窗口说明任务已经脱离当下语境，只把计划推进到下一个未来时刻，不再补跑。
 */
const CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * 自动化桥接器。
 *
 * 三条触发来源共用同一条运行链路：应用开着时 Rust 进程内调度器广播 `automation-due`；应用关闭
 * 后被系统定时项重新唤起时广播 `automation-wake`（并可从托管状态主动取回）；启动时对「错过的
 * 最近一次」做 catch-up 补跑。同一条任务在任一时刻只会有一轮运行（前端 in-flight 去重 + 运行
 * 记录去重双保险）。
 */
export function AutomationScheduler() {
  const automations = useAppStore((state) => state.automations);
  const automationStatus = useAppStore((state) => state.automationStatus);
  const updateAutomation = useAppStore((state) => state.updateAutomation);
  const { run } = useAgentRun();

  /** 同一任务正在排队/运行的运行句柄：并发触发时复用同一轮，不重复起任务 */
  const inFlight = useRef<Map<string, Promise<AgentRunOutcome | null>>>(new Map());
  /** 已经处理过 catch-up（无论补跑还是跳过）的任务 id */
  const caughtUp = useRef<Set<string>>(new Set());
  /** 已经处理过的唤醒任务 id：事件与主动取回可能同时到达 */
  const handledWake = useRef<Set<string>>(new Set());
  /** 后台定时项最近一次注册的规格签名，避免每次 nextRunAt 变化都重装一遍 */
  const agentSignature = useRef("");

  const runAutomation = useCallback(
    (automationId: string, source: "schedule" | "manual"): Promise<AgentRunOutcome | null> => {
      const existing = inFlight.current.get(automationId);
      if (existing) return existing;

      const request = useAppStore.getState().startAutomationRun(automationId, source);
      if (!request) {
        // 已有排队中的运行记录：本次触发直接放弃，但仍要释放 Rust 侧的 in-flight 标记
        void releaseScheduledAutomation(automationId);
        return Promise.resolve(null);
      }

      const task = useAppStore.getState().automations.find((item) => item.id === automationId);
      if (task?.kind === "knowledge-index") {
        const handle = (async (): Promise<AgentRunOutcome> => {
          useAppStore.getState().updateAutomationRun(request.runId, { status: "running" });
          try {
            const scope = useAppStore.getState().cachePath;
            const model = useKnowledgeModel.getState().status;
            if (!scope) throw new Error("未配置知识库缓存目录");
            if (!model?.enabled || !model.ready) throw new Error("向量模型未启用或尚未准备完成");
            await indexPendingKnowledge(scope);
            useAppStore.getState().updateAutomationRun(request.runId, {
              status: "success",
              finishedAt: Date.now(),
              error: null,
            });
            return "success";
          } catch (error) {
            useAppStore.getState().updateAutomationRun(request.runId, {
              status: "failed",
              finishedAt: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            });
            return "failed";
          }
        })().finally(() => {
          inFlight.current.delete(automationId);
          void releaseScheduledAutomation(automationId);
        });
        inFlight.current.set(automationId, handle);
        return handle;
      }

      const handle = run(request.threadId, request.prompt, [], {
        mode: "queue",
        source: "automation",
        automationRunId: request.runId,
      })
        .then((outcome) => {
          // 建议是附加产出：不阻塞运行结果，失败静默
          void appendRunSuggestions(request.threadId, request.runId);
          return outcome;
        })
        .finally(() => {
          inFlight.current.delete(automationId);
          void releaseScheduledAutomation(automationId);
        });

      inFlight.current.set(automationId, handle);
      return handle;
    },
    [run],
  );

  // 任务快照同步给 Rust（含 nextRunAt）；规格有变化时重新注册系统后台定时项并清理多余项
  useEffect(() => {
    if (automationStatus !== "ready") return;
    void syncAutomationScheduler(automations);

    const specs = automations
      .filter((task) => task.enabled)
      .map((task) => {
        const schedule = agentSchedule(task);
        return schedule ? ({ id: task.id, ...schedule } as AgentSpec) : null;
      })
      .filter((spec): spec is AgentSpec => spec !== null);
    const signature = specs
      .map((spec) => `${spec.id}:${JSON.stringify(spec)}`)
      .sort()
      .join("|");
    if (agentSignature.current === signature) return;
    agentSignature.current = signature;

    void (async () => {
      await installAutomationAgents(specs);
      await pruneAutomationAgents(specs.map((spec) => spec.id));
    })().catch(() => {
      // 定时项注册失败不影响进程内调度，仅在下次任务变化时重试
      agentSignature.current = "";
    });
  }, [automations, automationStatus]);

  // 应用开着时的到点触发
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenAutomationDue((event) => {
      void runAutomation(event.automationId, "schedule");
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runAutomation]);

  // 被系统后台定时项唤起：跑完指定任务后退出，避免留下多余窗口
  useEffect(() => {
    if (automationStatus !== "ready") return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

/** 函数级说明（开发者 Jan）：执行 handleWake 的单一职责，并返回可供调用方继续处理的结果。 */
    const handleWake = (automationId: string) => {
      if (handledWake.current.has(automationId)) return;
      handledWake.current.add(automationId);
      const task = useAppStore.getState().automations.find((item) => item.id === automationId);
      // 任务已被删除或已停用（多半是残留的定时项）：无事可做，直接退出
      if (!task || !task.enabled) {
        void exitApp();
        return;
      }
      void runAutomation(automationId, "schedule").then(() => exitApp());
    };

    void listenAutomationWake((event) => handleWake(event.automationId)).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    // 事件广播发生在应用 setup 阶段，前端可能没接住，这里主动取回一次兜底
    void takeAutomationWake().then((automationId) => {
      if (!disposed && automationId) handleWake(automationId);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [automationStatus, runAutomation]);

  // 启动 catch-up：把关闭期间错过的最近一次补上，之后由调度器接管
  useEffect(() => {
    if (automationStatus !== "ready") return;
    const now = Date.now();
    for (const task of automations) {
      if (!task.enabled || caughtUp.current.has(task.id)) continue;
      const planned = task.nextRunAt;
      if (planned === null || planned > now) continue;
      caughtUp.current.add(task.id);
      if (now - planned <= CATCH_UP_WINDOW_MS) {
        void runAutomation(task.id, "schedule");
      } else {
        // 错失太久：不补跑，只把计划推进到下一个未来时刻
        updateAutomation(task.id, { nextRunAt: nextRunAtForTask(task, now) });
      }
    }
  }, [automations, automationStatus, runAutomation, updateAutomation]);

  return null;
}
