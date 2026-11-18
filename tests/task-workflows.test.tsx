import assert from "node:assert/strict";
import test from "node:test";
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
const { taskKey, taskState, useTaskStore, setGoal, changeGoal, updatePlan } = await import("../src/tasks/store");
const { journalUpdate, pendingRequests, readJournal } = await import("../src/tasks/journal");
const { runToolCall } = await import("../src/hooks/agentToolCall");
const { memoryContext, redactMemory, useMemoryStore } = await import("../src/memories/store");
const { effectiveWorkspacePath } = await import("../src/app/state/workspace");
import type { ToolCallExecutionContext } from "../src/hooks/agentToolCall";

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
