import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
const { taskKey, taskState, useTaskStore, setGoal, changeGoal, updatePlan, taskInstruction } = await import("../src/tasks/store");
const { TASK_TOOLS, filterTaskTools, runTaskTool } = await import("../src/tasks/tools");
const { journalUpdate, pendingRequests, readJournal } = await import("../src/tasks/journal");
const { runToolCall } = await import("../src/hooks/agentToolCall");
const { memoryContext, redactMemory, useMemoryStore } = await import("../src/memories/store");
const { effectiveWorkspacePath } = await import("../src/app/state/workspace");
const { useAppStore } = await import("../src/app/state");
const { useAgentRun } = await import("../src/hooks/useAgentRun");
import type { ChatMessage, ChatTool } from "../src/model/client";
import type { ToolCallExecutionContext } from "../src/hooks/agentToolCall";

test("普通任务的完成计划不会提供目标验收，旧调用不产生失败卡片或创建目标", async () => {
  const scope = "ordinary-goal-check";
  const key = taskKey(scope, "transcript");
  updatePlan(key, [{ step: "整理文字稿并保存", status: "completed" }]);
  assert.deepEqual(filterTaskTools(key, TASK_TOOLS).map((tool) => tool.function.name), ["update_plan"]);
  assert.match(taskInstruction(key), /普通任务.*直接回复结果/);
  assert.doesNotMatch(taskInstruction(key), /finish_goal/);
  let cards = 0;
  const context = { controller: new AbortController(), valid: () => true, cachePath: scope, threadId: "transcript",
    skillToolScope: { mounted: new Set(["finish_goal"]) }, push: () => { cards++; },
  } as unknown as ToolCallExecutionContext;
  const result = await runToolCall({ id: "stale-finish", type: "function", function: { name: "finish_goal", arguments: '{"evidence":"文字稿已保存"}' } }, context);
  assert.match(String(result.content), /普通任务.*直接回复结果/);
  assert.equal(cards, 0);
  assert.equal(taskState(key).goal, null);
  assert.equal(taskState(key).plan[0].status, "completed");
});

test("目标验收随暂停、继续和完成更新，仍严格检查未完成步骤与文字证据", () => {
  const key = taskKey("scope", "goal-tool-lifecycle");
  const names = () => filterTaskTools(key, TASK_TOOLS).map((tool) => tool.function.name);
  setGoal(key, "完成迁移并验证");
  assert(names().includes("finish_goal"));
  updatePlan(key, [{ step: "实施与验证", status: "in_progress" }]);
  assert.match(runTaskTool(key, "finish_goal", '{"evidence":"已检查"}'), /任务状态更新失败/);
  updatePlan(key, [{ step: "实施与验证", status: "completed" }]);
  assert.match(runTaskTool(key, "finish_goal", '{"evidence":{"unchecked":true}}'), /任务状态更新失败/);
  assert.equal(taskState(key).goal?.status, "active");
  changeGoal(key, "paused");
  assert(!names().includes("finish_goal"));
  assert.throws(() => changeGoal(key, "complete", "已验证"), /仅可验收/);
  assert.match(runTaskTool(key, "finish_goal", '{"evidence":"已验证"}'), /等待用户继续/);
  assert.equal(taskState(key).goal?.status, "paused");
  changeGoal(key, "active");
  useTaskStore.getState().patch(key, { mode: "plan" });
  assert(!names().includes("finish_goal"));
  assert.doesNotMatch(taskInstruction(key), /调用 finish_goal/);
  useTaskStore.getState().patch(key, { mode: "execute" });
  assert.equal(runTaskTool(key, "finish_goal", '{"evidence":"迁移与测试均通过"}'), "已更新任务状态");
  assert.equal(taskState(key).goal?.status, "complete");
  assert.equal(taskState(key).goal?.evidence, "迁移与测试均通过");
  assert(!names().includes("finish_goal"));
  assert.match(taskInstruction(key), /已经验收完成/);
  assert.match(taskInstruction(key), /按用户当前请求处理/);
  assert.doesNotMatch(taskInstruction(key), /调用 finish_goal/);
});

test("目标完成需要计划全部完成和验证证据；状态按缓存和会话隔离", () => {
  const key = taskKey("scope", "goal"); setGoal(key, "完成迁移并通过测试");
  updatePlan(key, [{ step: "实施", status: "in_progress" }, { step: "验证", status: "pending" }]);
  assert.throws(() => changeGoal(key, "complete", "tests passed"), /全部计划/);
  assert.throws(() => updatePlan(key, [{ step: "A", status: "in_progress" }, { step: "B", status: "in_progress" }]), /一个/);
  updatePlan(key, [{ step: "实施并验证", status: "completed" }]); assert.throws(() => changeGoal(key, "complete"), /验证/);
  changeGoal(key, "complete", "运行迁移检查与集成测试，全部通过"); assert.equal(taskState(key).goal?.status, "complete");
  assert.equal(taskState(taskKey("other", "goal")).goal, null);
});
test("计划模式在执行入口拒绝文件写入和命令，不能仅靠提示词约束", async () => {
  const key = taskKey("scope", "plan"); useTaskStore.getState().patch(key, { mode: "plan" });
  const context = { controller: new AbortController(), valid: () => true, cachePath: "scope", threadId: "plan" } as unknown as ToolCallExecutionContext;
  for (const name of ["write_file", "apply_patch", "test_runner", "run_subagent", "browser_live"]) {
    const result = await runToolCall({ id: name, type: "function", function: { name, arguments: "{}" } }, context);
    assert.match(String(result.content), /计划模式不允许/);
  }
});
test("恢复日志并发写入不丢请求，完成记录释放附件，缓存之间隔离", async () => {
  await Promise.all(["a", "b"].map((id) => journalUpdate("journal", id, { threadId: "t", prompt: id, attachments: [], status: "queued", createdAt: 1 })));
  assert.equal((await pendingRequests("journal")).length, 2);
  await journalUpdate("journal", "a", { status: "success" });
  assert.deepEqual((await pendingRequests("journal")).map((r) => r.id), ["b"]);
  assert.equal((await readJournal("journal")).find((r) => r.id === "a")?.attachments.length, 0);
  assert.equal((await pendingRequests("other-journal")).length, 0);
});
test("记忆遵守项目、缓存和会话使用控制，并清除常见密钥", () => {
  useMemoryStore.setState({ enabled: true, entries: [{ id: "m", scope: "s", projectId: "p", text: "使用中文", sourceThread: "t", updatedAt: 1 }], chats: {} });
  assert.match(memoryContext("s", "t", "p"), /使用中文/); assert.equal(memoryContext("other", "t", "p"), ""); assert.equal(memoryContext("s", "t", "other"), "");
  useMemoryStore.setState({ chats: { [taskKey("s", "t")]: { use: false, contribute: false } } }); assert.equal(memoryContext("s", "t", "p"), "");
  assert.ok(!redactMemory("token=secret-value api_key=secret-value").includes("secret-value"));
});
test("项目只能切换到明确挂载的目录，Worktree 仍优先", () => {
  const state = { activeThreadId: "t", threads: [{ id: "t", projectId: "p", executionContext: "local", workspacePath: "/backend" }], projects: [{ id: "p", path: "/frontend", folders: ["/backend"] }] } as unknown as Parameters<typeof effectiveWorkspacePath>[0];
  assert.equal(effectiveWorkspacePath(state), "/backend"); state.threads[0].workspacePath = "/outside"; assert.equal(effectiveWorkspacePath(state), "/frontend");
  state.threads[0].executionContext = "worktree"; state.threads[0].worktreePath = "/isolated"; assert.equal(effectiveWorkspacePath(state), "/isolated");
});

test("长 MCP 工具名满足接口限制，名称冲突会拒绝挂载而非调用另一服务", async () => {
  const { mcpToolName, buildMcpBindings } = await import("../src/mcp/tool");
  const server = (id: string) => ({ id, name: id, command: "https://example.invalid/mcp", args: [], env: {}, enabled: true });
  const tool = { name: "a_very_long_tool_".repeat(8), description: "test", inputSchema: { type: "object" } };
  assert.ok(mcpToolName(server("long-server-".repeat(6)), tool).length <= 64);
  assert.notEqual(mcpToolName(server("long-server-".repeat(6)), tool), mcpToolName(server("other-server-".repeat(6)), tool));
  assert.throws(() => buildMcpBindings([server("a-b"), server("a_b")], { "a-b": [{ ...tool, name: "echo" }], "a_b": [{ ...tool, name: "echo" }] }), /冲突/);
});

test("实际模型请求区分普通计划和持续目标，验收完成后下一轮同步收回工具与提示", { timeout: 5000 }, async () => {
  const before = useAppStore.getState();
  const beforeMemory = useMemoryStore.getState();
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  let agent!: ReturnType<typeof useAgentRun>;
  function Probe() { agent = useAgentRun(); return null; }
  renderToStaticMarkup(createElement(Probe));
  const scope = "/test/task-goal-tools";
  try {
    useMemoryStore.setState({ enabled: false });
    useAppStore.setState({ cachePath: scope, sessionsRestored: true, sessionsRestoreError: null,
      modelTraceEnabled: false, contextCompactThresholdTokens: 0, maxToolRounds: 10,
      modelRetryCount: 0, model: "chat", modelConfig: { url: "https://model.example/v1", key: "test", modelId: "chat", supportsImages: false, visionModelId: "" } });
    for (const persistent of [false, true]) {
      const threadId = useAppStore.getState().createThread("整理文字稿", "", false);
      const key = taskKey(scope, threadId);
      if (persistent) {
        setGoal(key, "整理文字稿并验证");
        updatePlan(key, [{ step: "整理并检查", status: "completed" }]);
      }
      const requests: { tools: ChatTool[]; messages: ChatMessage[] }[] = [];
      const journal = new Map<string, string>();
      mockIPC(async (cmd, raw) => {
        const args = raw as Record<string, unknown>;
        if (cmd === "cache_read_optional") return journal.get(String(args.relative)) ?? null;
        if (cmd === "cache_write_atomic") { journal.set(String(args.relative), String(args.contents)); return; }
        if (["cache_write", "cache_append", "artifact_prepare_dir", "session_db_save"].includes(cmd)) return;
        assert.equal(cmd, "model_stream");
        const payload = args.payload as { tools: ChatTool[]; messages: ChatMessage[] };
        const round = requests.length;
        requests.push(payload);
        assert.equal(payload.tools.some((tool) => tool.function.name === "finish_goal"), persistent && round === 0);
        if (persistent && round > 0) {
          assert.match(String(payload.messages[0].content), /已经验收完成/);
          assert.doesNotMatch(String(payload.messages[0].content), /调用 finish_goal/);
        }
        const finished = persistent ? round > 0 : round > 2;
        const name = persistent || round === 2 ? "finish_goal" : "update_plan";
        const parameters = name === "finish_goal" ? { evidence: "已保存并核对文字稿" }
          : { plan: [{ step: "整理并检查", status: round === 0 ? "in_progress" : "completed" }] };
        const delta = finished ? { content: "文字稿已整理完成。" } : {
          tool_calls: [{ index: 0, id: `task-call-${round}`, type: "function", function: { name, arguments: JSON.stringify(parameters) } }],
        };
        const text = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
        await emit("model-stream", { requestId: args.requestId, kind: "chunk", text });
        await emit("model-stream", { requestId: args.requestId, kind: "done" });
      }, { shouldMockEvents: true });
      assert.equal(await agent.run(threadId, "整理并检查文字稿", []), "success");
      const cards = useAppStore.getState().messages[threadId].at(-1)!.items.filter((item) => item.type === "tool_call");
      assert(cards.every((card) => card.status === "success"));
      assert.equal(cards.some((card) => card.name === "finish_goal"), persistent);
      assert.equal(taskState(key).goal?.status ?? null, persistent ? "complete" : null);
      assert.equal(requests.length, persistent ? 2 : 4);
      clearMocks();
    }
  } finally {
    clearMocks(); globalThis.window = oldWindow; useAppStore.setState(before); useMemoryStore.setState(beforeMemory);
  }
});
