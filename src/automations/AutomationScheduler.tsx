import { useEffect, useRef, useState } from "react";
import {
  exitApp, installAutomationAgents, listenAutomationDue, pruneAutomationAgents,
  releaseScheduledAutomation, syncAutomationScheduler, takeAutomationWake, type AgentSpec,
} from "../app/desktop/automation";
import { useAppStore } from "../app/state";
import { flushAutomationWrites } from "../app/state/automations";
import { agentSchedule, nextRunAtForTask } from "./cron";
import { useAutomationRunner } from "./useAutomationRunner";

const CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000;
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Run a cold wake once. An already open client uses its existing due-time scheduler. */
export function AutomationScheduler() {
  const scope = useAppStore((state) => state.cachePath);
  const automations = useAppStore((state) => state.automations);
  const automationStatus = useAppStore((state) => state.automationStatus);
  const sessionsRestored = useAppStore((state) => state.sessionsRestored);
  const modelLoading = useAppStore((state) => state.modelConfigStatus === "loading");
  const runAutomation = useAutomationRunner();
  const wakeRequest = useRef<Promise<string | null> | null>(null);
  const handledWake = useRef(false);
  const caughtUp = useRef(new Set<string>());
  const agentSignature = useRef<string | null>(null);
  const agentSync = useRef<Promise<void>>(Promise.resolve());
  const [interactive, setInteractive] = useState(false);
  const [listening, setListening] = useState(false);
  const ready = automationStatus === "ready" && sessionsRestored && !modelLoading;

  useEffect(() => {
    if (!ready || handledWake.current) return;
    let active = true;
    wakeRequest.current ??= takeAutomationWake();
    void wakeRequest.current.then(async (id) => {
      if (!active || handledWake.current) return;
      handledWake.current = true;
      if (!id) {
        setInteractive(true);
        return;
      }
      await runAutomation(id, "schedule");
      await flushAutomationWrites(scope);
      await exitApp();
    }).catch((error) => {
      if (!active && !handledWake.current) return;
      useAppStore.setState({ automationScheduleError: `唤起任务失败：${describeError(error)}` });
      setInteractive(true);
    });
    return () => { active = false; };
  }, [ready, scope, runAutomation]);

  useEffect(() => {
    if (!interactive) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenAutomationDue(({ automationId }) => {
      void (async () => {
        try {
          const task = useAppStore.getState().automations.find((item) => item.id === automationId);
          if (task?.enabled && task.nextRunAt !== null && task.nextRunAt <= Date.now()) {
            await runAutomation(automationId, "schedule");
          }
        } finally {
          await releaseScheduledAutomation(automationId);
        }
      })().catch((error) => {
        useAppStore.setState({ automationScheduleError: `处理到期任务失败：${describeError(error)}` });
      });
    }).then((dispose) => {
      if (!active) { dispose(); return; }
      unlisten = dispose;
      setListening(true);
    }).catch((error) => {
      if (active) useAppStore.setState({ automationScheduleError: `监听定时任务失败：${describeError(error)}` });
    });
    return () => { active = false; unlisten?.(); };
  }, [interactive, runAutomation]);

  useEffect(() => {
    if (!ready || !listening) return;
    const now = Date.now();
    for (const task of automations) {
      const key = JSON.stringify([scope, task.id]);
      if (!task.enabled || caughtUp.current.has(key)) continue;
      caughtUp.current.add(key);
      if (task.nextRunAt === null || task.nextRunAt > now) continue;
      if (now - task.nextRunAt <= CATCH_UP_WINDOW_MS) void runAutomation(task.id, "schedule");
      else useAppStore.getState().updateAutomation(task.id, { nextRunAt: nextRunAtForTask(task, now) });
    }
    void syncAutomationScheduler(useAppStore.getState().automations).catch((error) => {
      useAppStore.setState({ automationScheduleError: `应用内调度同步失败：${describeError(error)}` });
    });

    const specs: AgentSpec[] = [];
    for (const task of automations) {
      const schedule = task.enabled ? agentSchedule(task) : null;
      if (schedule) specs.push({ id: task.id, ...schedule });
    }
    const signature = JSON.stringify([scope, specs]);
    if (agentSignature.current === signature) return;
    agentSignature.current = signature;

    agentSync.current = agentSync.current.then(async () => {
      if (agentSignature.current !== signature) return;
      await installAutomationAgents(specs);
      if (agentSignature.current !== signature) return;
      await pruneAutomationAgents(specs.map((spec) => spec.id));
      if (agentSignature.current === signature) useAppStore.setState({ automationScheduleError: null });
    }).catch((error) => {
      if (agentSignature.current !== signature) return;
      agentSignature.current = null;
      useAppStore.setState({ automationScheduleError: `系统定时注册失败：${describeError(error)}` });
    });
  }, [automations, listening, ready, runAutomation, scope]);

  return null;
}
