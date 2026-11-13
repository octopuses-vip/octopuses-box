import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExecutionDetails, Message, Thread } from "../src/app/types";
import { applyExecutionEvent, finishExecution } from "../src/conversation/executionDetails";
import { ExecutionDetailsCard } from "../src/conversation/blocks/ExecutionDetailsCard";
import { fromStoredConversation, toStoredConversation } from "../src/cache/sessionDb";
import { useAppStore } from "../src/app/state";
import { useAgentRun } from "../src/hooks/useAgentRun";

const initial: ExecutionDetails = {
  runId: "run", agentId: "default", agentName: "default", selectedAgentId: "missing",
  requestedModel: "expected", actualModel: "available", fallbackReason: "指定模型不可用",
  projectId: "project", outcome: "running", tools: [],
};
const thread: Thread = { id: "execution-test", title: "执行详情", projectId: "", createdAt: 1, updatedAtLabel: "刚刚", contextEntries: [], sources: [], executionContext: "local", workspacePath: null, worktreePath: null, branch: null, permissionMode: "auto-readonly", reviewComments: [], agentId: null, parentThreadId: null, contextSummary: "", contextCoveredCount: 0 };

const event = (name: string, data: Record<string, unknown> = {}) => ({ kind: "event" as const, name, data });

test("工具生命周期不响应 SSE 与协议终态，失败原因不持久化原始报错", () => {
  assert.equal(applyExecutionEvent(initial, { kind: "chunk", text: "data: secret" }), initial);
  assert.equal(applyExecutionEvent(initial, { kind: "done", reason: "run_closed", completed: false }), initial);
  let details = applyExecutionEvent(initial, event("tool_start", { toolCallId: "call", toolName: "read_file" }));
  assert.deepEqual(details.tools, [{ callId: "call", name: "read_file", status: "running", reason: undefined }]);
  details = applyExecutionEvent(details, event("tool_error", { toolCallId: "call", toolName: "read_file", reason: "denied" }));
  assert.deepEqual(details.tools, [{ callId: "call", name: "read_file", status: "error", reason: "denied" }]);
  assert.equal(finishExecution(details, "completed").outcome, "success");
  assert.equal(finishExecution(details, "tokenBudget").outcome, "failed");
  assert.equal(finishExecution(details, "userInterrupted").outcome, "aborted");
});

test("执行详情默认折叠、展示模型信息，随既有 payload 往返", () => {
  const details = finishExecution(initial, "error");
  const message: Message = { id: "answer", role: "assistant", items: [{ id: "execution", type: "execution_details", details }] };
  const restored = fromStoredConversation(toStoredConversation(thread, [message]));
  assert.deepEqual(restored.messages[0], message);
  useAppStore.setState({ model: "changed" });
  const html = renderToStaticMarkup(createElement(ExecutionDetailsCard, { details }));
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  for (const text of ["default", "missing", "expected", "available", "指定模型不可用", "运行出错"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /changed/);
});

test("真实入口即使未开启 modelTrace，保存失败仍生成唯一执行详情并标记失败", async () => {
  const storage = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw new Error("disk full"); }, removeItem: (key: string) => storage.delete(key) } });
  const before = useAppStore.getState();
  useAppStore.setState({ cachePath: "/test/execution", sessionsRestored: true, sessionsRestoreError: null, threads: [thread], messages: { [thread.id]: [] }, modelTraceEnabled: false, modelConfig: { url: "https://model.example/v1", key: "secret", modelId: "actual", supportsImages: false, visionModelId: "" } });
  let run!: ReturnType<typeof useAgentRun>["run"];
  function Probe() { run = useAgentRun().run; return null; }
  renderToStaticMarkup(createElement(Probe));
  try {
    assert.equal(await run(thread.id, "任务", []), "failed");
    const items = useAppStore.getState().messages[thread.id].flatMap((message) => message.items).filter((item) => item.type === "execution_details");
    assert.equal(items.length, 1);
    assert.equal(items[0].details.outcome, "failed");
    assert.equal(items[0].details.stopReason, "error");
    assert.equal(items[0].details.agentId, "default");
    assert.doesNotMatch(JSON.stringify(items), /secret|model.example/);
  } finally {
    useAppStore.setState(before);
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
