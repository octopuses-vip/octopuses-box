import type { Message, Thread } from "../app/types";
import { loadStoredSession } from "./sessionRepository";
import { fromStoredConversation, toStoredConversation } from "./sessionDb";

/** Undefined means not loaded, never an empty conversation. All consumers share this distinction. */
export async function sessionMessages(scope: string, id: string, loaded: Message[] | undefined): Promise<Message[]> {
  if (loaded !== undefined) return loaded;
  const record = await loadStoredSession(scope, id);
  if (!record) throw new Error("会话记录不存在，无法读取完整内容");
  return fromStoredConversation(record).messages;
}
/** 函数级说明（开发者 Jan）：执行 sessionSnapshot 的单一职责，并返回可供调用方继续处理的结果。 */
export async function sessionSnapshot(scope: string, thread: Thread, loaded: Message[] | undefined) {
  return toStoredConversation(thread, await sessionMessages(scope, thread.id, loaded));
}
