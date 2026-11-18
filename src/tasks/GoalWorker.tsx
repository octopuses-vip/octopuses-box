import { useEffect } from "react";
import { useAppStore } from "../app/state";
import { useAgentRun, threadRuns } from "../hooks/useAgentRun";
import { changeGoal, taskKey, taskState, useTaskStore } from "./store";
const running = new Set<string>();
const recovered = new Set<string>();
/** Continue active goals while the client is running; require explicit recovery after restart. */
export function GoalWorker() {
  const { run } = useAgentRun(); const ready = useAppStore((s) => s.sessionsRestored); const scope = useAppStore((s) => s.cachePath);
  const tasks = useTaskStore((s) => s.tasks);
  useEffect(() => {
    if (!ready) return;
    // An interrupted goal needs an explicit resume, never blind replay after restart.
    if (!recovered.has(String(scope))) { recovered.add(String(scope)); for (const t of useAppStore.getState().threads) { const key = taskKey(scope, t.id); if (taskState(key).goal?.status === "active") changeGoal(key, "paused", "客户端已重新启动，请检查后继续目标"); } }
    const tick = () => {
      for (const thread of useAppStore.getState().threads) {
        const key = taskKey(scope, thread.id); const goal = taskState(key).goal;
        if (!goal || goal.status !== "active" || running.has(key) || threadRuns.get(thread.id)?.active || threadRuns.get(thread.id)?.queue.length) continue;
        if (goal.iterations >= goal.maxIterations) { changeGoal(key, "blocked", "已达到目标运行次数上限，请检查进度或调整目标"); continue; }
        running.add(key); useTaskStore.getState().patch(key, { goal: { ...goal, iterations: goal.iterations + 1 } });
        void run(thread.id, `继续完成持续目标：${goal.objective}。检查当前进度，执行下一步并验证；完成后调用 finish_goal，需要用户输入时明确提问。`, []).then((outcome) => {
          const current = taskState(key).goal; if (current?.status !== "active") return;
          const state = useAppStore.getState(); const last = state.messages[thread.id]?.at(-1);
          const asks = last?.items.some((i) => i.type === "question");
          if (outcome !== "success" || asks) changeGoal(key, "blocked", asks ? "等待用户回答" : "运行中断或失败，请处理后继续");
        }).catch((e) => { if (taskState(key).goal?.status === "active") changeGoal(key, "blocked", String(e)); }).finally(() => running.delete(key));
      }
    };
    const timer = window.setInterval(tick, 2500); tick(); return () => window.clearInterval(timer);
  }, [ready, scope, tasks, run]);
  return null;
}
