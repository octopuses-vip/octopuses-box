/** 桌面适配层：models。运行环境差异在此处理，界面只调用公开函数。 */
import { type ModelConnection } from "./connectionTypes";
import { isDesktopRuntime } from "./runtime";

/* ============================ 模型请求代理 ============================ */

/**
 * 流式事件（对应 Rust 侧 `StreamEvent`）。
 *
 * `kind` 是分片还是终态决定前端行为：`chunk` 逐段喂给 SSE 解析器，
 * 其余四种都是一轮的终态且只会出现一次。
 */
export interface ModelStreamEvent {
  kind: "chunk" | "done" | "httpError" | "error" | "aborted";
  /** 关联的请求 id；并行会话靠它把各自的分片区分开 */
  requestId: string;
  /** `chunk` 携带的原始 SSE 文本 */
  text?: string;
  /** `httpError` 携带的上游状态码 */
  status?: number;
  /** `httpError` 携带的上游响应体原文 */
  body?: string;
  /** `error` 携带的传输层失败原因 */
  message?: string;
}

/** 非流式代理的返回体（对应 Rust 侧 `ModelFetchResult`） */
export interface ModelFetchResult {
  /** 上游状态码；被中断时为 0，此时以 `aborted` 为准 */
  status: number;
  /** 上游响应体原文，由调用方按各自协议解析 */
  body: string;
  /** 是否被调用方主动中断 */
  aborted: boolean;
}

/**
 * 生成一次模型请求的关联 id。
 *
 * 事件过滤、停止按钮、并行会话都要靠它对齐同一次请求，因此必须由发起方**先**定下来再透传给
 * Rust 侧——等回传才知道 id 就来不及过滤最先到达的分片了。
 */
export function newModelRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 订阅模型流式事件；返回取消订阅函数（浏览器演示环境为空实现） */
export async function listenModelStream(
  handler: (event: ModelStreamEvent) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => { };
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ModelStreamEvent>("model-stream", (event) => handler(event.payload));
}

/**
 * 经 Rust 侧发起一次流式模型请求。
 *
 * 事件与命令返回走不同通道，事件可能先到，因此调用方必须**先**挂好 `listenModelStream`
 * 再调用这里，否则会漏掉开头几段分片。
 */
export async function startModelStream(request: {
  requestId: string;
  url: string;
  key: string;
  /** 已构造好的请求体：协议细节留在前端，Rust 只负责转发 */
  payload: unknown;
}): Promise<void> {
  if (!isDesktopRuntime()) throw new Error("模型流式代理仅在桌面端可用。");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("model_stream", {
    requestId: request.requestId,
    url: request.url,
    key: request.key,
    payload: request.payload,
  });
}

/** 中断一次进行中的模型请求；请求已结束时是空操作 */
export async function abortModelStream(requestId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("model_abort", { requestId });
}

/**
 * 经 Rust 侧发起一次非流式请求，返回状态码与原始响应体。
 *
 * 请求 id 由这里生成：非流式调用方只关心结果，不必自己跟踪分片归属。
 * `signal` 触发时立即通知 Rust 侧掐断上游，结果里以 `aborted` 告知调用方。
 */
export async function fetchModelResource(request: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  key: string;
  /** POST 的 JSON 请求体原文；GET 不传 */
  body?: string;
  signal?: AbortSignal;
}): Promise<ModelFetchResult> {
  if (!isDesktopRuntime()) throw new Error("模型请求代理仅在桌面端可用。");
  if (request.signal?.aborted) {
    // 已经中断的请求不必再发出去：此时 Rust 侧还没登记取消句柄，信号会落空、请求照跑
    return { status: 0, body: "", aborted: true };
  }
  const requestId = newModelRequestId();
  /** 函数级说明（开发者 Jan）：执行 forwardAbort 的单一职责，并返回可供调用方继续处理的结果。 */
  const forwardAbort = () => {
    void abortModelStream(requestId);
  };
  request.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ModelFetchResult>("model_fetch", {
      requestId,
      method: request.method,
      url: request.url,
      key: request.key,
      body: request.body ?? null,
    });
  } finally {
    request.signal?.removeEventListener("abort", forwardAbort);
  }
}

/* ============================ 图像生成 ============================ */

/** 一次图像生成的结果：失败时 output 是可读原因，成功时 base64 为图片内容 */
export interface ImageGenerationResult {
  ok: boolean;
  output: string;
  /** 成功时为 base64 编码的图片内容 */
  base64: string | null;
}

/**
 * 调用 OpenAI 兼容的 `/images/generations` 生成一张图片。
 *
 * `model` 由 `probeImageSupport()` 探测得到（网关当前没有图像渠道时根本不会走到这里）。
 * 结果只回 base64，落盘交给 `writeArtifactBytes`，让「探测」与「生成」共用同一条请求路径。
 * 桌面端经 Rust 侧代理发出，原因见「模型请求代理」一节。
 */
export async function generateImage(
  connection: ModelConnection,
  model: string,
  prompt: string,
  size: string,
  signal?: AbortSignal,
): Promise<ImageGenerationResult> {
  const url = `${connection.url.replace(/\/+$/, "")}/images/generations`;
  const body = JSON.stringify({ model, prompt, n: 1, size });
  let status: number;
  let text: string;
  try {
    if (isDesktopRuntime()) {
      // 桌面端：网关的成功响应带重复 CORS 头，WebView 里的 fetch 会被判为跨域失败，
      // 因此与对话链路一致改由 Rust 侧发起；浏览器演示环境保持原来的 fetch
      const result = await fetchModelResource({
        method: "POST",
        url,
        key: connection.key,
        body,
        signal,
      });
      if (result.aborted) throw new DOMException("请求已中断", "AbortError");
      status = result.status;
      text = result.body;
    } else {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.key}`,
        },
        body,
        signal,
      });
      status = response.status;
      text = await response.text();
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, output: `请求图像接口失败：${String(error)}`, base64: null };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      output: `图像接口返回 ${status}：${text.slice(0, 200)}`,
      base64: null,
    };
  }
  const payload = JSON.parse(text) as {
    data?: { b64_json?: string | null; url?: string | null }[];
  };
  const base64 = payload.data?.[0]?.b64_json ?? null;
  if (!base64) {
    return {
      ok: false,
      output: "图像接口未返回 b64_json 数据，无法落盘预览。",
      base64: null,
    };
  }
  return { ok: true, output: "", base64 };
}
