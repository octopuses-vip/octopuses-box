import type { AppStore } from "../app/storeTypes";
import { selectModelConnectionByCode } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import type { MessageAttachment, StreamItem } from "../app/types";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { sessionWrites } from "../cache/sessionPersistence";
import type { ToolCall } from "../model/client";
import { submitVideoJob, useVideoJobs, videoJobAt } from "./jobs";
import { phaseLabel, videoRequest, type VideoJob } from "./protocol";

/** 单机版没有账号隔离，缓存目录本身就是作用域，owner 恒为 local。 */
export function videoOwner(_s: AppStore) {
  return "local";
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
}

/** Find the original video task in the currently signed-in account and cache. */
export function videoForTurn(state: AppStore, id: string) {
  const job = videoJobAt(useVideoJobs.getState().jobs, state.cachePath, id);
  return job?.owner === videoOwner(state) ? job : undefined;
}

/** Make the latest provider state visible on follow-up turns, including after a restart. */
export function videoHistoryResult(state: AppStore, id: string) {
  const job = videoForTurn(state, id);
  if (!job) return undefined;
  if (job.phase === "done") return `已生成 ${job.file}，可在右栏媒体中播放。`;
  return [phaseLabel[job.phase], job.detail, job.taskId].filter(Boolean).join(" · ");
}

/** Shared entry for explicit /video and a model-issued tool call. */
export async function generateVideo(call: ToolCall, context: SubmissionContext) {
  const { threadId, messageId, cachePath, artifactDir, attachments, push, patch } = context;
  const s = useAppStore.getState();
  const connection = selectModelConnectionByCode(s, s.videoModelCode);
  const id = context.nextId("item");
  push({ id, type: "tool_call", kind: "video_gen", name: call.function.name, callId: call.id,
    title: "生成视频", command: null, status: "running", output: "", durationMs: null, arguments: call.function.arguments,
    videoJobId: messageId });
  let ok = false;
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
    context.controller.signal.throwIfAborted();
    await submitVideoJob(cachePath, job, connection, body, context.controller.signal);
    const current = videoJobAt(useVideoJobs.getState().jobs, cachePath, messageId)!;
    ok = Boolean(current.taskId);
    output = ok ? `视频任务已受理（${current.taskId}），请在任务卡查看进度。请勿重复提交。` : `${phaseLabel[current.phase]}：${current.detail}`;
  } catch (e) {
    output = e instanceof Error ? e.message : String(e);
  }
  patch(id, (item) => item.type === "tool_call" ? { ...item, status: ok ? "success" : "error", output, result: output } : item);
  return { ok, output };
}
