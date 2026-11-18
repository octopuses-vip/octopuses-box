import { readCacheOptional, writeCacheAtomic } from "../app/desktop/cache";
import type { MessageAttachment } from "../app/types";
export interface DurableRequest { id: string; threadId: string; prompt: string; attachments: MessageAttachment[]; createdAt: number; status: "queued" | "running" | "success" | "failed" | "aborted" | "recovered" }
const queues = new Map<string, Promise<unknown>>();
const FILE = "tasks/run-journal.json";
/** Read accepted requests without treating corruption as an empty journal. */
export async function readJournal(scope: string): Promise<DurableRequest[]> {
  const body = await readCacheOptional(scope, FILE); if (!body) return [];
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("任务日志已损坏，请保留文件并检查");
  return parsed.filter((r): r is DurableRequest => r && typeof r.id === "string" && typeof r.threadId === "string" && typeof r.prompt === "string" && Array.isArray(r.attachments));
}
/** Serialize atomic writes per cache and retain every unfinished request. */
export function journalUpdate(scope: string | null, id: string, patch: Partial<DurableRequest>): Promise<void> {
  if (!scope) return Promise.resolve();
  const task = (queues.get(scope) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const records = await readJournal(scope); const old = records.find((r) => r.id === id);
    const record = { ...old, ...patch, id } as DurableRequest;
    if (!["queued", "running"].includes(record.status)) record.attachments = [];
    if (!record.threadId) return;
    const all = [...records.filter((r) => r.id !== id), record];
    // Never discard unfinished work to enforce a history size limit.
    const pending = all.filter((r) => r.status === "queued" || r.status === "running");
    const settled = all.filter((r) => r.status !== "queued" && r.status !== "running").slice(-200);
    await writeCacheAtomic(scope, FILE, JSON.stringify([...settled, ...pending]));
  });
  queues.set(scope, task); return task;
}
/** Wait for accepted writes before listing requests eligible for recovery. */
export async function pendingRequests(scope: string): Promise<DurableRequest[]> {
  await queues.get(scope); return (await readJournal(scope)).filter((r) => r.status === "running" || r.status === "queued");
}
