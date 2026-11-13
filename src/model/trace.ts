/** 模型诊断转储：保留会话正文；凭据脱敏不是完整的隐私匿名化。 */
import { appendCacheFile } from "../app/desktop/cache";
import { useAppStore } from "../app/state";
import type { ModelTraceEvent, ModelTraceSink } from "./client";

const TRACE_DIR = "logs/model-trace";
const FLUSH_CHARS = 64 * 1024;
const FLUSH_MS = 1000;

/** 同一运行的调用归属及可选执行上下文。 */
export interface ModelTraceContext {
  scope: "agent" | "suggest" | "review";
  threadId: string;
  runId: string;
  round: number | null;
  agentId?: string;
  agentName?: string;
  model?: string;
  fallbackReason?: string;
  projectId?: string;
  requestId?: string;
}

/** 可调用出口保持旧接口兼容，显式冲刷用于运行 finally。 */
export interface ModelTraceHandle extends ModelTraceSink {
  flush(): Promise<void>;
  close(): Promise<void>;
}

let writeQueue: Promise<void> = Promise.resolve();
const traces = new Map<string, Set<ModelTraceHandle>>();
const runSettings = new Map<string, { enabled: boolean; cachePath: string }>();
const writers = new Map<string, { runId: string; append(context: ModelTraceContext, event: ModelTraceEvent): void; flush(): Promise<void> }>();
const credentialKey = /^(authorization|proxyAuthorization|apiKey|key|accessToken|refreshToken|token|password|passwd|secret|clientSecret|privateKey|cookie|setCookie|credential|credentials)$/i;

/** 递归隐藏结构化凭据和 URL userinfo；普通正文仍然保留。 */
export function redactModelTrace(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/("(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|cookie)"\s*:\s*")((?:\\.|[^"\\])*)"/gi, '$1[REDACTED]"')
      .replace(/\bBearer\s+[a-z\d._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/data:([^;,]+);base64,([A-Za-z0-9+/=]+)/g, (_all, mime: string, data: string) => {
        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        return `data:${mime};base64,<已省略 ${Math.floor(data.length * 3 / 4) - padding} 字节>`;
      })
      .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)=)[^&#\s]*/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactModelTrace);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = credentialKey.test(key.replace(/[-_]/g, "")) ? "[REDACTED]" : redactModelTrace(item);
  }
  return result;
}

/** 同一运行文件只用一个缓冲和序号，调用顺序就是落盘顺序。 */
function createWriter(cachePath: string, relative: string, runId: string) {
  let buffer = "";
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
/** 函数级说明（开发者 Jan）：执行 flush 的单一职责，并返回可供调用方继续处理的结果。 */
  const flush = (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!buffer) return pending;
    const contents = buffer;
    buffer = "";
    pending = writeQueue = writeQueue.then(() => appendCacheFile(cachePath, relative, contents)).catch((error: unknown) => {
      console.warn("[model-trace] write_failed", { runId, errorType: error instanceof Error ? error.name : typeof error });
    });
    return pending;
  };
  return {
    runId,
    flush,
    append(context: ModelTraceContext, event: ModelTraceEvent) {
      const metadata = { ts: new Date().toISOString(), seq: ++seq, ...context };
      try {
        buffer += `${JSON.stringify(redactModelTrace({ ...metadata, ...event }))}\n`;
      } catch {
        buffer += `${JSON.stringify(redactModelTrace({ ...metadata, kind: "event", name: "serialization_failed" }))}\n`;
      }
      if (event.kind === "done" || event.kind === "error" || buffer.length >= FLUSH_CHARS) void flush();
      else if (timer === undefined) {
        timer = setTimeout(() => { void flush(); }, FLUSH_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    },
  };
}

/** 关闭该运行全部出口，并等候已排队的写盘；重复调用安全。 */
export async function closeModelTraces(runId: string): Promise<void> {
  await Promise.all([...traces.get(runId) ?? []].map((trace) => trace.close()));
  for (const [key, writer] of writers) {
    if (writer.runId !== runId) continue;
    await writer.flush();
    writers.delete(key);
  }
  await writeQueue;
  traces.delete(runId);
  runSettings.delete(runId);
}

/** 创建上下文出口；事件不会开启模型请求，只有 request 才需要模型终态。 */
export function createModelTrace(context: ModelTraceContext): ModelTraceHandle {
  const state = useAppStore.getState();
  const settings = runSettings.get(context.runId) ?? {
    enabled: state.modelTraceEnabled,
    cachePath: state.cachePath ?? "",
  };
  if (context.scope === "agent") runSettings.set(context.runId, settings);
  const enabled = settings.enabled && Boolean(settings.cachePath);
  const safePart = (part: string) => part.replace(/[^a-zA-Z0-9._-]/g, "_");
  const relative = `${TRACE_DIR}/${safePart(context.threadId)}-${safePart(context.runId)}.jsonl`;
  const key = JSON.stringify([settings.cachePath, relative]);
  let closed = false;
  let terminal = false;
  let requestOpen = false;
/** 函数级说明（开发者 Jan）：执行 writer 的单一职责，并返回可供调用方继续处理的结果。 */
  const writer = () => {
    let value = writers.get(key);
    if (!value) { value = createWriter(settings.cachePath, relative, context.runId); writers.set(key, value); }
    return value;
  };
/** 函数级说明（开发者 Jan）：执行 sink 的单一职责，并返回可供调用方继续处理的结果。 */
  const sink = ((event: ModelTraceEvent) => {
    if (!enabled || closed) return;
    if (event.kind === "request") { requestOpen = true; terminal = false; }
    else if (terminal && event.kind !== "event") return;
    if (event.kind === "done" || event.kind === "error") { terminal = true; requestOpen = false; }
    const group = traces.get(context.runId) ?? new Set<ModelTraceHandle>();
    group.add(sink);
    traces.set(context.runId, group);
    writer().append(context, event);
  }) as ModelTraceHandle;
  sink.flush = () => writers.get(key)?.flush() ?? Promise.resolve();
  sink.close = async () => {
    if (!closed && requestOpen) sink({ kind: "done", reason: "run_closed", completed: false });
    closed = true;
    traces.get(context.runId)?.delete(sink);
    await sink.flush();
  };
  return sink;
}
