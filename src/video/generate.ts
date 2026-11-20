import type { AppStore } from "../app/storeTypes";
import { selectModelConnectionByCode } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import type { MessageAttachment, StreamItem } from "../app/types";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { sessionWrites } from "../cache/sessionPersistence";
import type { ToolCall } from "../model/client";
import { submitVideoJob, useVideoJobs, videoJobAt, waitForVideoJob } from "./jobs";
import { phaseLabel, videoRequest, type VideoJob } from "./protocol";

/** Separate local and managed accounts even when both use the same model ID and cache. */
export function videoOwner(s: AppStore) {
  return JSON.stringify(s.modelSource === "remote" ? [s.modelSource, s.endpoint?.host, s.endpoint?.port, s.currentUser] : [s.modelSource]);
}

interface SubmissionContext {
  threadId: string;
  messageId: string;
  attachments: MessageAttachment[];
  artifactDir: string | null;
  cachePath: string | null;
  push: (item: StreamItem) => void;
  patch: (id: string, fn: (item: StreamItem) => StreamItem) => void;
  nextId: (prefix: string) => string;
  controller: AbortController;
  startedAt: number;
}

/** Find the original video task in the currently signed-in account and cache. */
export function videoForTurn(state: AppStore, id: string) {
  const job = videoJobAt(useVideoJobs.getState().jobs, state.cachePath, id);
  return job?.owner === videoOwner(state) ? job : undefined;
}

/** Make the latest provider state visible on follow-up turns, including after a restart. */
export function videoHistoryResult(state: AppStore, id: string) {
  const job = videoForTurn(state, id);
  return job && videoResult(job);
}

function videoResult(job: VideoJob) {
  if (job.phase === "done") {
    const specs = [job.seconds ? `${job.seconds} 秒` : "", job.size].filter(Boolean).join(" · ");
    return `已生成 ${job.file}${specs ? `（实际规格 ${specs}）` : ""}，可在右栏媒体中播放。`;
  }
  return [phaseLabel[job.phase], job.detail, job.taskId].filter(Boolean).join(" · ");
}

/** Shared entry for explicit /video and a model-issued tool call. */
export async function generateVideo(call: ToolCall, context: SubmissionContext) {
  const { threadId, messageId, cachePath, artifactDir, attachments, push, patch } = context;
  const s = useAppStore.getState();
  const connection = selectModelConnectionByCode(s, s.videoModelCode);
  const id = context.nextId("item");
  const signal = context.controller.signal;
  push({ id, type: "tool_call", kind: "video_gen", name: call.function.name, callId: call.id,
    title: "生成视频", command: null, status: "running", output: "", durationMs: null, arguments: call.function.arguments,
    videoJobId: messageId });
  let ok = false;
  let timedOut = false;
  let output: string;
  try {
    if (!isDesktopRuntime()) throw new Error("请使用桌面客户端生成视频。");
    if (!connection) throw new Error("请先在设置中选择已开通的视频生成模型。");
    if (!cachePath || !artifactDir) throw new Error("当前会话缺少产物目录。");
    const endpoint = new URL(connection.url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
      throw new Error("视频模型基础地址应为 HTTP(S) 服务地址。请将密钥填入模型的密钥字段。");
    }
    const { body, referenceId } = videoRequest(call.function.arguments, attachments, connection.modelId);
    const job: VideoJob = { id: messageId, threadId, owner: videoOwner(s), model: connection.modelId, baseUrl: connection.url,
      referenceId, dir: artifactDir, file: `video-${messageId}.mp4`, phase: "submitting", detail: "" };
    // Save the card (and its original image) before starting a billable operation.
    await sessionWrites(cachePath).flush();
    signal.throwIfAborted();
    await submitVideoJob(cachePath, job, connection, body, signal);
    const deadline = s.maxRunDurationSecs > 0 ? context.startedAt + s.maxRunDurationSecs * 1000 : undefined;
    const current = await waitForVideoJob(cachePath, messageId, signal, deadline);
    timedOut = current === null;
    ok = current?.phase === "done";
    output = current ? videoResult(current) : "已达到本轮运行时长上限。原视频任务仍可在任务卡查看或继续。";
  } catch (e) {
    signal.throwIfAborted();
    output = e instanceof Error ? e.message : String(e);
  }
  patch(id, (item) => item.type === "tool_call" ? { ...item, status: ok ? "success" : "error", output, result: output } : item);
  return { ok, timedOut, output };
}
