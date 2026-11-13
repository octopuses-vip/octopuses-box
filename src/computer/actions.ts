export type ComputerAction = { action: "click" | "double_click" | "right_click" | "drag" | "scroll" | "type" | "key" | "wait" | "done"; x?: number; y?: number; toX?: number; toY?: number; amount?: number; text?: string; key?: string; reason: string };
export const COMPUTER_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Up", "Down", "Left", "Right", "Cmd+A", "Cmd+C", "Cmd+V", "Cmd+S", "Cmd+F"];
/** 模型输出只允许已知动作与有界参数，坐标以主显示器截图的 0–1 比例表示。 */
export function parseComputerAction(raw: string): ComputerAction {
  const value = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""));
  if (!value || !["click", "double_click", "right_click", "drag", "scroll", "type", "key", "wait", "done"].includes(value.action)
    || typeof value.reason !== "string" || !value.reason.trim()) throw new Error("电脑操作模型返回了无效动作");
  if (["click", "double_click", "right_click", "drag", "scroll"].includes(value.action)) {
    for (const key of value.action === "drag" ? ["x", "y", "toX", "toY"] : ["x", "y"]) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) throw new Error("操作坐标必须在 0–1 之间");
    }
  }
  if (value.action === "scroll" && (!Number.isInteger(value.amount) || !value.amount || Math.abs(value.amount) > 10)) throw new Error("滚动量必须为 -10 到 10 的非零整数");
  if (value.action === "type" && (typeof value.text !== "string" || !value.text.length || value.text.length > 2000)) throw new Error("输入文字必须为 1–2000 字符");
  if (value.action === "key" && !COMPUTER_KEYS.includes(value.key)) throw new Error("不支持的快捷键");
  return value;
}
