import assert from "node:assert/strict";
import test from "node:test";
import { groupExportSources, selectedExportSources, toggleExportGroup } from "../src/knowledge/exportSelection";
import { applyReview, expandReviewedSource, reviewExportSource, REVIEW_BATCH_CHARS } from "../src/knowledge/exportReview";
import { knowledgeRequest } from "../src/knowledge/api";
import { restoreStoredSessions, deleteStoredConversation, saveStoredConversation } from "../src/cache/sessionRepository";
import { toStoredConversation } from "../src/cache/sessionDb";
import type { Thread } from "../src/app/types";
import type { KnowledgeSource } from "../src/knowledge/types";

const source: KnowledgeSource = { id: "conversation:one", threadId: "one", title: "样本", kind: "conversation", body: "原始正文", hash: "h", updatedAt: 1, messages: [
  { id: "1", role: "user", content: "我的邮箱 private@example.com" }, { id: "2", role: "assistant", content: "回答" },
  { id: "3", role: "user", content: "重复问题" }, { id: "4", role: "assistant", content: "重复回答" },
] };
const decision = { keep: true, reason: "去重和脱敏", keepMessageIds: ["1", "2"], redact: ["private@example.com"] };

test("项目勾选支持全选、部分选择、清空；空选择不得退回导出全部", () => {
  const all = toggleExportGroup(new Set(), ["a", "b", source.id], true);
  const partial = toggleExportGroup(all, ["a", "b"], false);
  assert.deepEqual([...partial], [source.id]);
  assert.equal(selectedExportSources([source], partial).length, 1);
  assert.throws(() => selectedExportSources([source], new Set()), /至少勾选/);
});

test("项目分组保留归档和子会话，无所属项目的历史归入独立会话", () => {
  const sources = [source, { ...source, id: "child", threadId: "child" }, { ...source, id: "orphan", threadId: "orphan" }, { ...source, id: "doc", kind: "document" as const, threadId: null }];
  const groups = groupExportSources(sources, [{ id: "one", projectId: "p1" }, { id: "child", projectId: "p1" }, { id: "orphan", projectId: "deleted-project" }], [{ id: "p1", name: "项目一" }]);
  assert.deepEqual(groups.get("p1")?.sources.map((s) => s.id), [source.id, "child"]);
  assert.equal(groups.get("standalone")?.sources[0].id, "orphan");
  assert.equal(groups.get("documents")?.sources[0].id, "doc");
});

test("评审只能抽取和脱敏，保持原始顺序，不修改原记录", () => {
  const original = structuredClone(source);
  const result = applyReview(source, JSON.stringify({ ...decision, keepMessageIds: ["2", "1"] }));
  assert.deepEqual(result.source?.messages.map((m) => m.id), ["1", "2"]);
  assert.equal(result.source?.messages[0].content, "我的邮箱 [已脱敏]");
  assert.deepEqual(source, original);
  assert.equal(applyReview(source, JSON.stringify({ ...decision, keep: false })).source, null);
});

test("拒绝畸形结果、未知或重复消息、虚构脱敏片段和空会话", () => {
  for (const bad of ["不是JSON", JSON.stringify({ keep: true }), JSON.stringify({ ...decision, keepMessageIds: ["fake"] }), JSON.stringify({ ...decision, keepMessageIds: ["1", "1"] }), JSON.stringify({ ...decision, redact: ["虚构"] }), JSON.stringify({ ...decision, keepMessageIds: [] })]) {
    assert.throws(() => applyReview(source, bad));
  }
});

test("评审只选部分消息时移除整轮，保持有效问答和原始记录", () => {
  const original = structuredClone(source);
  for (const partial of ["3", "4"]) {
    const result = applyReview(source, JSON.stringify({ ...decision, keepMessageIds: ["1", "2", partial] }));
    assert.deepEqual(result.source?.messages.map((m) => m.id), ["1", "2"]);
    assert.match(result.reason, /1 轮问答.*整体移除/);
  }
  const rejected = applyReview(source, JSON.stringify({ ...decision, keepMessageIds: ["1", "4"] }));
  assert.equal(rejected.source, null);
  assert.match(rejected.reason, /2 轮问答.*整体移除/);
  assert.deepEqual(source, original);
});

test("连续同角色消息属于同轮，部分选中不得留下孤立消息", () => {
  const grouped: KnowledgeSource = { ...source, messages: [
    { id: "q1", role: "user", content: "问题" }, { id: "q2", role: "user", content: "补充" },
    { id: "a1", role: "assistant", content: "回答一" }, { id: "a2", role: "assistant", content: "回答二" },
    ...source.messages,
  ] };
  const result = applyReview(grouped, JSON.stringify({ ...decision, keepMessageIds: ["q1", "q2", "a1", "1", "2"] }));
  assert.deepEqual(result.source?.messages.map((m) => m.id), ["1", "2"]);
});

test("两批评审的首批拆散问答时继续评审，整轮剔除并报告原因", async () => {
  const originalFetch = globalThis.fetch;
  const long: KnowledgeSource = { ...source, messages: [
    { id: "q1", role: "user", content: "第一问" }, { id: "a1", role: "assistant", content: "A".repeat(13_000) },
    { id: "q2", role: "user", content: "第二问" }, { id: "a2", role: "assistant", content: "B".repeat(13_000) },
  ] };
  let requests = 0;
  globalThis.fetch = (async (_url, options) => {
    requests++;
    const input = JSON.parse(String(options?.body)).messages[1].content as string;
    assert.ok(input.length <= REVIEW_BATCH_CHARS);
    const batch = JSON.parse(input) as KnowledgeSource & { turns: string[][] };
    const expected = requests === 1 ? ["q1", "a1"] : ["q2", "a2"];
    assert.deepEqual(batch.turns, [expected]);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keep: true, reason: "有效", keepMessageIds: requests === 1 ? ["a1"] : expected, redact: [] }) } }] }));
  }) as typeof fetch;
  try {
    const result = await reviewExportSource(long, { url: "https://review.example/v1", key: "", model: "test" }, new AbortController().signal);
    assert.equal(requests, 2);
    assert.deepEqual(result.source?.messages.map((m) => m.id), ["q2", "a2"]);
    assert.match(result.reason, /第 1 批：.*1 轮问答.*整体移除/);
    assert.equal(long.messages.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});

test("评审调用使用所选连接，取消后不发请求或接收结果", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const controller = new AbortController();
  globalThis.fetch = (async (url, options) => {
    requests++;
    assert.equal(String(url), "https://review.example/v1/chat/completions");
    assert.equal(JSON.parse(String(options?.body)).model, "review-model");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const connection = { url: "https://review.example/v1", key: "key", model: "review-model" };
    assert.equal((await reviewExportSource(source, connection, controller.signal)).source?.messages.length, 2);
    assert.equal(requests, 1);
    controller.abort();
    await assert.rejects(reviewExportSource(source, connection, controller.signal));
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("基于清洗结果扩展独立问答，去重并拒绝越界内容格式", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_url, options) => {
    requests++;
    const body = JSON.parse(String(options?.body));
    assert.match(body.messages[0].content, /尽可能从可见事实生成有价值的独立问答/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [
      { question: "如何增加控制器的统一前缀？", answer: "在配置中设置统一前缀。" },
      { question: "如何增加控制器的统一前缀？", answer: "在配置中设置统一前缀。" },
      { question: "哪些场景适用？", answer: "适用于需要统一路由入口的场景。" },
    ] }) } }] }));
  }) as typeof fetch;
  try {
    const result = await expandReviewedSource(source, { url: "https://review.example/v1", key: "", model: "test" }, new AbortController().signal);
    assert.equal(requests, 1);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(result[0].messages[0].content, "如何增加控制器的统一前缀？");
    assert.equal(result[0].kind, "conversation");
    assert.notEqual(result[0].id, result[1].id);
  } finally { globalThis.fetch = originalFetch; }
});

test("扩展结果超过数量上限时失败，避免导出失控", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ items: Array.from({ length: 101 }, () => ({ question: "问", answer: "答" })) }) } }],
  }))) as typeof fetch;
  try { await assert.rejects(expandReviewedSource(source, { url: "https://review.example/v1", key: "", model: "test" }, new AbortController().signal), /数量过多/); }
  finally { globalThis.fetch = originalFetch; }
});

test("超过6万字符的单轮消息自动分批，覆盖全文、Unicode及边界脱敏并保留原始消息ID", async () => {
  const originalFetch = globalThis.fetch;
  const text = '中文🙂"\\\n'.repeat(14_000) + "结束标记";
  const long: KnowledgeSource = { ...source, messages: [{ id: "question", role: "user", content: "问题" }, { id: "answer", role: "assistant", content: text }] };
  const inputs: string[] = [];
  const progress: number[][] = [];
  let secret = "";
  let redacted = false;
  globalThis.fetch = (async (_url, options) => {
    const input = JSON.parse(String(options?.body)).messages[1].content as string;
    assert.ok(input.length <= REVIEW_BATCH_CHARS);
    const batch = JSON.parse(input) as KnowledgeSource;
    for (const m of batch.messages) {
      assert.equal(/[\uD800-\uDBFF]$/.test(m.content), false);
      assert.equal(/^[\uDC00-\uDFFF]/.test(m.content), false);
      if (m.id === "answer") inputs.push(m.content);
    }
    if (inputs.length === 1 && !secret) secret = text.slice(inputs[0].length - 10, inputs[0].length + 10);
    const redact = batch.messages.some((m) => secret && m.content.includes(secret)) ? [secret] : [];
    if (redact.length) redacted = true;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keep: true, reason: "有效片段", keepMessageIds: batch.messages.map((m) => m.id), redact }) } }] }));
  }) as typeof fetch;
  try {
    const result = await reviewExportSource(long, { url: "https://review.example/v1", key: "", model: "test" }, new AbortController().signal, (done, total) => progress.push([done, total]));
    assert.ok(inputs.length > 2);
    assert.ok(redacted);
    assert.ok(inputs.at(-1)?.endsWith("结束标记"));
    let offset = 0;
    for (const part of inputs) {
      const start = text.indexOf(part, Math.max(0, offset - 256));
      assert.ok(start >= 0 && start <= offset);
      offset = start + part.length;
    }
    assert.equal(offset, text.length);
    assert.equal(result.source?.messages[1].content, text.split(secret).join("[已脱敏]"));
    assert.deepEqual(result.source?.messages.map((m) => m.id), ["question", "answer"]);
    assert.deepEqual(progress.at(-1), [progress.at(-1)![1], progress.at(-1)![1]]);
    assert.equal(long.messages[1].content, text);
  } finally { globalThis.fetch = originalFetch; }
});

test("按完整问答轮次分批；单片段不通过时剔除整轮，保留其他轮次", async () => {
  const originalFetch = globalThis.fetch;
  const long: KnowledgeSource = { ...source, messages: [
    { id: "q1", role: "user", content: "第一问" }, { id: "a1", role: "assistant", content: "A".repeat(65_000) },
    { id: "q2", role: "user", content: "第二问" }, { id: "a2", role: "assistant", content: "有效回答" },
  ] };
  let reject = true;
  globalThis.fetch = (async (_url, options) => {
    const batch = JSON.parse(JSON.parse(String(options?.body)).messages[1].content) as KnowledgeSource;
    const keep = !(reject && batch.messages.some((m) => m.id === "a1"));
    if (!keep) reject = false;
    if (batch.messages.some((m) => m.id === "q2")) assert.deepEqual(batch.messages.map((m) => m.id), ["q2", "a2"]);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keep, reason: keep ? "有效" : "低质量", keepMessageIds: keep ? batch.messages.map((m) => m.id) : [], redact: [] }) } }] }));
  }) as typeof fetch;
  try {
    const result = await reviewExportSource(long, { url: "https://review.example/v1", key: "", model: "test" }, new AbortController().signal);
    assert.deepEqual(result.source?.messages.map((m) => m.id), ["q2", "a2"]);
    assert.match(result.reason, /整轮/);
  } finally { globalThis.fetch = originalFetch; }
});

test("长文档分批后不截断；中途失败或取消不返回部分清洗结果", async () => {
  const originalFetch = globalThis.fetch;
  const doc: KnowledgeSource = { ...source, kind: "document", messages: [], body: "知识文档".repeat(20_000) };
  const controller = new AbortController();
  let requests = 0;
  let mode = "success";
  globalThis.fetch = (async () => {
    requests++;
    if (mode === "failure" && requests === 2) return new Response("service failed", { status: 500 });
    if (mode === "cancel") controller.abort();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keep: true, reason: "有效文档", keepMessageIds: [], redact: [] }) } }] }));
  }) as typeof fetch;
  try {
    const connection = { url: "https://review.example/v1", key: "", model: "test" };
    assert.equal((await reviewExportSource(doc, connection, controller.signal)).source?.body, doc.body);
    assert.ok(requests > 1);
    mode = "failure"; requests = 0;
    await assert.rejects(reviewExportSource(doc, connection, controller.signal), /第 2\//);
    assert.equal(requests, 2);
    mode = "cancel"; requests = 0;
    await assert.rejects(reviewExportSource(doc, connection, controller.signal));
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("浏览器导出仅使用所选临时快照，清洗不写回知识库，空列表不能导出全部", async () => {
  const scope = "export-selection-test";
  await knowledgeRequest(scope, { op: "put", source, chunks: [] });
  const clean = applyReview(source, JSON.stringify(decision)).source!;
  const result = await knowledgeRequest<{ text: string; count: number }>(scope, { op: "export", path: "", format: "messages", sources: [clean] });
  assert.equal(result.count, 1);
  assert.equal(result.text.includes("private@example.com"), false);
  assert.equal(result.text.includes("重复回答"), false);
  assert.deepEqual(await knowledgeRequest(scope, { op: "get", id: source.id }), source);
  for (const op of ["export", "export_markdown"] as const) await assert.rejects(knowledgeRequest(scope, { op, path: "", format: "messages", sources: [] }), /没有可导出/);
});

test("统一会话入口只导入一次旧JSON，删除后不复活，缓存路径隔离", async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  const record = toStoredConversation({ id: "one", title: "迁移会话", projectId: "" } as Thread, []);
  let reads = 0;
  const legacy = async () => { reads++; return [record]; };
  const concurrent = await Promise.all([restoreStoredSessions("/cache/a", legacy), restoreStoredSessions("/cache/a", legacy)]);
  assert.equal(concurrent[0].length, 1);
  assert.equal(concurrent[1].length, 1);
  await deleteStoredConversation("/cache/a", "one");
  assert.equal((await restoreStoredSessions("/cache/a", legacy)).length, 0);
  assert.equal(reads, 1);
  await saveStoredConversation("/cache/b", record);
  assert.equal((await restoreStoredSessions("/cache/b", legacy)).length, 1);
  assert.equal((await restoreStoredSessions("/cache/a", legacy)).length, 0);
  assert.equal(reads, 1);
  Reflect.deleteProperty(globalThis, "localStorage");
});
