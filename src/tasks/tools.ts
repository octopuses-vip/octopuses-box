import type { ChatTool } from "../model/client";
import { changeGoal, updatePlan } from "./store";
export const TASK_TOOLS: ChatTool[] = [
  { type: "function", function: { name: "update_plan", description: "更新任务计划和步骤完成状态，同时只允许一个步骤进行中。", parameters: { type: "object", properties: { plan: { type: "array", items: { type: "object", properties: { step: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["step", "status"], additionalProperties: false } } }, required: ["plan"], additionalProperties: false } } },
  { type: "function", function: { name: "finish_goal", description: "目标全部完成并验证后提交验收证据；存在未完成计划时拒绝。", parameters: { type: "object", properties: { evidence: { type: "string" } }, required: ["evidence"], additionalProperties: false } } },
];
export const PLAN_READ_TOOLS = new Set(["update_plan", "ask_user", "read_file", "search_code", "read_url", "web_search", "knowledge_search", "read_skill", "read_image", "ocr_image", "select_workspace"]);
/** Apply model plan or goal updates and return validation failures as tool results. */
export function runTaskTool(key: string, name: string, raw: string): string {
  try { const args = JSON.parse(raw); if (name === "update_plan") updatePlan(key, args.plan); else changeGoal(key, "complete", String(args.evidence ?? "")); return "已更新任务状态"; }
  catch (error) { return `任务状态更新失败：${String(error)}`; }
}
