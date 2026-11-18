import { create } from "zustand";
import type { ModelConnection } from "../app/desktop/connectionTypes";
import { fetchModelResource } from "../app/desktop/models";
import { downloadVideo, listVideoJobs, saveVideoJob } from "../app/desktop/video";
import { readVideoStatus, predictionRequest, videoTaskId, videoTasksUrl, videoPayload, VideoApiError, type VideoRequestBody, type VideoJob } from "./protocol";

type VideoConnection = Pick<ModelConnection, "url" | "key" | "modelId">;
export const useVideoJobs = create<{ jobs: Record<string, VideoJob> }>(() => ({ jobs: {} }));
const keyOf = (scope: string, id: string) => JSON.stringify([scope, id]);
const busy = new Set<string>();
const pendingSaves = new Set<string>();
const loaded = new Map<string, Promise<void>>();

/** Read a single task without subscribing to unrelated jobs. */
export function videoJobAt(jobs: Record<string, VideoJob>, scope: string | null, id: string) {
  return scope ? jobs[keyOf(scope, id)] : undefined;
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
    job = { ...job, api: job.api ?? "seedance" };
    await saveVideoJob(scope, job, true);
    publish(scope, job);
    if (signal?.aborted) {
      await update(scope, { ...job, phase: "cancelled", detail: "已停止提交。" });
      return;
    }
    try {
      /** The persisted protocol selects both the endpoint and the corresponding input format. */
      const create = async () => {
        const response = await fetchModelResource({
          method: "POST", url: videoTasksUrl(connection.url, job.api), key: connection.key,
          body: JSON.stringify(job.api === "predictions" ? predictionRequest(body) : body),
        });
        return videoTaskId(response.body, response.status);
      };
      let id: string;
      try { id = await create(); }
      catch (error) {
        // An explicit missing route cannot have accepted a job. Other errors keep their original outcome.
        if (!(error instanceof VideoApiError && error.routeMissing) || job.api !== "seedance") throw error;
        job = { ...job, api: "predictions" };
        await update(scope, job);
        if (signal?.aborted) {
          await update(scope, { ...job, phase: "cancelled", detail: "已停止提交。" });
          return;
        }
        id = await create();
      }
      job = { ...job, taskId: id, phase: "queued" };
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
  const response = await fetchModelResource({ method: "GET", url, key: connection.key });
  return readVideoStatus(response.body, job.api, response.status);
}

/** Older clients mistook the gateway's missing-route envelope for an accepted task without an ID. */
function legacyUnknown(job: VideoJob) {
  return job.phase === "unknown" && !job.api && !job.taskId && job.detail.endsWith("Error: 响应缺少任务 ID");
}

/** Check the old endpoint without issuing another generation request. */
async function inspectLegacyJob(scope: string, job: VideoJob, connection: VideoConnection) {
  try {
    const response = await fetchModelResource({ method: "GET", url: videoTasksUrl(connection.url), key: connection.key });
    videoPayload(response.body, response.status);
  } catch (error) {
    if (error instanceof VideoApiError && error.routeMissing) {
      await update(scope, { ...job, phase: "failed", detail: "原视频接口不存在。客户端已补充统一视频接口支持，请重新发送生成请求。" });
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
    const active = ["queued", "running", "downloading"].includes(job.phase);
    if (!active && !(action === "resume" && job.phase === "paused")) return;
    const url = videoTasksUrl(connection.url, job.api) + "/" + encodeURIComponent(job.taskId);
    try {
      let state = await readTask(connection, url, job);
      if (action === "cancel" && state.phase === "queued") {
        if (job.api === "predictions") throw new Error("当前视频接口不支持取消排队。");
        const cancelled = await fetchModelResource({ method: "DELETE", url, key: connection.key });
        videoPayload(cancelled.body || "{}", cancelled.status);
        state = await readTask(connection, url, job);
      }
      const next = { ...job, phase: state.phase, detail: state.detail };
      if (job.phase !== next.phase || job.detail !== next.detail) await update(scope, next);
      if (state.download) {
        await downloadVideo(job, state.download);
        await update(scope, { ...job, phase: "done", detail: "" });
        return true;
      }
    } catch (error) {
      if (pendingSaves.has(key)) throw error;
      await update(scope, { ...job, phase: "paused", detail: String(error) });
    }
  } finally { busy.delete(key); }
}

/** Iterate just this cache's jobs; the caller also checks account and conversation ownership. */
export function jobsForScope(scope: string) {
  const jobs = useVideoJobs.getState().jobs;
  return Object.values(jobs).filter((job) => {
    const key = keyOf(scope, job.id);
    return jobs[key] === job && (pendingSaves.has(key) || legacyUnknown(job) || ["queued", "running", "downloading"].includes(job.phase));
  });
}
