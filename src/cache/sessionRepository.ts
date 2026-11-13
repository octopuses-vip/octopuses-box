import { ensureSessionDb, importLegacySessions, loadStoredConversations, listStoredConversations, getStoredConversation, saveStoredConversation as save, deleteStoredConversation as remove, type StoredConversation } from "../app/desktop/sessions";

const queues = new Map<string, Promise<unknown>>();
/** 函数级说明（开发者 Jan）：执行 enqueue 的单一职责，并返回可供调用方继续处理的结果。 */
function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).then(task);
  const tail = next.catch(() => {});
  queues.set(path, tail);
  void tail.then(() => { if (queues.get(path) === tail) queues.delete(path); });
  return next;
}

/** 函数级说明（开发者 Jan）：执行 saveStoredConversation 的单一职责，并返回可供调用方继续处理的结果。 */
export function saveStoredConversation(path: string | null, record: StoredConversation): Promise<void> {
  return path ? enqueue(path, () => save(path, record)) : Promise.resolve();
}

/** 函数级说明（开发者 Jan）：执行 deleteStoredConversation 的单一职责，并返回可供调用方继续处理的结果。 */
export function deleteStoredConversation(path: string | null, id: string): Promise<void> {
  return path ? enqueue(path, () => remove(path, id)) : Promise.resolve();
}

/** Single conversation storage boundary. JSON is a one-time legacy import, never an active backing store. */
export function loadStoredSession(cachePath: string, id: string) { return enqueue(cachePath, () => getStoredConversation(cachePath, id)); }

/** 函数级说明（开发者 Jan）：执行 restoreStoredSessions 的单一职责，并返回可供调用方继续处理的结果。 */
export function restoreStoredSessions(cachePath: string, readLegacy: () => Promise<StoredConversation[]>, summariesOnly = false): Promise<StoredConversation[]> {
  return enqueue(cachePath, async () => {
    const info = await ensureSessionDb(cachePath);
    if (!info.legacyMigrated) {
      const base = Math.floor(Date.now() / 1000);
      const legacy = info.conversations ? [] : (await readLegacy()).map((record, index) => ({ ...record, createdAt: base - index }));
      await importLegacySessions(cachePath, legacy);
    }
    return summariesOnly ? listStoredConversations(cachePath) : loadStoredConversations(cachePath);
  });
}
