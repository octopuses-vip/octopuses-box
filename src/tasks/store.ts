import { lazyJSONStorage } from "../app/lazyStorage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type StepStatus = "pending" | "in_progress" | "completed";
export interface PlanStep { step: string; status: StepStatus }
export interface TaskGoal { objective: string; status: "active" | "paused" | "blocked" | "complete"; iterations: number; maxIterations: number; evidence: string }
export interface TaskState { mode: "execute" | "plan"; plan: PlanStep[]; goal: TaskGoal | null }
const EMPTY: TaskState = { mode: "execute", plan: [], goal: null };
export const taskKey = (scope: string | null, threadId: string) => JSON.stringify([scope, threadId]);
interface TaskStore { editorKey: string | null; edit: (key: string | null) => void; tasks: Record<string, TaskState>; patch: (key: string, patch: Partial<TaskState>) => void }
export const useTaskStore = create<TaskStore>()(persist((set) => ({
  tasks: {}, editorKey: null, edit: (key) => set({ editorKey: key }),
  patch: (key, patch) => set((s) => ({ tasks: { ...s.tasks, [key]: { ...(s.tasks[key] ?? EMPTY), ...patch } } })),
}), { name: "octopuses-task-state-v1", storage: lazyJSONStorage(), partialize: (s) => ({ tasks: s.tasks }) }));
export const taskState = (key: string): TaskState => useTaskStore.getState().tasks[key] ?? EMPTY;
/** Validate a bounded plan with at most one step in progress. */
export function validatePlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value) || value.length > 50 || value.length === 0) throw new Error("计划须包含 1–50 个步骤");
  const plan = value.map((v: unknown) => {
    const item = v as Partial<PlanStep> | null;
    if (!item || typeof item.step !== "string" || !item.step.trim() || item.step.length > 2000 || !["pending", "in_progress", "completed"].includes(item.status ?? "")) throw new Error("计划步骤或状态无效");
    return { step: item.step.trim(), status: item.status! };
  });
  if (plan.filter((p) => p.status === "in_progress").length > 1) throw new Error("同时只能有一个进行中的步骤");
  return plan;
}
/** Replace a conversation plan only after validating every step. */
export function updatePlan(key: string, value: unknown): void { useTaskStore.getState().patch(key, { plan: validatePlan(value) }); }
/** Start a bounded persistent goal in execution mode. */
export function setGoal(key: string, objective: string, maxIterations = 50): void {
  if (!objective.trim() || objective.length > 4000) throw new Error("目标须为 1–4000 个字符");
  useTaskStore.getState().patch(key, { mode: "execute", goal: { objective: objective.trim(), status: "active", iterations: 0, maxIterations: Math.max(1, Math.min(250, Math.floor(maxIterations))), evidence: "" } });
}
/** Require completed steps and verification evidence before goal completion. */
export function changeGoal(key: string, status: TaskGoal["status"], evidence = ""): void {
  const s = taskState(key); if (!s.goal) throw new Error("当前没有目标");
  if (status === "complete" && s.goal.status !== "active") throw new Error("仅可验收正在进行的持续目标");
  if (status === "complete" && (!evidence.trim() || s.plan.some((p) => p.status !== "completed"))) throw new Error("完成目标前须完成全部计划步骤并提供验证结果");
  useTaskStore.getState().patch(key, { goal: { ...s.goal, status, evidence } });
}
/** Describe the current mode, plan and active goal to the model. */
export function taskInstruction(key: string, canFinishGoal = true): string {
  const s = taskState(key);
  const goal = s.goal;
  const goalHint = !goal ? "当前是普通任务，完成计划并验证后直接回复结果即可。"
    : goal.status === "complete" ? "持续目标已经验收完成；请按用户当前请求处理，完成本轮工作后直接汇报结果。"
    : goal.status !== "active" ? "持续目标已暂停或等待处理，本轮不进行目标验收。"
    : `持续目标：${goal.objective}。未满足验收条件时继续工作；${canFinishGoal && s.mode === "execute" ? "验证完成后调用 finish_goal 并提供证据。" : "完成工作后汇报验证结果。"}需要用户输入时清楚说明并停止。`;
  return [s.mode === "plan" ? "当前为计划模式。仅调查、澄清和调用 update_plan 建立计划，不修改文件、不执行有副作用的命令。" : "用 update_plan 跟踪复杂任务的步骤与验证进度。",
    s.plan.length ? `当前计划：${JSON.stringify(s.plan)}` : "",
    goalHint].filter(Boolean).join("\n");
}
