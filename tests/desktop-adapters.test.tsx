import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { clearCache, initCacheDir, readCacheFile, writeCacheFile } from "../src/app/desktop/cache";
import { writeArtifact, readArtifact, writeArtifactBytes, readArtifactBytes, listArtifacts } from "../src/app/desktop/artifacts";
import { ensureSessionDb, saveStoredConversation, getStoredConversation, listStoredConversations, deleteStoredConversation, type StoredConversation } from "../src/app/desktop/sessions";
import { listParallelBatches } from "../src/app/desktop/parallel";
import { flushAutomationWrites, persistAutomations } from "../src/app/state/automations";
import { useAppStore } from "../src/app/state";
import { DEFAULT_KNOWLEDGE_INDEX_AUTOMATION } from "../src/automations/samples";
import { persistParallelBatch } from "../src/app/state/parallel";
import type { ParallelBatch } from "../src/app/types";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
before(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
    },
  });
});
after(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("浏览器适配层跨模块读写文本和二进制产物，按范围清理缓存", async () => {
  const root = "/adapter-artifacts";
  const output = `${root}/outputs/2026-11-13`;
  await initCacheDir(root);
  await writeCacheFile(root, "temp/request.log", "temporary");
  await writeArtifact(output, "report.md", "科技报告");
  await writeArtifactBytes(output, "pixel.png", "AAECA/8=");
  assert.equal(await readArtifact(output, "report.md"), "科技报告");
  assert.deepEqual([...await readArtifactBytes(output, "pixel.png")], [0, 1, 2, 3, 255]);
  const artifacts = await listArtifacts(output);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts.find((item) => item.name === "pixel.png")?.kind, "image");
  assert.equal(artifacts.find((item) => item.name === "pixel.png")?.bytes, 5);
  await clearCache(root, "temp");
  assert.equal(await readCacheFile(root, "temp/request.log"), null);
  assert.equal((await listArtifacts(output)).length, 2);
  await clearCache(root, "all");
  assert.deepEqual(await listArtifacts(output), []);
});

test("浏览器会话镜像按缓存目录隔离，列表摘要不影响完整正文", async () => {
  const first = "/adapter-sessions-a";
  const second = "/adapter-sessions-b";
  const conversation: StoredConversation = {
    id: "same-id", title: "A", projectId: "project", contextEntries: "[]", sources: "[]",
    archived: false, updatedAtLabel: "刚刚", createdAt: 1, updatedAt: 2,
    messages: [{ id: "msg", role: "user", seq: 0, attachments: null,
      items: [{ id: "text", seq: 0, kind: "text", payload: '{"text":"正文"}' }] }],
  };
  await ensureSessionDb(first);
  await ensureSessionDb(second);
  await saveStoredConversation(first, conversation);
  await saveStoredConversation(second, { ...conversation, title: "B" });
  assert.equal((await listStoredConversations(first))[0].messages.length, 0);
  assert.deepEqual((await getStoredConversation(first, "same-id"))?.messages, conversation.messages);
  assert.equal((await getStoredConversation(second, "same-id"))?.title, "B");
  await deleteStoredConversation(first, "same-id");
  assert.equal(await getStoredConversation(first, "same-id"), null);
  assert.equal((await getStoredConversation(second, "same-id"))?.title, "B");
});

test("状态落盘辅助函数使用显式缓存目录，自动化与并行批次不会串库", async () => {
  const first = "/adapter-persistence-a";
  const second = "/adapter-persistence-b";
  const batch: ParallelBatch = {
    id: "batch", prompt: "验证", createdAt: 1, items: [],
  };
  persistAutomations(first, [], []);
  persistParallelBatch(second, batch);
  await Promise.resolve();
  assert.equal(await readCacheFile(first, "automations/tasks.json"), "[]");
  assert.equal(await readCacheFile(second, "automations/tasks.json"), null);
  assert.deepEqual(await listParallelBatches(first), []);
  assert.deepEqual(await listParallelBatches(second), [batch]);
});

test("本地索引立即运行保留定时计划，完成记录落盘并可从异常退出恢复", async () => {
  const scope = "/adapter-automation";
  const task = { ...DEFAULT_KNOWLEDGE_INDEX_AUTOMATION, enabled: true, nextRunAt: Date.now() + 60_000 };
  useAppStore.setState({ cachePath: scope, automations: [task], automationRuns: [], threads: [] });
  const request = useAppStore.getState().startAutomationRun(task.id, "manual");
  assert.ok(request);
  assert.equal(request.threadId, "");
  assert.equal(useAppStore.getState().threads.length, 0);
  assert.equal(useAppStore.getState().automations[0].nextRunAt, task.nextRunAt);
  assert.equal(useAppStore.getState().startAutomationRun(task.id, "schedule"), null);
  useAppStore.getState().updateAutomationRun(request.runId, { status: "running" });
  useAppStore.getState().updateAutomationRun(request.runId, { status: "success", result: "索引完成" });
  await flushAutomationWrites(scope);
  const saved = JSON.parse((await readCacheFile(scope, "automations/runs.json"))!);
  assert.equal(saved[0].status, "success");
  assert.equal(saved[0].result, "索引完成");

  persistAutomations(scope, [task], [{ ...saved[0], status: "running" }]);
  await flushAutomationWrites(scope);
  useAppStore.setState({ automationRuns: [] });
  await useAppStore.getState().loadAutomations();
  assert.equal(useAppStore.getState().automationRuns[0].status, "aborted");
  assert.ok(useAppStore.getState().startAutomationRun(task.id, "manual"));
  await flushAutomationWrites(scope);
});
