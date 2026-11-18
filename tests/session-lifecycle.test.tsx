import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WriteQueue, type WriteStatus } from "../src/cache/writeQueue";
import { useAppStore } from "../src/app/state";
import type { AutomationRun, Message, Thread } from "../src/app/types";
import { saveStoredConversation } from "../src/cache/sessionRepository";
import { sessionMessages, sessionSnapshot } from "../src/cache/conversationSnapshot";
import { fromStoredConversation, toStoredConversation } from "../src/cache/sessionDb";
import { prepareRegeneration, selectAnswerVersion } from "../src/conversation/answerVersions";
import { messageWindowStart, messageWindowRange } from "../src/conversation/messageWindow";
import { draftKey, setDraftText, useConversationDrafts, attachmentDraftFor } from "../src/model/conversationDrafts";
import { enqueueRequest, stopAllThreadRuns, type AgentRunOutcome } from "../src/hooks/useAgentRun";
import { conversationSource } from "../src/knowledge/content";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationStreamBase } from "../src/conversation/ConversationStream";
import { useAgentRun } from "../src/hooks/useAgentRun";
import { AutomationsPage } from "../src/pages/AutomationsPage";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
function thread(id: string, parentThreadId: string | null = null): Thread {
  return { id, title: id, projectId: "", createdAt: 1, updatedAtLabel: "刚刚", contextEntries: [], sources: [], executionContext: "local", workspacePath: null, worktreePath: null, branch: null, permissionMode: "auto-readonly", reviewComments: [], agentId: null, parentThreadId, contextSummary: "", contextCoveredCount: 0 };
}
const messages: Message[] = [
  { id: "q", role: "user", items: [{ id: "qt", type: "text", text: "问题", streaming: false }] },
  { id: "a", role: "assistant", items: [{ id: "at", type: "text", text: "原回答", streaming: false }] },
];

test("保存与删除失败仍保留待写记录，重试成功后才确认", async () => {
  let fail = true;
  let status: WriteStatus = { pending: 0, saving: false, error: null };
  const writes: (string | null)[] = [];
  const queue = new WriteQueue<string>(async (_id, value) => { if (fail) throw new Error("disk full"); writes.push(value); }, (s) => { status = s; });
  queue.put("one", "正文");
  await assert.rejects(queue.flush(), /disk full/);
  assert.equal(status.pending, 1); assert.match(status.error!, /disk full/);
  queue.put("one", null); fail = false;
  await queue.retry();
  assert.deepEqual(writes, [null]); assert.equal(status.pending, 0); assert.equal(status.error, null);
});

test("保存途中出现新版本不会被旧版本的成功回执清除", async () => {
  let release!: () => void;
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: string[] = [];
  const queue = new WriteQueue<string>(async (_id, value) => { writes.push(value!); if (value === "old") { started(); await gate; } }, () => {});
  queue.put("one", "old"); const saving = queue.flush(); await beginning;
  queue.put("one", "new"); release(); await saving; await queue.flush();
  assert.deepEqual(writes, ["old", "new"]);
});

test("单条会话失败不阻止其他会话保存，失败项保留等待重试", async () => {
  let fail = true;
  const writes: string[] = [];
  let pending = 0;
  const queue = new WriteQueue<string>(async (id) => { if (id === "bad" && fail) throw new Error("invalid record"); writes.push(id); }, (s) => { pending = s.pending; });
  queue.put("bad", "bad"); queue.put("good", "good");
  await assert.rejects(queue.flush());
  assert.deepEqual(writes, ["good"]); assert.equal(pending, 1);
  fail = false; await queue.retry(); assert.equal(pending, 0);
});

test("连续流式更新不会无限延后保存截止时间", async () => {
  const writes: number[] = [];
  const queue = new WriteQueue<number>(async (_id, value) => { writes.push(value!); }, () => {}, 10);
  let tick = 0;
  const interval = setInterval(() => queue.put("one", ++tick), 2);
  try { await sleep(60); assert.ok(writes.length >= 2); }
  finally { clearInterval(interval); await queue.flush(); }
  assert.equal(writes.at(-1), tick);
});

test("异步补齐未加载正文后，已过期的快照不能覆盖新消息", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const beginning = new Promise<void>((resolve) => { started = resolve; });
  const writes: string[] = [];
  const queue = new WriteQueue<string>(async (_id, value, isCurrent) => {
    if (value === "old") { started(); await gate; }
    if (isCurrent()) writes.push(value!);
  }, () => {});
  queue.put("one", "old"); const saving = queue.flush(); await beginning;
  queue.put("one", "accepted-new-message"); release(); await saving; await queue.flush();
  assert.deepEqual(writes, ["accepted-new-message"]);
});

test("恢复失败可重试，成功前拒绝新建，不把损坏记录当作空库覆盖", async () => {
  const scope = "/test/restore-failure", key = `octopuses:browser-session-db:${scope}`;
  storage.set(key, "{corrupt");
  useAppStore.setState({ cachePath: scope, sessionsRestored: false, sessionsRestoring: false, sessionsRestoreError: null, threads: [], messages: {} });
  await useAppStore.getState().restoreSessions();
  assert.equal(useAppStore.getState().sessionsRestored, false);
  assert.match(useAppStore.getState().sessionsRestoreError!, /读取失败/);
  assert.equal(useAppStore.getState().createThread("blocked", "", true), "");
  assert.equal(storage.get(key), "{corrupt");
  storage.set(key, JSON.stringify({ root: scope, conversations: {}, legacyMigrated: true }));
  await useAppStore.getState().restoreSessions();
  assert.equal(useAppStore.getState().sessionsRestored, true);
  assert.equal(useAppStore.getState().sessionsRestoreError, null);
});

test("启动只恢复当前会话正文，其他会话按需读取，未加载正文的重命名与知识库快照不丢数据", async () => {
  const scope = "/test/lazy-history";
  const one = thread("one"), two = thread("two");
  await saveStoredConversation(scope, { ...toStoredConversation(one, messages), createdAt: 1 });
  await saveStoredConversation(scope, { ...toStoredConversation(two, messages.map((m) => ({ ...m, id: `${m.id}2` }))), createdAt: 2 });
  useAppStore.setState({ cachePath: scope, sessionsRestored: false, sessionsRestoring: false, sessionsRestoreError: null, threads: [], messages: {} });
  await useAppStore.getState().restoreSessions();
  assert.equal(useAppStore.getState().activeThreadId, "two");
  assert.deepEqual(Object.keys(useAppStore.getState().messages), ["two"]);
  const renamed = await sessionSnapshot(scope, { ...one, title: "改名" }, undefined);
  assert.equal(renamed.messages.length, 2);
  const source = await conversationSource(one, await sessionMessages(scope, "one", undefined));
  assert.match(source.body, /原回答/);
  await Promise.all([useAppStore.getState().ensureThreadLoaded("one"), useAppStore.getState().ensureThreadLoaded("one")]);
  assert.equal(useAppStore.getState().messages.one.length, 2);
});

test("文字与未完成附件读取按会话和缓存目录隔离，切回可恢复", async () => {
  const a = draftKey("/a", "one"), b = draftKey("/a", "two"), other = draftKey("/b", "one");
  setDraftText(a, "A草稿"); setDraftText(b, "B草稿");
  assert.equal(useConversationDrafts.getState().text[a], "A草稿");
  assert.equal(useConversationDrafts.getState().text[other], undefined);
  let finish!: (value: { files: File[]; failed: string[] }) => void;
  const batch = new Promise<{ files: File[]; failed: string[] }>((resolve) => { finish = resolve; });
  attachmentDraftFor(a).add(batch, async (file) => ({ ok: true, attachment: { id: "file", kind: "file", name: file.name, mime: "text/plain", size: 1, dataUrl: null, text: "附件" } }));
  assert.equal(attachmentDraftFor(b).getSnapshot().pending, 0);
  finish({ files: [new File(["x"], "a.txt")], failed: [] });
  await attachmentDraftFor(a).ready();
  assert.equal(attachmentDraftFor(a).getSnapshot().attachments[0].name, "a.txt");
  assert.equal(attachmentDraftFor(b).getSnapshot().attachments.length, 0);
  assert.match(storage.get("octopuses:conversation-text-drafts")!, /A草稿/);
});

test("删除运行会话立即中断活动请求并取消排队请求，不再启动下一轮", async () => {
  useAppStore.setState({ cachePath: "/test/delete-running", sessionsRestored: true, sessionsRestoreError: null, threads: [thread("delete")], messages: { delete: [] } });
  let executions = 0;
  const executor = async (_id: string, _prompt: string, _attachments: unknown[], _regenerate: string | undefined, signal: AbortSignal) => {
    executions++;
    await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { outcome: "aborted" as const, reason: "userInterrupted" as const, message: "" };
  };
  const submit = (id: string) => new Promise<AgentRunOutcome>((resolve) => enqueueRequest({ id, threadId: "delete", prompt: id, attachments: [], source: "user", automationRunId: null, resolve }, "queue", executor));
  const active = submit("first"), queued = submit("second");
  useAppStore.getState().deleteThread("delete");
  assert.deepEqual(await Promise.all([active, queued]), ["aborted", "aborted"]);
  assert.equal(executions, 1);
  assert.equal(useAppStore.getState().messages.delete, undefined);
});

test("删除父会话同时停止子任务，清空其排队请求", async () => {
  useAppStore.setState({ cachePath: "/test/delete-parent", sessionsRestored: true, sessionsRestoreError: null, threads: [thread("parent"), thread("child", "parent")], messages: { parent: [], child: [] } });
  const active = new Promise<AgentRunOutcome>((resolve) => enqueueRequest({ id: "child-request", threadId: "child", prompt: "work", attachments: [], source: "user", automationRunId: null, resolve }, "run", async (_a, _b, _c, _d, signal) => {
    await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
    return { outcome: "aborted", reason: "userInterrupted", message: "" };
  }));
  useAppStore.getState().deleteThread("parent");
  assert.equal(await active, "aborted");
  await stopAllThreadRuns();
});

test("重新生成原子保留旧版本，失败自动恢复；版本落库往返后仍可切换", async () => {
  const t = thread("versions");
  useAppStore.setState({ cachePath: "/test/versions", sessionsRestored: true, sessionsRestoreError: null, threads: [t], messages: { versions: messages } });
  const plan = prepareRegeneration(messages, "q"); assert.equal(plan.prefix.length, 0);
  const result = await new Promise<AgentRunOutcome>((resolve) => enqueueRequest({ id: "regenerate", threadId: t.id, prompt: "问题", attachments: [], regenerateFrom: "q", source: "user", automationRunId: null, resolve }, "run", async () => {
    const id = useAppStore.getState().startAssistantReply(t.id, "问题", [], "q");
    useAppStore.setState((s) => ({ messages: { ...s.messages, [t.id]: s.messages[t.id].map((m) => m.id === id ? { ...m, items: [{ id: "new-text", type: "text", text: "失败的新回答", streaming: false }] } : m) } }));
    return { outcome: "failed", reason: "error", message: "failed" };
  }));
  assert.equal(result, "failed");
  const selected = useAppStore.getState().messages[t.id];
  assert.equal(selected[1].id, "a");
  const restored = fromStoredConversation(toStoredConversation(t, selected)).messages;
  assert.equal(restored[0].answerVersions?.length, 1);
  const alternative = restored[0].answerVersions![0];
  assert.match(JSON.stringify(selectAnswerVersion(restored, restored[0].id, alternative.id)[1]), /失败的新回答/);
  assert.equal((await conversationSource(t, restored)).body.includes("失败的新回答"), false);
});

test("千条消息默认仅展示最新100条，加载历史及搜索定位不会截断源数据", () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `m${i}`);
  assert.equal(messageWindowStart(ids, 100), 900);
  assert.equal(messageWindowStart(ids, 200), 800);
  const target = messageWindowRange(ids, 100, "m12");
  assert.ok(target.start <= 12 && target.end > 12);
  assert.ok(target.end - target.start <= 100);
  assert.equal(messageWindowRange(ids, 100, "m500").end, 550);
  assert.equal(ids.length, 1000);
});

test("消息流实际渲染千条历史时只挂载最新100条", () => {
  const id = "render-history", t = thread(id);
  const history: Message[] = Array.from({ length: 1000 }, (_, i) => ({ id: `render-${i}`, role: i % 2 ? "assistant" : "user", items: [{ id: `text-${i}`, type: "text", text: `history-${i}`, streaming: false }] }));
  useAppStore.setState({ threads: [t], activeThreadId: id, messages: { [id]: history }, threadRunStates: {} });
  // React's server snapshot reads the store's initial object, rather than the client snapshot.
  const initial = useAppStore.getInitialState();
  const original = { ...initial };
  Object.assign(initial, useAppStore.getState());
  try {
    const html = renderToStaticMarkup(createElement(ConversationStreamBase, { onSubmit: () => {}, onFollowUp: () => {}, onRegenerate: () => {} }));
    assert.equal((html.match(/data-message-id=/g) ?? []).length, 100);
    assert.match(html, /还有 900 条/);
    assert.equal(html.includes('data-message-id="render-0"'), false);
    assert.equal(html.includes('data-message-id="render-999"'), true);
  } finally { Object.assign(initial, original); }
});

test("自动化运行记录只为存在的会话显示打开入口，并保留本地执行结果", () => {
  const state = useAppStore.getState();
  const initial = useAppStore.getInitialState();
  const previousInitial = { ...initial };
  const run: AutomationRun = {
    id: "linked", automationId: "task", name: "有会话的运行", trigger: "schedule",
    startedAt: 1000, finishedAt: 2000, status: "success", error: null, threadId: "available", suggestions: [],
  };
  try {
    useAppStore.setState({
      threads: [thread("available")], sessionsRestored: true, sessionsRestoreError: null, automations: [],
      automationRuns: [
        run,
        { ...run, id: "stale", name: "历史运行", threadId: "deleted", result: "历史结果保留" },
        { ...run, id: "local", name: "本地向量化", threadId: "", result: "索引进度 5/5 个分块" },
      ],
    });
    Object.assign(initial, useAppStore.getState());
    const html = renderToStaticMarkup(createElement(AutomationsPage));
    assert.equal((html.match(/打开会话/g) ?? []).length, 1);
    assert.match(html, /关联会话已不存在/);
    assert.match(html, /历史结果保留/);
    assert.match(html, /索引进度 5\/5 个分块/);
  } finally {
    Object.assign(initial, previousInitial);
    useAppStore.setState(state);
  }
});

test("退出时等待任务停止，并将未执行的排队内容恢复到文字草稿", async () => {
  const scope = "/test/exit", id = "exit";
  useAppStore.setState({ cachePath: scope, sessionsRestored: true, sessionsRestoreError: null, threads: [thread(id)], messages: { [id]: [] } });
  let cleaned = false;
  const executor = async (_a: string, _b: string, _c: unknown[], _d: string | undefined, signal: AbortSignal) => {
    await new Promise<void>((done) => signal.addEventListener("abort", () => { void sleep(5).then(() => { cleaned = true; done(); }); }, { once: true }));
    return { outcome: "aborted" as const, reason: "userInterrupted" as const, message: "" };
  };
  const submit = (requestId: string) => new Promise<AgentRunOutcome>((resolve) => enqueueRequest({ id: requestId, threadId: id, prompt: requestId, attachments: [], source: "user", automationRunId: null, resolve }, "queue", executor));
  const active = submit("active"), queued = submit("尚未执行的指令");
  await stopAllThreadRuns();
  assert.ok(cleaned);
  assert.deepEqual(await Promise.all([active, queued]), ["aborted", "aborted"]);
  assert.match(useConversationDrafts.getState().text[draftKey(scope, id)], /尚未执行的指令/);
});

test("真实运行入口在用户消息保存失败时不调用模型", async () => {
  const id = "save-gate";
  useAppStore.setState({ cachePath: "/test/save-gate", sessionsRestored: true, sessionsRestoreError: null, threads: [thread(id)], messages: { [id]: [] }, modelConfig: { url: "https://model.example/v1", key: "test", modelId: "test", supportsImages: false, visionModelId: "" } });
  let run!: ReturnType<typeof useAgentRun>["run"];
  function Probe() { run = useAgentRun().run; return null; }
  renderToStaticMarkup(createElement(Probe));
  const save = localStorage.setItem;
  const fetch = globalThis.fetch;
  let calls = 0;
  localStorage.setItem = () => { throw new Error("disk full"); };
  globalThis.fetch = (async () => { calls++; throw new Error("不应请求网络"); }) as typeof globalThis.fetch;
  try {
    assert.equal(await run(id, "先保存再发送", []), "failed");
    assert.equal(calls, 0);
    assert.match(JSON.stringify(useAppStore.getState().messages[id]), /消息尚未保存/);
  } finally { localStorage.setItem = save; globalThis.fetch = fetch; }
});
