import { readCacheFile } from "../app/desktop/cache";
import { writeAudioCheckpoint } from "../app/desktop/audioSegments";
import type { ModelConnection } from "../app/desktop/connectionTypes";
import type { NativeAudioFile } from "./files";

export interface TranscriptionOptions { cachePath?: string | null; scope?: string }
interface Checkpoint { count: number; texts: (string | null)[] }
const memory = new Map<string, Checkpoint>();
const locks = new Map<string, Promise<void>>();

/** The source revision, service, model and account all participate; credentials never enter storage. */
export async function checkpointKey(file: NativeAudioFile, connection: ModelConnection, scope = ""): Promise<string> {
  const data = JSON.stringify(["audio-stream-v1", file.contentKey, connection.url, connection.modelId, scope]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Persist only completed segment text; temporary-cache cleanup also removes resume records. */
export async function saveCheckpoint(key: string, value: Checkpoint, cachePath?: string | null): Promise<void> {
  const snapshot = { count: value.count, texts: [...value.texts] };
  if (!cachePath) memory.set(key, snapshot);
  if (cachePath) {
    try { await writeAudioCheckpoint(cachePath, key, JSON.stringify(snapshot)); }
    catch { throw new Error("无法保存转写进度，请检查缓存目录权限和磁盘空间。"); }
  }
}

/** Ignore incomplete/corrupt records rather than presenting them as a completed transcript. */
export async function readCheckpoint(key: string, cachePath?: string | null): Promise<Checkpoint | null> {
  const cached = cachePath ? undefined : memory.get(key);
  if (cached) return { count: cached.count, texts: [...cached.texts] };
  if (!cachePath) return null;
  const raw = await readCacheFile(cachePath, `temp/audio-transcriptions/${key}.json`);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Checkpoint;
    if (!Number.isSafeInteger(value.count) || value.count <= 0 || !Array.isArray(value.texts)
      || value.texts.length !== value.count || !value.texts.every((text) => text === null || typeof text === "string")) return null;
    return value;
  } catch { return null; }
}

/** Waiting for another attempt remains cancellable without cancelling that caller's request. */
async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("音频转写已取消", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal?.removeEventListener("abort", abort); }
}

/** Serialize identical attempts to prevent duplicate paid calls and conflicting checkpoints. */
export async function withCheckpointLock<T>(key: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  void current.then(() => { if (locks.get(key) === current) locks.delete(key); });
  try { await waitForTurn(previous, signal); signal?.throwIfAborted(); return await run(); }
  finally { release(); }
}
