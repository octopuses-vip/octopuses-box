import type { ChatMessage, ChatTool } from "../model/client";

const START = "【本轮动态工具提示开始】";
const END = "【本轮动态工具提示结束】";
const DYNAMIC_HINT = /【本轮动态工具提示开始】[\s\S]*?【本轮动态工具提示结束】/g;

/** 删除引用未挂载工具的能力说明；类别中只开放部分工具时不得宣告完整能力。 */
export function filterToolHint(hint: string, mounted: Set<string>, known: Set<string>): string {
  return hint.split(/(?<=[。；\n])/).filter((sentence) => {
    const names = sentence.match(/\b[a-z][a-z0-9_]*\b/g) ?? [];
    return names.every((name) => !known.has(name) || mounted.has(name));
  }).join("");
}

/** 用本轮工具重建唯一动态提示区，保留静态规则与历史追加的系统说明。 */
export function createConversationPreparer(
  buildHints: (tools: ChatTool[]) => string,
): (conversation: ChatMessage[], tools: ChatTool[]) => ChatMessage[] {
  return (conversation, tools) => {
    const system = conversation.filter((message) => message.role === "system")
      .map((message) => typeof message.content === "string"
        ? message.content.replace(DYNAMIC_HINT, "").trim() : "")
      .filter(Boolean);
    system.push(`${START}\n${buildHints(tools)}\n${END}`);
    return [
      { role: "system", content: system.join("\n\n") },
      ...conversation.filter((message) => message.role !== "system"),
    ];
  };
}
