import type { ChatTool } from "../model/client";
import { changeGoal, taskState, updatePlan } from "./store";
export const TASK_TOOLS: ChatTool[] = [
  { type: "function", function: { name: "update_plan", description: "更新任务计划和步骤完成状态，同时只允许一个步骤进行中。", parameters: { type: "object", properties: { plan: { type: "array", items: { type: "object", properties: { step: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["step", "status"], additionalProperties: false } } }, required: ["plan"], additionalProperties: false } } },
  { type: "function", function: { name: "finish_goal", description: "仅用于验收用户已启动且正在进行的持续目标。全部完成并验证后提交证据；普通任务完成计划后直接回复结果。", parameters: { type: "object", properties: { evidence: { type: "string" } }, required: ["evidence"], additionalProperties: false } } },
];
export const PLAN_READ_TOOLS = new Set(["update_plan", "ask_user", "read_file", "search_code", "read_url", "web_search", "knowledge_search", "read_skill", "read_image", "ocr_image", "select_workspace"]);

/** Distinguish ordinary plans from persistent goals, including a goal changed during an ongoing run. */
export function taskToolUnavailableReason(key: string, name: string): string | null {
  if (name !== "finish_goal") return null;
  const task = taskState(key);
  if (!task.goal) return "当前是普通任务，完成计划后直接回复结果即可。";
  if (task.goal.status === "complete") return "持续目标已经验收完成，请直接汇报结果。";
  if (task.goal.status !== "active") return "持续目标已暂停或等待处理，请等待用户继续目标。";
  if (task.mode === "plan") return "当前处于计划模式，确认实施并验证后才能验收持续目标。";
  return null;
}

/** Refresh goal-dependent tool availability before each model request without changing other tools. */
export function filterTaskTools(key: string, tools: ChatTool[]): ChatTool[] {
  return tools.filter((tool) => taskToolUnavailableReason(key, tool.function.name) === null);
}

/** Apply model plan or goal updates and return validation failures as tool results. */
export function runTaskTool(key: string, name: string, raw: string): string {
  const unavailable = taskToolUnavailableReason(key, name);
  if (unavailable) return unavailable;
  try {
    const args = JSON.parse(raw);
    if (name === "update_plan") updatePlan(key, args.plan);
    else if (name === "finish_goal") changeGoal(key, "complete", typeof args.evidence === "string" ? args.evidence : "");
    else throw new Error("未知任务工具");
    return "已更新任务状态";
  }
  catch (error) { return `任务状态更新失败：${String(error)}`; }
}
