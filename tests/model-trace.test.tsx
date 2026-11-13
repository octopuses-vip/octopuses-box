import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { streamChatCompletion, requestChatCompletion, createStreamTrace, type ModelTraceEvent } from "../src/model/client";
import { createModelTrace, closeModelTraces, redactModelTrace } from "../src/model/trace";
import { useAppStore } from "../src/app/state";
import { readCacheFile } from "../src/app/desktop/cache";

const terminal = (events: ModelTraceEvent[]) => events.filter((e) => e.kind === "done" || e.kind === "error");
const base = { url: "https://model.test/v1", key: "secret", model: "test", messages: [] };
const sse = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test("协议标记、EOF 分层且终态幂等", () => {
  for (const [text, completed] of [[sse, true], ['data: {"choices":[]}\n', false]] as const) {
    const events: ModelTraceEvent[] = [];
    const trace = createStreamTrace((e) => events.push(e));
    trace.chunk(text.slice(0, 12)); trace.chunk(text.slice(12)); trace.end(); trace.end(); trace.error("late");
    assert.equal(terminal(events).length, 1);
    assert.equal((terminal(events)[0] as { completed: boolean }).completed, completed);
    assert(events.some((e) => e.kind === "event" && e.name === "transport_eof"));
  }
});

test("浏览器直接调用覆盖流式成功/EOF/HTTP/取消/非流式", async () => {
  const original = globalThis.fetch;
  try {
    for (const text of [sse, 'data: {"choices":[]}\n']) {
      globalThis.fetch = async () => new Response(text);
      const events: ModelTraceEvent[] = [];
      const trace = (e: ModelTraceEvent) => events.push(e);
      await streamChatCompletion({ ...base, onDelta() {}, trace });
      assert.equal(terminal(events).length, 1);
      assert.equal((terminal(events)[0] as { completed: boolean }).completed, text === sse);
      assert.equal(events.filter((e) => e.kind === "chunk").length, 1);
    }
    globalThis.fetch = async () => new Response('{"error":{"message":"denied"}}', { status: 401 });
    const errors: ModelTraceEvent[] = [];
    await assert.rejects(streamChatCompletion({ ...base, onDelta() {}, trace: (e) => errors.push(e) }));
    assert.equal(terminal(errors).length, 1);
    assert(errors.some((e) => e.kind === "response"));
    const abort = new AbortController(); abort.abort();
    const canceled: ModelTraceEvent[] = [];
    await assert.rejects(requestChatCompletion({ ...base, signal: abort.signal, trace: (e) => canceled.push(e) }));
    assert.equal((terminal(canceled)[0] as { reason: string }).reason, "aborted");
    globalThis.fetch = async () => new Response('{"choices":[{"message":{"content":"ok"}}]}');
    const events: ModelTraceEvent[] = [];
    assert.equal(await requestChatCompletion({ ...base, trace: (e) => events.push(e) }), "ok");
    assert.equal(terminal(events).length, 1);
    globalThis.fetch = async () => { throw new TypeError("network"); };
    const failed: ModelTraceEvent[] = [];
    await assert.rejects(streamChatCompletion({ ...base, onDelta() {}, trace: (e) => failed.push(e) }));
    assert.equal(terminal(failed).length, 1);
  } finally { globalThis.fetch = original; }
});

test("转储显式 flush、运行关闭、开关快照、递归脱敏", async () => {
  useAppStore.setState({ modelTraceEnabled: true, cachePath: "trace-tests" });
  const trace = createModelTrace({ scope: "agent", threadId: "thread", runId: "flush", round: 1, agentName: "agent" });
  trace({ kind: "request", payload: { messages: "正文保留", nested: { api_key: "hidden" }, url: "https://user:pass@host/path?token=hidden" } });
  await trace.flush();
  let text = await readCacheFile("trace-tests", "logs/model-trace/thread-flush.jsonl");
  assert.match(text!, /正文保留/); assert.doesNotMatch(text!, /hidden|user:pass/); assert.match(text!, /agentName/);
  useAppStore.setState({ modelTraceEnabled: false });
  const next = createModelTrace({ scope: "agent", threadId: "thread", runId: "flush", round: 2 });
  next({ kind: "request", payload: {} });
  next({ kind: "done", reason: "protocol_done", completed: true }); next({ kind: "done" });
  await closeModelTraces("flush");
  await closeModelTraces("flush");
  text = await readCacheFile("trace-tests", "logs/model-trace/thread-flush.jsonl");
  const lines = text!.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.kind === "done").length, 2);
  assert(lines.some((line) => line.reason === "run_closed"));
  assert.equal((redactModelTrace({ password: "secret", items: [{ Authorization: "secret" }] }) as any).password, "[REDACTED]");
});

test("桌面代理流式成功/取消/HTTP/启动错误及非流式无重复终态", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as any;
  try {
    for (const mode of ["success", "http", "error", "aborted", "startup", "eof"] as const) {
      mockIPC(async (cmd, args) => {
        if (cmd === "model_stream") {
          if (mode === "startup") throw new Error("startup");
          const requestId = args!.requestId;
          if (mode === "success" || mode === "eof") {
            await emit("model-stream", { requestId, kind: "chunk", text: mode === "success" ? sse : "data: {}\n" });
            await emit("model-stream", { requestId, kind: "done" });
          } else await emit("model-stream", { requestId, kind: mode === "http" ? "httpError" : mode, status: 403, body: "denied", message: "broken" });
        }
      }, { shouldMockEvents: true });
      const events: ModelTraceEvent[] = [];
      const trace = (e: ModelTraceEvent) => events.push(e);
      try { await streamChatCompletion({ ...base, onDelta() {}, trace }); } catch { /* 预期的传输失败 */ }
      assert.equal(terminal(events).length, 1, mode);
      if (mode === "eof") assert.equal((terminal(events)[0] as { completed: boolean }).completed, false);
      await new Promise((resolve) => setImmediate(resolve));
      clearMocks();
    }
    mockIPC((cmd) => cmd === "model_fetch" ? { status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}', aborted: false } : undefined);
    const events: ModelTraceEvent[] = [];
    assert.equal(await requestChatCompletion({ ...base, trace: (e) => events.push(e) }), "ok");
    assert.equal(terminal(events).length, 1);
  } finally { clearMocks(); globalThis.window = oldWindow; }
});

test("小缓冲定时落盘，关闭后无残留定时器；禁用出口不写盘", async () => {
  useAppStore.setState({ modelTraceEnabled: true, cachePath: "trace-tests" });
  const trace = createModelTrace({ scope: "suggest", threadId: "thread", runId: "timed", round: null });
  trace({ kind: "request", payload: { message: "timer" } });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.match((await readCacheFile("trace-tests", "logs/model-trace/thread-timed.jsonl"))!, /timer/);
  await trace.close();
  useAppStore.setState({ modelTraceEnabled: false });
  const disabled = createModelTrace({ scope: "suggest", threadId: "thread", runId: "disabled", round: null });
  disabled({ kind: "request", payload: {} });
  await disabled.close();
  assert.equal(await readCacheFile("trace-tests", "logs/model-trace/thread-disabled.jsonl"), null);
});

test("共享 writer 保持事件与请求顺序，事件出口不补模型失败", async () => {
  useAppStore.setState({ modelTraceEnabled: true, cachePath: "trace-tests" });
  const context = { scope: "agent" as const, threadId: "thread", runId: "ordered", round: 0 };
  const run = createModelTrace({ ...context, round: null });
  run({ kind: "event", name: "run.start" });
  createModelTrace(context)({ kind: "event", name: "summary.start" });
  const request = createModelTrace({ ...context, requestId: "request" });
  request({ kind: "request", payload: {} });
  request({ kind: "done", reason: "protocol_done", completed: true });
  createModelTrace(context)({ kind: "event", name: "summary.finish" });
  run({ kind: "event", name: "run.finish" });
  run({ kind: "done", completed: true });
  await closeModelTraces("ordered");
  const lines = (await readCacheFile("trace-tests", "logs/model-trace/thread-ordered.jsonl"))!.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.name ?? line.kind), ["run.start", "summary.start", "request", "done", "summary.finish", "run.finish", "done"]);
  assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(lines.every((line) => line.reason !== "run_closed"));
});

test("协议未完成时的真实错误仍产生失败终态", () => {
  const events: ModelTraceEvent[] = [];
  const diagnostic = createStreamTrace((event) => events.push(event));
  diagnostic.chunk(sse);
  diagnostic.error(new Error("real failure"));
  assert.equal(terminal(events)[0].kind, "error");
});

test("写盘失败只诊断、不产生未处理拒绝，后续 flush 可继续", async () => {
  const oldWindow = globalThis.window;
  const oldWarn = console.warn;
  globalThis.window = { crypto: globalThis.crypto } as any;
  const warnings: unknown[][] = [];
  let writes = 0;
  try {
    console.warn = (...args) => { warnings.push(args); };
    mockIPC((cmd) => { if (cmd === "cache_append" && ++writes === 1) throw new Error("secret error"); });
    useAppStore.setState({ modelTraceEnabled: true, cachePath: "trace-tests" });
    const trace = createModelTrace({ scope: "suggest", threadId: "thread", runId: "failure", round: null });
    trace({ kind: "request", payload: {} }); await trace.flush();
    trace({ kind: "done" }); await trace.close();
    assert.equal(writes, 2); assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /secret error/);
  } finally { clearMocks(); globalThis.window = oldWindow; console.warn = oldWarn; }
});
