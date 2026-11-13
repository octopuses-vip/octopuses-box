import { create } from "zustand";
import type { StoredConversation } from "../app/desktop/sessions";
import { saveStoredConversation, deleteStoredConversation } from "./sessionRepository";
import { WriteQueue, type WriteStatus } from "./writeQueue";

const queues = new Map<string, WriteQueue<() => StoredConversation | Promise<StoredConversation>>>();
const statuses = new Map<string, WriteStatus>();
export const useSessionPersistence = create<WriteStatus & { exitRequested: boolean }>(() => ({ pending: 0, saving: false, error: null, exitRequested: false }));
/** 函数级说明（开发者 Jan）：执行 sessionWrites 的单一职责，并返回可供调用方继续处理的结果。 */
export function sessionWrites(path: string) {
  let queue = queues.get(path);
  if (!queue) {
    queue = new WriteQueue<() => StoredConversation | Promise<StoredConversation>>(async (id, record, isCurrent) => {
      if (!record) return deleteStoredConversation(path, id);
      const snapshot = await record();
      // A lazy read may have waited behind other operations. Never overwrite a newer accepted message.
      if (isCurrent()) await saveStoredConversation(path, snapshot);
    }, (status) => {
      statuses.set(path, status);
      const all = [...statuses.values()];
      useSessionPersistence.setState({ pending: all.reduce((n, s) => n + s.pending, 0), saving: all.some((s) => s.saving), error: all.find((s) => s.error)?.error ?? null });
    });
    queues.set(path, queue);
  }
  return queue;
}
/** 函数级说明（开发者 Jan）：执行 flushSessionWrites 的单一职责，并返回可供调用方继续处理的结果。 */
export async function flushSessionWrites(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.retry()));
  if (useSessionPersistence.getState().pending) return flushSessionWrites();
}
