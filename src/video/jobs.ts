import { create } from "zustand";
import type { ModelConnection } from "../app/desktop/connectionTypes";
import { fetchModelResource } from "../app/desktop/models";
import { downloadVideo, listVideoJobs, saveVideoJob } from "../app/desktop/video";
import { readVideoStatus, videoTaskId, videoTasksUrl, videoPayload, VideoApiError, type VideoRequestBody, type VideoJob } from "./protocol";

type VideoConnection = Pick<ModelConnection, "url" | "key" | "modelId">;
export const useVideoJobs = create<{ jobs: Record<string, VideoJob> }>(() => ({ jobs: {} }));
const keyOf = (scope: string, id: string) => JSON.stringify([scope, id]);
const busy = new Set<string>();
const pendingSaves = new Set<string>();
const loaded = new Map<string, Promise<void>>();
const MAX_READ_RETRIES = 3;

/** Only failed reads may reconnect automatically; a create request must never be replayed. */
class VideoReadError extends Error {}

/** Read a single task without subscribing to unrelated jobs. */
export function videoJobAt(jobs: Record<string, VideoJob>, scope: string | null, id: string) {
  return scope ? jobs[keyOf(scope, id)] : undefined;
}

/** Wait through automatic retries, but release the conversation when the task needs manual recovery. */
export async function waitForVideoJob(scope: string, id: string, signal: AbortSignal, deadline?: number): Promise<VideoJob | null> {
  signal.throwIfAborted();
  const key = keyOf(scope, id);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const finish = (job: VideoJob | null) => {
      cleanup();
      resolve(job);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const check = ({ jobs }: ReturnType<typeof useVideoJobs.getState>) => {
      const job = jobs[key];
      if (!job) {
        cleanup();
        reject(new Error("视频任务记录不可用。"));
      } else if (!job.taskId || ["done", "failed", "cancelled", "paused"].includes(job.phase)) {
        finish(job);
      }
    };
    const unsubscribe = useVideoJobs.subscribe(check);
    const timer = deadline === undefined ? undefined : setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", abort, { once: true });
    check(useVideoJobs.getState());
  });
}

/** Keep the accepted task ID in memory even if a subsequent SQLite update temporarily fails. */
function publish(scope: string, job: VideoJob) {
  const key = keyOf(scope, job.id);
  useVideoJobs.setState((s) => ({ jobs: { ...s.jobs, [key]: job } }));
}

/** Write state changes before the next query or download. A later tick retries failed writes. */
async function update(scope: string, job: VideoJob) {
  const key = keyOf(scope, job.id);
  publish(scope, job);
  pendingSaves.add(key);
  await saveVideoJob(scope, job);
  pendingSaves.delete(key);
}

/** Restore the provider handle, never replay a possibly accepted POST after restart. */
export function restoreVideoJobs(scope: string) {
  let promise = loaded.get(scope);
  if (promise) return promise;
  promise = listVideoJobs(scope).then(async (jobs) => {
    for (const job of jobs) {
      if (job.phase === "submitting") {
        await update(scope, { ...job, phase: "unknown", detail: "提交时应用退出，请在服务方核对是否已受理。" });
      } else if (job.phase === "paused" && job.taskId && /^(请求模型服务失败|读取模型服务响应失败)：/.test(job.detail)) {
        // Old versions stopped polling after the first transport failure. Recover that handle once.
        await update(scope, { ...job, phase: "retrying", retryCount: 0, retryAt: Date.now(), detail: "正在重新连接原视频任务。" });
      } else publish(scope, job);
    }
  }).catch((error) => { loaded.delete(scope); throw error; });
  loaded.set(scope, promise);
  return promise;
}

/** Create the provider job exactly once per assistant turn, including ambiguous failures. */
export async function submitVideoJob(scope: string, job: VideoJob, connection: VideoConnection, body: VideoRequestBody, signal?: AbortSignal) {
  await restoreVideoJobs(scope);
  const key = keyOf(scope, job.id);
  const previous = useVideoJobs.getState().jobs[key];
  if (previous || busy.has(key)) throw new Error("本轮视频请求已处理，请查看已有任务卡。");
  busy.add(key);
  try {
    job = { ...job, api: "openai" };
    await saveVideoJob(scope, job, true);
    publish(scope, job);
    if (signal?.aborted) {
      await update(scope, { ...job, phase: "cancelled", detail: "已停止提交。" });
      return;
    }
    try {
      const response = await fetchModelResource({
        method: "POST", url: videoTasksUrl(connection.url), key: connection.key, body: JSON.stringify(body),
      });
      const id = videoTaskId(response.body, response.status);
      const metadata = videoPayload(response.body, response.status);
      job = { ...job, taskId: id, phase: "queued",
        seconds: typeof metadata.seconds === "string" || typeof metadata.seconds === "number" ? String(metadata.seconds) : undefined,
        size: typeof metadata.size === "string" ? metadata.size : undefined,
      };
    } catch (error) {
      job = error instanceof VideoApiError && error.rejected
        ? { ...job, phase: "failed", detail: `服务方拒绝提交：${error.message}` }
        : { ...job, phase: "unknown", detail: `提交状态待确认，请先在服务方核对。\n${String(error)}` };
    }
    await update(scope, job);
  } finally { busy.delete(key); }
}

/** Use the same response checks for polling and confirmation of a queued cancellation. */
async function readTask(connection: VideoConnection, url: string, job: VideoJob) {
  let response;
  try {
    response = await fetchModelResource({ method: "GET", url, key: connection.key, timeoutSecs: 30 });
  } catch (error) { throw new VideoReadError(error instanceof Error ? error.message : String(error)); }
  try {
    const state = readVideoStatus(response.body, job.api, response.status);
    if (state.phase === "failed") return state;
    const metadata = videoPayload(response.body, response.status);
    return { ...state,
      seconds: typeof metadata.seconds === "string" || typeof metadata.seconds === "number" ? String(metadata.seconds) : job.seconds,
      size: typeof metadata.size === "string" ? metadata.size : job.size,
    };
  } catch (error) {
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new VideoReadError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

/** A completed status can arrive before its content; retry safe downloads without creating another job. */
async function readContent(job: VideoJob, url: string, key?: string) {
  try { await downloadVideo(job, url, key); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = /HTTP 404\b/.test(detail)
      ? "服务端任务已完成，但下载接口找不到视频文件（HTTP 404）。请检查服务端输出文件。"
      : `服务端任务已完成，但视频下载未完成。\n${detail}`;
    if (/无法连接视频下载服务|下载中断|视频不完整|HTTP (?:404|408|429|5\d\d)\b/.test(detail)) throw new VideoReadError(message);
    throw new Error(message);
  }
}

/** Older clients mistook the gateway's missing-route envelope for an accepted task without an ID. */
function legacyUnknown(job: VideoJob) {
  return job.phase === "unknown" && !job.api && !job.taskId && job.detail.endsWith("Error: 响应缺少任务 ID");
}

/** Check the old endpoint without issuing another generation request. */
async function inspectLegacyJob(scope: string, job: VideoJob, connection: VideoConnection) {
  try {
    const response = await fetchModelResource({ method: "GET", url: videoTasksUrl(connection.url, "seedance"), key: connection.key });
    videoPayload(response.body, response.status);
  } catch (error) {
    if (error instanceof VideoApiError && error.routeMissing) {
      await update(scope, { ...job, phase: "failed", detail: "原视频接口不存在。当前版本使用 OpenAI 兼容视频接口，请重新发送生成请求。" });
    }
  }
}

/** Query by original ID and save the finished file. Resume/cancel share the same per-job lock. */
export async function advanceVideoJob(scope: string, id: string, connection: VideoConnection | null, action: "poll" | "resume" | "cancel" = "poll") {
  const key = keyOf(scope, id);
  const job = useVideoJobs.getState().jobs[key];
  if (!job) return;
  if (busy.has(key)) {
    if (action !== "poll") throw new Error("正在同步任务，请稍后重试。");
    return;
  }
  busy.add(key);
  try {
    if (pendingSaves.has(key)) await update(scope, job);
    if (!connection || connection.modelId !== job.model || connection.url !== job.baseUrl) return;
    if (!job.taskId) {
      if (legacyUnknown(job)) await inspectLegacyJob(scope, job, connection);
      return;
    }
    const active = ["queued", "running", "retrying", "downloading"].includes(job.phase);
    if (!active && !(action === "resume" && job.phase === "paused")) return;
    if (action === "poll" && job.phase === "retrying" && (job.retryAt ?? 0) > Date.now()) return;
    const api = job.api ?? "seedance";
    if (action === "cancel" && api !== "seedance") throw new Error("当前视频接口不支持取消排队。");
    const url = videoTasksUrl(connection.url, api) + "/" + encodeURIComponent(job.taskId);
    try {
      let state = await readTask(connection, url, job);
      if (action === "cancel" && state.phase === "queued") {
        const cancelled = await fetchModelResource({ method: "DELETE", url, key: connection.key });
        videoPayload(cancelled.body || "{}", cancelled.status);
        state = await readTask(connection, url, job);
      }
      const { download, ...snapshot } = state;
      const next = { ...job, ...snapshot, retryAt: undefined, retryCount: undefined };
      if (job.phase !== next.phase || job.detail !== next.detail || job.retryAt !== undefined || job.retryCount !== undefined
        || job.seconds !== next.seconds || job.size !== next.size) await update(scope, next);
      if (state.phase === "downloading") {
        const contentUrl = api === "openai" ? url + "/content" : download;
        if (!contentUrl) throw new Error("视频任务未提供下载地址。");
        await readContent(job, contentUrl, api === "openai" ? connection.key : undefined);
        await update(scope, { ...next, phase: "done", detail: "" });
        return true;
      }
    } catch (error) {
      if (pendingSaves.has(key)) throw error;
      const count = (action === "resume" ? 0 : job.retryCount ?? 0) + 1;
      if (error instanceof VideoReadError && action !== "cancel" && count <= MAX_READ_RETRIES) {
        const delay = 5000 * 2 ** (count - 1);
        await update(scope, { ...job, phase: "retrying", retryCount: count, retryAt: Date.now() + delay,
          detail: `暂时无法同步视频，${delay / 1000} 秒后自动重试（${count}/${MAX_READ_RETRIES}）。原任务已保留。\n${error.message}` });
      } else {
        await update(scope, { ...job, phase: "paused", retryAt: undefined, retryCount: undefined,
          detail: `${error instanceof VideoReadError ? "自动重连未恢复，可继续原任务。\n" : ""}${error instanceof Error ? error.message : String(error)}` });
      }
    }
  } finally { busy.delete(key); }
}

/** Iterate just this cache's jobs; the caller also checks account and conversation ownership. */
export function jobsForScope(scope: string) {
  const jobs = useVideoJobs.getState().jobs;
  return Object.values(jobs).filter((job) => {
    const key = keyOf(scope, job.id);
    return jobs[key] === job && (pendingSaves.has(key) || legacyUnknown(job) || ["queued", "running", "downloading"].includes(job.phase)
      || (job.phase === "retrying" && (job.retryAt ?? 0) <= Date.now()));
  });
}
