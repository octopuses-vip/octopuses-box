import type { Message, Thread } from "../app/types";
import type { KnowledgeChunk, KnowledgeMessage, KnowledgeSource, TrainingFormat } from "./types";

/** 函数级说明（开发者 Jan）：执行 contentHash 的单一职责，并返回可供调用方继续处理的结果。 */
export async function contentHash(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 只收录对话正文与已提取的附件文字；思考过程随助手消息记录到 reasoning，供导出评审使用，不进导出正文。 */
export async function conversationSource(thread: Thread, messages: Message[]): Promise<KnowledgeSource> {
  const clean: KnowledgeMessage[] = [];
  for (const message of messages) {
    const text = message.items.flatMap((item) => item.type === "text" && !item.streaming ? [item.text] : []).join("\n");
    const reasoning = message.items.flatMap((item) => item.type === "reasoning" && item.done ? [item.text] : []).join("\n");
    const attachments = message.attachments?.flatMap((item) => item.kind === "file" && item.text
      ? [`[附件：${item.name}]\n${item.text}`] : []) ?? [];
    const content = [text, ...attachments].filter((part) => part.trim()).join("\n\n");
    if (content.trim()) clean.push({ id: message.id, role: message.role, content, ...(reasoning.trim() && message.role === "assistant" ? { reasoning } : {}) });
  }
  const body = clean.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`).join("\n\n");
  return { id: `conversation:${thread.id}`, kind: "conversation", title: thread.title,
    threadId: thread.id, body, messages: clean, updatedAt: Date.now(),
    hash: await contentHash(JSON.stringify([thread.title, clean])) };
}

/** 小块保留重叠，按 Unicode 字符切分，避免截断代理对；远低于 BGE 的 512 token 上限。 */
export function splitKnowledgeText(text: string): string[] {
  const result: string[] = [];
  // 只扫描当前片段的 Unicode 边界，避免为百万字符正文创建完整字符数组。
  for (let start = 0; start < text.length;) {
    let end = start;
    let next = start;
    for (let count = 0; count < 320 && end < text.length; count++) {
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
      if (count === 271) next = end;
    }
    const piece = text.slice(start, end);
    if (piece.trim()) result.push(piece);
    if (end >= text.length) break;
    start = next;
  }
  return result;
}

/** 函数级说明（开发者 Jan）：执行 sourceChunks 的单一职责，并返回可供调用方继续处理的结果。 */
export async function sourceChunks(source: KnowledgeSource): Promise<KnowledgeChunk[]> {
  const sections = source.kind === "conversation" ? source.messages.map((message) => ({ text: message.content, id: message.id }))
    : [{ text: source.body, id: null }];
  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    for (const text of splitKnowledgeText(section.text)) {
      const ordinal = chunks.length;
      chunks.push({ id: `${source.id}:${ordinal}`, sourceId: source.id, messageId: section.id, ordinal, text,
        hash: await contentHash(JSON.stringify([section.id, text])) });
    }
  }
  return chunks;
}

/** 一条会话一行；合并连续同角色片段，跳过未成对开头与未回答的末尾，不伪造文档问答。 */
export function trainingMessages(source: KnowledgeSource): { role: "user" | "assistant"; content: string }[] {
  if (source.kind !== "conversation") return [];
  const result: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of source.messages) {
    if (!message.content.trim() || (!result.length && message.role !== "user")) continue;
    const last = result.at(-1);
    if (last?.role === message.role) last.content += `\n\n${message.content}`;
    else result.push({ role: message.role, content: message.content });
  }
  if (result.at(-1)?.role === "user") result.pop();
  return result;
}

/** 函数级说明（开发者 Jan）：执行 trainingRecord 的单一职责，并返回可供调用方继续处理的结果。 */
export function trainingRecord(source: KnowledgeSource, format: TrainingFormat): object | null {
  const messages = trainingMessages(source);
  if (!messages.length) return null;
  if (format === "sharegpt") return { conversations: messages.map((m) => ({ from: m.role === "user" ? "human" : "gpt", value: m.content })) };
  if (format === "alpaca") return {
    instruction: messages.at(-2)!.content,
    input: messages.slice(0, -2).map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n\n"),
    output: messages.at(-1)!.content,
  };
  return { messages };
}
