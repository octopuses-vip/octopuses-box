import type { MessageAttachment } from "../app/types";
import type { ChatTool } from "../model/client";
import { MAX_IMAGE_BYTES } from "../model/attachments";

export const VIDEO_TOOL_NAME = "generate_video";
export const VIDEO_TOOL: ChatTool = {
  type: "function",
  function: {
    name: VIDEO_TOOL_NAME,
    description: "根据文字或本条消息的一张参考图与文字生成 MP4 短片。任务异步执行，提交后告知用户查看任务卡。同一轮只提交一次。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "主体、动作、镜头和风格。" },
        referenceId: { type: "string", description: "本条用户消息的图片附件 ID。只有一张图片时会自动使用。" },
        duration: { type: "integer", description: "可选，成片时长（秒），按渠道支持范围设置。" },
        ratio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] },
      },
      required: ["prompt"],
    },
  },
};

export type VideoApi = "seedance" | "predictions";
export interface VideoRequestBody {
  model: string;
  content: ({ type: "text"; text: string } | { type: "image_url"; role: "first_frame"; image_url: { url: string } })[];
  duration?: number;
  ratio?: string;
}

/** Build one Seedance submission, resolving attachments from the originating turn only. */
export function videoRequest(raw: string, attachments: MessageAttachment[], model: string) {
  const args = JSON.parse(raw) as Record<string, unknown>;
  if (typeof args?.prompt !== "string" || !args.prompt.trim()) throw new Error("请描述要生成的视频。");
  const images = attachments.filter((item) => item.kind === "image");
  const image = args.referenceId === undefined ? images[0] : images.find((item) => item.id === args.referenceId);
  if (args.referenceId !== undefined && !image) throw new Error("本条消息中找不到指定的参考图。");
  if (args.referenceId === undefined && images.length > 1) throw new Error("请指定一张参考图，或移除其余图片。");
  if (image && (!["image/png", "image/jpeg", "image/webp"].includes(image.mime)
    || !image.dataUrl?.startsWith(`data:${image.mime};base64,`) || !image.size || image.size > MAX_IMAGE_BYTES)) {
    throw new Error("参考图需要是 10 MB 以内的 JPEG、PNG 或 WebP 图片。");
  }
  if (args.duration !== undefined && (!Number.isSafeInteger(args.duration) || Number(args.duration) < 1)) {
    throw new Error("视频时长须为正整数秒。");
  }
  if (args.ratio !== undefined && (typeof args.ratio !== "string" || !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(args.ratio))) {
    throw new Error("不支持此视频画幅。");
  }
  const content: VideoRequestBody["content"] = [{ type: "text", text: args.prompt.trim() }];
  if (image?.dataUrl) content.push({ type: "image_url", role: "first_frame", image_url: { url: image.dataUrl } });
  return {
    referenceId: image?.id,
    body: { model, content, duration: args.duration as number | undefined, ratio: args.ratio as string | undefined },
  };
}

export type VideoPhase = "submitting" | "unknown" | "queued" | "running" | "downloading" | "paused" | "failed" | "done" | "cancelled";
export interface VideoJob {
  id: string;
  threadId: string;
  owner: string;
  model: string;
  baseUrl: string;
  dir: string;
  file: string;
  referenceId?: string;
  taskId?: string;
  api?: VideoApi;
  phase: VideoPhase;
  detail: string;
}

export const phaseLabel: Record<VideoPhase, string> = {
  submitting: "正在提交", unknown: "提交状态待确认", queued: "排队中", running: "生成中",
  downloading: "正在下载", paused: "等待继续", failed: "失败", done: "已完成", cancelled: "已取消",
};

const VIDEO_FAILURE_EVENT = "video.generation.failed";

/** The gateway's API rejection is distinct from an interrupted or unrecognizable response. */
export class VideoApiError extends Error {
  constructor(
    message: string,
    public readonly rejected: boolean,
    public readonly routeMissing = false,
    public readonly taskFailed = false,
  ) {
    super(message);
    this.name = "VideoApiError";
  }
}

function videoObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function errorText(data: Record<string, unknown>) {
  return firstText(videoObject(data.error)?.message, data.error, data.msg, data.message);
}

/** Gateways can serialize an upstream failure event as the message of another error. */
function unwrapVideoError(envelope: Record<string, unknown>) {
  let text: string | undefined;
  let taskFailed = false;
  for (let depth = 0; depth < 5; depth += 1) {
    taskFailed ||= envelope.type === VIDEO_FAILURE_EVENT;
    const data = videoObject(envelope.data);
    const message = errorText(envelope) ?? (data && errorText(data));
    if (!message) {
      if (taskFailed) text = undefined;
      break;
    }
    text = message;
    if (!text.startsWith("{")) break;
    try {
      const next = videoObject(JSON.parse(text));
      if (!next) break;
      envelope = next;
    } catch { break; }
  }
  return { text, taskFailed };
}

function failureDetail(text: string | undefined, fallback: string) {
  if (!text) return fallback;
  if (/output video may be related to copyright restrictions/i.test(text)) {
    const requestId = /\brequest id:\s*([a-z0-9_-]+)/i.exec(text)?.[1];
    return `服务商拒绝生成，输出视频可能涉及版权限制。${requestId ? `\n请求 ID ${requestId.slice(0, 128)}` : ""}`;
  }
  return text.slice(0, 500);
}

/** Decode business errors even when the gateway sends HTTP 200. */
export function videoPayload(body: string, status = 200): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(body); }
  catch { throw new VideoApiError(`视频服务返回了非 JSON 响应（HTTP ${status}）`, status >= 400 && status < 500 && status !== 408, status === 404 || status === 405); }
  const envelope = videoObject(raw) ?? {};
  const data = videoObject(envelope.data) ?? (envelope.code !== undefined ? {} : envelope);
  const error = envelope.error ?? data.error;
  const failed = envelope.code !== undefined && envelope.code !== null && String(envelope.code) !== "0";
  const envelopeError = data !== envelope && Boolean(envelope.error);
  if (status < 200 || status >= 300 || failed || envelopeError || envelope.type === VIDEO_FAILURE_EVENT || (error && !firstText(data.status, data.task_status))) {
    const { text, taskFailed } = unwrapVideoError(envelope);
    const missing = !taskFailed && (status === 404 || status === 405 || /no static resource|request method ['"]?POST['"]? is not supported/i.test(text ?? ""));
    const detail = /providers not found/i.test(text ?? "")
      ? `当前密钥分组没有所选模型的可用视频渠道，请在网关开通此模型或选择其他已开通的视频模型。\n${text}`
      : text;
    const rejected = taskFailed || missing || failed || (status >= 400 && status < 500 && status !== 408);
    throw new VideoApiError(failureDetail(detail, taskFailed ? "服务商生成失败。" : `视频服务请求失败（HTTP ${status}）`), rejected, missing, taskFailed);
  }
  return data;
}

/** Resolve the documented task identifiers from either protocol, including wrapped responses. */
export function videoTaskId(body: string, status = 200) {
  const data = videoPayload(body, status);
  const id = firstText(data.id, data.task_id, data.taskId);
  if (!id) throw new VideoApiError(`响应缺少任务 ID（返回字段 ${Object.keys(data).join("、") || "空"}）`, false);
  return id;
}

/** Map the validated prompt and exact first frame to the gateway's unified video input. */
export function predictionRequest(body: VideoRequestBody) {
  const text = body.content.find((part) => part.type === "text");
  const image = body.content.find((part) => part.type === "image_url");
  return { model: body.model, function: "video", input: {
    prompt: text?.text, duration: body.duration, aspect_ratio: body.ratio, first_frame_url: image?.image_url.url,
  } };
}

/** Keep the original protocol with the persisted job so polling survives application restarts. */
export function videoTasksUrl(baseUrl: string, api: VideoApi = "seedance") {
  return baseUrl.replace(/\/+$/, "") + (api === "predictions" ? "/predictions" : "/contents/generations/tasks");
}

/** Normalize native and unified task states. Signed result URLs live only in memory. */
export function readVideoStatus(body: string, api: VideoApi = "seedance", status = 200): { phase: VideoPhase; detail: string; download?: string } {
  let data: Record<string, unknown>;
  try { data = videoPayload(body, status); }
  catch (error) {
    if (error instanceof VideoApiError && error.taskFailed) return { phase: "failed", detail: error.message };
    throw error;
  }
  const rawPhase = api === "predictions" ? firstText(data.task_status, data.status) : firstText(data.status, data.task_status);
  const phase = rawPhase?.toLowerCase();
  switch (phase) {
    case "queued": case "running": case "cancelled":
      return { phase, detail: "" };
    case "pending": case "starting": return { phase: "queued", detail: "" };
    case "processing": case "in_progress": return { phase: "running", detail: "" };
    case "canceled": return { phase: "cancelled", detail: "" };
    case "error": case "failed": case "expired": {
      const { text } = unwrapVideoError(data);
      return { phase: "failed", detail: failureDetail(text, phase === "expired" ? "任务已过期" : "服务方生成失败") };
    }
    case "success": case "succeeded": {
      const output = Array.isArray(data.output) ? data.output.map(videoObject).find((item) => item?.type === "video") : undefined;
      const download = firstText(videoObject(data.content)?.video_url, data.video_url, output?.video, output?.image, output?.url);
      if (!download || !/^https?:\/\//i.test(download)) {
        throw new Error("生成服务尚未提供有效的视频下载地址。");
      }
      return { phase: "downloading", detail: "", download };
    }
    default: {
      const fields = Object.keys(data).slice(0, 8).join("、") || "空";
      throw new Error(`视频服务返回了无法识别的任务状态（任务数据字段 ${fields}）。`);
    }
  }
}
