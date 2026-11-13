/**
 * 模型服务调用封装：走 OpenAI 兼容的 `/chat/completions` 流式接口。
 *
 * 浏览器演示环境（vite dev）直接 `fetch`；Tauri 桌面窗口改由 Rust 侧代理后回传原始 SSE 文本：
 * 管理端下发的网关在**成功响应**里回了两条 `Access-Control-Allow-Origin`，而该响应头不是列表型头，
 * 按 Fetch 规范出现多个取值即判定为跨域失败，WebView 里只会抛 `TypeError: Load failed`。
 * 协议解析只有下面这一份实现，两条链路区别仅在于「文本从哪里来」。
 */

import { abortModelStream, fetchModelResource, listenModelStream, newModelRequestId, startModelStream } from "../app/desktop/models";
import { isDesktopRuntime } from "../app/desktop/runtime";

/** 多模态消息的内容片段 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 模型要求调用的一次外部工具 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    /** 工具名 */
    name: string;
    /** 参数 JSON 字符串（模型生成，可能不完整，由执行方解析） */
    arguments: string;
  };
}

/** 一个可提供给模型的工具定义 */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 形式的参数定义 */
    parameters: Record<string, unknown>;
  };
}

/** 一条对话消息，对齐接口入参的 role / content */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** 纯文本消息直接给字符串，带图片时给内容片段数组，仅带工具调用时为 null */
  content: string | ChatContentPart[] | null;
  /** 助手消息要求调用的工具（role 为 assistant 时可能出现） */
  tool_calls?: ToolCall[];
  /** 工具结果消息对应的调用 id（role 为 tool 时必填） */
  tool_call_id?: string;
}

/** 一次流式增量：思维链与正文分开返回，可能只有其中一项 */
export interface ChatDelta {
  reasoning: string;
  content: string;
}

/**
 * 思考强度档位。
 *
 * 取值由模型服务决定：接口只接受 `low` / `medium` / `xhigh`（默认 `xhigh`），传别的值会直接
 * 返回 400 `Unexpected reasoning effort`，因此界面上就只提供这三档，不做本地再映射。
 */
export type ReasoningEffort = "low" | "medium" | "xhigh";

/** 界面档位（与 `effort` 的下标一一对应：1 → 低，3 → 高） */
export const EFFORT_LABELS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "xhigh", label: "高" },
];

/** 把界面上的 1~3 档换算成接口可接受的取值；越界时收敛到两端 */
export function effortToReasoning(effort: number): ReasoningEffort {
  const index = Math.min(Math.max(Math.round(effort), 1), EFFORT_LABELS.length) - 1;
  return EFFORT_LABELS[index].value;
}

/**
 * 一次模型调用的转储出口（开发者 Jan）。
 *
 * 协议层只负责把「发出什么、收到什么」原样交给调用方：转储开关、落盘位置与图片脱敏都在
 * `src/model/trace.ts` 里决定。这样协议层不依赖 store，主对话流与旁路调用也能共用同一套转储。
 */
export type ModelTraceSink = (event: ModelTraceEvent) => void;

/** 转储事件：请求体、原始响应分片（流式）、完整响应体（非流式）与终态 */
export type ModelTraceEvent =
  | { kind: "request"; payload: unknown }
  | { kind: "chunk"; text: string }
  | { kind: "response"; payload: unknown }
  | { kind: "event"; name: string; data?: unknown }
  | { kind: "done"; reason?: string; completed?: boolean }
  | { kind: "error"; message: string; reason?: string };

/** 只诊断协议标记，传输 EOF 不等于模型完成。 */
export function createStreamTrace(trace?: ModelTraceSink) {
  let buffer = "";
  let protocolDone = false;
  let finishReason = false;
  let terminal = false;
/** 函数级说明（开发者 Jan）：执行 line 的单一职责，并返回可供调用方继续处理的结果。 */
  const line = (text: string) => {
    if (!text.trim().startsWith("data:")) return;
    const data = text.trim().slice(5).trim();
    if (data === "[DONE]") {
      protocolDone = true;
      trace?.({ kind: "event", name: "protocol_done" });
    } else {
      try {
        const payload = JSON.parse(data) as { choices?: { finish_reason?: unknown }[] };
        for (const choice of payload.choices ?? []) {
          if (choice.finish_reason != null) {
            finishReason = true;
            trace?.({ kind: "event", name: "finish_reason", data: choice.finish_reason });
          }
        }
      } catch {
        if (data) trace?.({ kind: "event", name: "invalid_sse_json" });
      }
    }
  };
  return {
    chunk(text: string) {
      if (terminal) return;
      trace?.({ kind: "chunk", text });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) line(text);
    },
    end() {
      if (terminal) return;
      line(buffer);
      buffer = "";
      trace?.({ kind: "event", name: "transport_eof", data: { protocolDone, finishReason } });
      terminal = true;
      trace?.({ kind: "done", reason: protocolDone ? "protocol_done" : finishReason ? "finish_reason" : "eof_without_completion", completed: protocolDone || finishReason });
    },
    cancel(error: unknown) {
      if (terminal) return;
      if (protocolDone) {
        terminal = true;
        trace?.({ kind: "done", reason: "protocol_done", completed: true });
      } else {
        terminal = true;
        trace?.({ kind: "error", message: describeTraceError(error), reason: "consumer_cancelled" });
      }
    },
    error(error: unknown, reason = "transport_error") {
      if (terminal) return;
      terminal = true;
      trace?.({ kind: "error", message: describeTraceError(error), reason });
    },
  };
}

/** 转储里记录的错误文案：非 Error 的抛出物也要有可读文本 */
function describeTraceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StreamChatOptions {
  /** 模型服务基础地址，如 https://api.octopuses.vip/v1 */
  url: string;
  /** 访问密钥 */
  key: string;
  /** 模型 id */
  model: string;
  messages: ChatMessage[];
  /** 思考强度；不传时不带该参数，由服务使用默认档位 */
  reasoningEffort?: ReasoningEffort;
  /** 可调用的工具；为空时请求不带 tools，与开启工具前行为一致 */
  tools?: ChatTool[];
  /** 中断信号，用于 Composer 的停止按钮 */
  signal?: AbortSignal;
  /** 每收到一段增量回调一次 */
  onDelta: (delta: ChatDelta) => void;
  /** 请求与原始响应的转储出口；不传即不转储 */
  trace?: ModelTraceSink;
}

/** 一次请求的结果：本轮模型要求调用的工具（按 index 归并后的完整列表） */
export interface StreamChatResult {
  toolCalls: ToolCall[];
  /**
   * 服务端回传的本轮 token 用量。
   *
   * 需要请求里带 `stream_options.include_usage`，服务端会在末尾补一个只含 `usage` 的分片；
   * 网关不返回（或返回 null）时为 null，此时界面上不展示用量，而不是猜一个数字。
   */
  usage: UsageInfo | null;
}

/** 一轮请求的 token 用量（服务端口径，不做本地估算） */
export interface UsageInfo {
  /** 输入 token（system + 历史 + 工具结果 + 图片） */
  promptTokens: number;
  /** 输出 token */
  completionTokens: number;
  /** 输出中的思考 token（已含在 completionTokens 内） */
  reasoningTokens: number;
  /** 服务端给出的总 token */
  totalTokens: number;
}

/** 权重未定时的工具调用归属下标 */
interface ToolCallAccumulator {
  index: number;
  id: string | null;
  name: string | null;
  arguments: string;
}

/** 拼出完整的接口地址，容忍配置末尾多写的斜杠 */
function chatEndpoint(base: string): string {
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * 把「状态码 + 响应体原文」整理成可读的错误信息。
 *
 * 浏览器端从 `Response` 取、桌面端从代理事件取，两条链路共用这里的文案规则，
 * 同一个失败在两种运行方式下提示一致。
 */
/** 带 HTTP 状态码的错误：调用方可据此区分确定性 4xx（不值得重试）与瞬时 5xx（可重试） */
export class HttpError extends Error {
  /** 响应状态码 */
  readonly status: number;
  /** @param status 响应状态码 @param text 原始响应体（用于拼出可读消息） */
  constructor(status: number, text: string) {
    super(formatHttpError(status, text));
    this.name = "HttpError";
    this.status = status;
  }
}

function formatHttpError(status: number, text: string): string {
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: string };
      message?: string;
    };
    const message = payload.error?.message ?? payload.message;
    if (message) return `${status} ${message}`;
  } catch {
    // 非 JSON 响应（如网关返回的 HTML），回落到原始文本
  }
  return `${status} ${text.slice(0, 200)}`;
}

/** 一行 SSE 解析出的增量：正文/思维链文本 + 工具调用分片 + 用量 */
interface ParsedLine {
  reasoning: string;
  content: string;
  toolCalls: ToolCallAccumulator[];
  /** 该行携带的用量；没有则为 null */
  usage: UsageInfo | null;
}

/** 解析服务端回传的 usage 对象；字段缺失或非数字时返回 null */
function parseUsage(value: unknown): UsageInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const number = (input: unknown): number | null =>
    typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
  const promptTokens = number(raw.prompt_tokens);
  const completionTokens = number(raw.completion_tokens);
  if (promptTokens === null && completionTokens === null) return null;
  const details = raw.completion_tokens_details;
  const reasoningTokens =
    typeof details === "object" && details !== null
      ? number((details as Record<string, unknown>).reasoning_tokens) ?? 0
      : 0;
  const totalTokens = number(raw.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    reasoningTokens,
    totalTokens,
  };
}

/** 解析一行 SSE：返回增量；心跳行、`[DONE]` 与不可解析的行返回 null */
function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;

  let chunk: {
    choices?: {
      delta?: {
        reasoning?: string | null;
        content?: string | null;
        tool_calls?: {
          index?: number;
          id?: string | null;
          function?: { name?: string | null; arguments?: string | null };
        }[];
      };
    }[];
    usage?: unknown;
  };
  try {
    chunk = JSON.parse(payload) as typeof chunk;
  } catch {
    return null; // 半包或网关补充的非法行，跳过即可
  }

  // 用量分片没有 choices（choices 为空数组），因此要在取 delta 之前先读 usage
  const usage = parseUsage(chunk.usage);
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return usage ? { reasoning: "", content: "", toolCalls: [], usage } : null;

  // 工具调用分片：id/name 只在首片出现，arguments 逐片拼接，按 index 归并
  const toolCalls: ToolCallAccumulator[] = [];
  for (const call of delta.tool_calls ?? []) {
    toolCalls.push({
      index: call.index ?? 0,
      id: call.id ?? null,
      name: call.function?.name ?? null,
      arguments: call.function?.arguments ?? "",
    });
  }

  return {
    reasoning: delta.reasoning ?? "",
    content: delta.content ?? "",
    toolCalls,
    usage,
  };
}

/** SSE 文本消费器：分片随时喂进来，解析状态在内部累积 */
interface SseReader {
  /** 喂入一段原始文本（可能只是半行，也可能是半包） */
  push: (text: string) => void;
  /** 流结束：补解析最后一段没有换行结尾的分片 */
  close: () => void;
}

/**
 * 创建按行解析 SSE 的消费器，逐段回调增量并累加工具调用分片与用量。
 *
 * 浏览器端从 `ReadableStream` 读、桌面端从 Rust 代理事件读，两者都归结为「一串 UTF-8 文本
 * 片段」；把按行切分与增量合并收敛在这里，两条链路才能保证解析行为完全一致。
 */
function createSseReader(
  onDelta: (delta: ChatDelta) => void,
  pending: Map<number, ToolCallAccumulator>,
  consumeUsage: (usage: UsageInfo) => void,
): SseReader {
  let buffer = "";

/** 函数级说明（开发者 Jan）：执行 absorb 的单一职责，并返回可供调用方继续处理的结果。 */
  const absorb = (delta: ParsedLine) => {
    if (delta.usage) consumeUsage(delta.usage);
    for (const call of delta.toolCalls) {
      const current = pending.get(call.index) ?? {
        index: call.index,
        id: null,
        name: null,
        arguments: "",
      };
      if (call.id) current.id = call.id;
      if (call.name) current.name = call.name;
      if (call.arguments) current.arguments += call.arguments;
      pending.set(call.index, current);
    }
  };

  return {
    push(text) {
      buffer += text;
      // 按行切分，最后一段可能是半包，留到下次拼接
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseLine(line);
        if (!delta) continue;
        absorb(delta);
        if (delta.reasoning.length > 0 || delta.content.length > 0) {
          onDelta({ reasoning: delta.reasoning, content: delta.content });
        }
      }
    },
    close() {
      // 流末尾没有换行时可能残留最后一个完整分片（用量分片常紧跟 [DONE]），补解析一次
      const tail = parseLine(buffer);
      if (tail) absorb(tail);
      buffer = "";
    },
  };
}

/** 把浏览器 fetch 的字节流按 UTF-8 解码成文本片段 */
async function* decodeResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** 流式请求的**无数据**超时：持续这么久没收到任何字节即判定上游静默断流，主动掐断并交给调用方重试 */
const STREAM_INACTIVITY_TIMEOUT_MS = 180_000;

/**
 * 桌面端流式请求：由 Rust 侧发起 HTTP，这里只消费回传的原始 SSE 文本。
 *
 * 事件与命令返回走不同通道、到达顺序不保证，因此以「终态事件」而非命令返回来判定这轮结束。
 * 停止信号一触发就通知 Rust 侧掐断上游连接，避免上游把整个回答跑完。
 */
async function streamViaModelProxy(
  url: string,
  key: string,
  payload: unknown,
  reader: SseReader,
  signal?: AbortSignal,
  trace?: ModelTraceSink,
): Promise<void> {
  // 已中断的请求不必再发：此时 Rust 侧还没登记取消句柄，停止信号会落空、请求照跑
  if (signal?.aborted) throw signal.reason;

  const requestId = newModelRequestId();
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let failure: unknown = null;
  let finished = false;
  // 无数据超时兜底（开发者 Jan）：上游可能停止发数据却不断开连接（静默断流），Rust 侧的
  // `stream.next()` 会永远等下去，这一轮就卡在「进行中」——没有报错、没有重试机会。这里在
  // 前端按「收到任意事件就重置计时」兜底：超时即掐断上游并按普通失败抛出，交给重试逻辑；
  // 只计无数据间隔而非总时长，长输出的正常请求不受影响。
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const disarmInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };
  const armInactivity = () => {
    disarmInactivity();
    inactivityTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      failure = new Error(
        `流式响应超时：${Math.floor(STREAM_INACTIVITY_TIMEOUT_MS / 1000)} 秒未收到任何数据，上游可能已静默断流。`,
      );
      settle();
      void abortModelStream(requestId).catch(() => {});
    }, STREAM_INACTIVITY_TIMEOUT_MS);
  };
  armInactivity();
  trace?.({ kind: "event", name: "transport_start", data: { requestId, transport: "desktop", url } });
/** 函数级说明（开发者 Jan）：执行 forwardAbort 的单一职责，并返回可供调用方继续处理的结果。 */
  const forwardAbort = () => {
    failure = signal?.reason ?? new DOMException("请求已中断", "AbortError");
    finished = true;
    settle();
    void abortModelStream(requestId).catch(() => {
      trace?.({ kind: "event", name: "abort_command_failed", data: { requestId } });
    });
  };

  const unlisten = await listenModelStream((event) => {
    if (finished || event.requestId !== requestId) return;
    armInactivity();
    if (event.kind !== "chunk") finished = true;
    switch (event.kind) {
      case "chunk":
        try { reader.push(event.text ?? ""); }
        catch (error) {
          failure = error;
          finished = true;
          settle();
          void abortModelStream(requestId).catch(() => {});
        }
        break;
      case "done":
        settle();
        break;
      case "aborted":
        // 用信号自身的 reason：请求超时带了「请求超时」文案，直接用它更贴近真实原因
        failure = signal?.reason ?? new DOMException("模型请求已中断", "AbortError");
        settle();
        break;
      case "httpError":
        trace?.({ kind: "event", name: "http_response", data: { status: event.status } });
        trace?.({ kind: "response", payload: event.body ?? "" });
        failure = Object.assign(new HttpError(event.status ?? 0, event.body ?? ""), { traceReason: "http_error" });
        settle();
        break;
      case "error":
        failure = new Error(event.message ?? "模型请求失败");
        settle();
        break;
    }
  });

  try {
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    else {
      void startModelStream({ requestId, url, key, payload }).catch((error: unknown) => {
        if (finished) return;
        failure = Object.assign(new Error(describeTraceError(error), { cause: error }), { traceReason: "startup_error" });
        finished = true;
        settle();
      });
    }
    await settled;
    if (failure !== null) throw failure;
    trace?.({ kind: "event", name: "http_response", data: { status: 200, inferred: true } });
    reader.close();
  } finally {
    disarmInactivity();
    unlisten();
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** 向模型服务发起一次流式对话；流结束时返回本轮的工具调用，中断时抛出 AbortError */
export async function streamChatCompletion(
  options: StreamChatOptions,
): Promise<StreamChatResult> {
  const hasTools = (options.tools?.length ?? 0) > 0;
  const url = chatEndpoint(options.url);
  const { trace } = options;
  const diagnostic = createStreamTrace(trace);
  let failureReason = "startup_error";
  // 请求体在这里构造一次：Rust 侧只做转发，不感知协议字段
  const payload = {
    model: options.model,
    messages: options.messages,
    stream: true,
    // 让服务端在流末尾补一个 usage 分片；不返回时前端不展示用量，不做本地估算
    stream_options: { include_usage: true },
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    ...(hasTools ? { tools: options.tools, tool_choice: "auto" } : {}),
  };
  trace?.({ kind: "request", payload });
  trace?.({ kind: "event", name: "request_metadata", data: { url, transport: isDesktopRuntime() ? "desktop" : "browser" } });

  const pending = new Map<number, ToolCallAccumulator>();
  // 服务端可能不止回一次用量（分片合并场景），取最后一次即最终值
  let usage: UsageInfo | null = null;
  const reader = createSseReader(options.onDelta, pending, (next) => {
    usage = next;
  });
  // 转储要的是服务端原文，因此包装一层在解析之前记下分片，而不是记解析后的增量
  const traced: SseReader = {
    push(text) {
      diagnostic.chunk(text);
      reader.push(text);
    },
    close() {
      reader.close();
    },
  };

  try {
    if (options.signal?.aborted) throw options.signal.reason;
    failureReason = "transport_error";
    if (isDesktopRuntime()) {
      await streamViaModelProxy(url, options.key, payload, traced, options.signal, trace);
    } else {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.key}`,
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });

      trace?.({ kind: "event", name: "http_response", data: { status: response.status } });
      if (!response.ok) {
        failureReason = "http_error";
        const text = await response.text();
        trace?.({ kind: "response", payload: text });
        throw new HttpError(response.status, text);
      }
      if (!response.body) throw new Error("模型服务未返回流式响应");

      for await (const text of decodeResponseBody(response.body)) traced.push(text);
      traced.close();
    }
  } catch (error) {
    const reason = error && typeof error === "object" && "traceReason" in error ? String(error.traceReason) : failureReason;
    diagnostic.error(error, options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError") ? "aborted" : reason);
    throw error;
  }
  diagnostic.end();

  const toolCalls: ToolCall[] = [...pending.values()]
    .sort((left, right) => left.index - right.index)
    .filter((item) => item.name !== null)
    .map((item) => ({
      id: item.id ?? item.name ?? "",
      type: "function",
      function: { name: item.name as string, arguments: item.arguments },
    }));

  return { toolCalls, usage };
}

/** 一次非流式对话请求的参数 */
export interface ChatCompletionOptions {
  /** 模型服务基础地址，如 https://api.octopuses.vip/v1 */
  url: string;
  /** 访问密钥 */
  key: string;
  /** 模型 id */
  model: string;
  messages: ChatMessage[];
  /** 中断信号（如用户点了停止）；与超时任一触发都会中止请求 */
  signal?: AbortSignal;
  /** 单次请求超时（毫秒）；到点自动中止并抛出 AbortError。不传表示不额外限时 */
  timeoutMs?: number;
  /** 请求与响应的转储出口；不传即不转储 */
  trace?: ModelTraceSink;
  /** 失败后的自动重试次数（指数退避）；不传表示不重试。用户中断与请求超时不重试 */
  retries?: number;
}

/**
 * 向模型服务发起一次**非流式**对话，返回助手正文。
 *
 * 用于「不进入主对话流」的旁路调用（命令审批评审、导出评审、自动化建议等）：调用方只关心最终文本，
 * 不需要逐字渲染。超时用内部控制器实现，并与外部 `signal` 联动，任一触发即中止。
 * 失败时按 `retries` 自动重试（指数退避 1s → 2s → 4s…上限 8s），与会话内模型请求的重试体验对齐；
 * 用户主动停止 / 超时（AbortError）不重试，立即抛出。
 * 正文为空（例如模型只回了思考内容）时返回空串，由调用方按「无有效输出」处理。
 */
export async function requestChatCompletion(options: ChatCompletionOptions): Promise<string> {
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await requestChatCompletionOnce(options);
    } catch (error) {
      // 三类失败不重试：用户主动中断 / 请求超时（AbortError）是意图或大概率复现；
      // 4xx（408/429 除外）是确定性错误——请求本身不会被接受，重试只会原样再失败并多花费用
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof HttpError && error.status >= 400 && error.status < 500
        && error.status !== 408 && error.status !== 429) throw error;
      lastError = error;
    }
  }
  // 重试耗尽：把已重试的事实写进错误信息，调用方与用户能区分「没重试就失败」和「重试了也没用」
  if (retries > 0 && lastError instanceof Error && !lastError.message.includes("已自动重试")) {
    return await Promise.reject(new Error(`${lastError.message}（已自动重试 ${retries} 次仍失败，可稍后重试或检查模型服务状态）`));
  }
  throw lastError;
}

/** 函数级说明（开发者 Jan）：执行 requestChatCompletionOnce 的单一职责，并返回可供调用方继续处理的结果。 */
async function requestChatCompletionOnce(options: ChatCompletionOptions): Promise<string> {
  const timeout = options.timeoutMs ?? 0;
  let failureReason = "startup_error";
  const controller = new AbortController();
  const timer =
    timeout > 0
      ? setTimeout(() => controller.abort(new DOMException("请求超时", "AbortError")), timeout)
      : null;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) forwardAbort();
    else options.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const url = chatEndpoint(options.url);
    const requestBody = {
      model: options.model,
      messages: options.messages,
      stream: false,
    };
    options.trace?.({ kind: "request", payload: requestBody });
    options.trace?.({ kind: "event", name: "request_metadata", data: { url, transport: isDesktopRuntime() ? "desktop" : "browser" } });
    const body = JSON.stringify(requestBody);

    if (controller.signal.aborted) throw controller.signal.reason;
    failureReason = "transport_error";
    let status: number;
    let text: string;
    if (isDesktopRuntime()) {
      const result = await fetchModelResource({ method: "POST", url, key: options.key, body, signal: controller.signal });
      if (result.aborted) throw controller.signal.reason ?? new DOMException("请求已中断", "AbortError");
      status = result.status;
      text = result.body;
    } else {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.key}` },
        body, signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    }
    options.trace?.({ kind: "event", name: "http_response", data: { status } });
    failureReason = status < 200 || status >= 300 ? "http_error" : "response_parse_error";
    let payload: { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
    try { payload = JSON.parse(text) as typeof payload; }
    catch (error) {
      options.trace?.({ kind: "response", payload: text });
      if (status < 200 || status >= 300) throw new HttpError(status, text);
      throw error;
    }
    options.trace?.({ kind: "response", payload });
    if (status < 200 || status >= 300) {
      throw new HttpError(status, text);
    }
    for (const choice of payload.choices ?? []) {
      if (choice.finish_reason != null) options.trace?.({ kind: "event", name: "finish_reason", data: choice.finish_reason });
    }
    options.trace?.({ kind: "done", reason: "response_received", completed: true });
    return payload.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    options.trace?.({ kind: "error", message: describeTraceError(error), reason: controller.signal.aborted ? "aborted" : failureReason });
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}