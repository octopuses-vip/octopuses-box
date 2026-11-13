import assert from "node:assert/strict";
import test from "node:test";
import { prepareTrainingSource } from "../src/knowledge/prepareTraining";
import { trainingRecord } from "../src/knowledge/content";
import { REVIEW_BATCH_CHARS } from "../src/knowledge/exportReview";
import type { KnowledgeSource } from "../src/knowledge/types";

const document: KnowledgeSource = { id: "document:test", kind: "document", threadId: null,
  title: "使用说明", body: "按开始按钮启动。", messages: [], hash: "original", updatedAt: 1 };
const questionConnection = { url: "https://question.example/v1", key: "", model: "question-model", retries: 0 };
const options = () => ({ questionConnection, expand: false, signal: new AbortController().signal, onProgress: () => {} });
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test("上传文档使用独立提问模型，生成结果支持三种训练格式且不修改原文", async () => {
  const originalFetch = globalThis.fetch;
  const original = structuredClone(document);
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://question.example/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "question-model");
    assert.equal(JSON.parse(body.messages[1].content).text, document.body);
    return response({ items: [{ question: "如何启动？", answer: "按开始按钮。" }] });
  }) as typeof fetch;
  try {
    const result = await prepareTrainingSource(document, options());
    assert.equal(result.kept, true);
    assert.equal(result.sources.length, 1);
    assert.deepEqual(trainingRecord(result.sources[0], "messages"), { messages: [
      { role: "user", content: "如何启动？" }, { role: "assistant", content: "按开始按钮。" },
    ] });
    assert.deepEqual(trainingRecord(result.sources[0], "alpaca"), { instruction: "如何启动？", input: "", output: "按开始按钮。" });
    assert.deepEqual(trainingRecord(result.sources[0], "sharegpt"), { conversations: [
      { from: "human", value: "如何启动？" }, { from: "gpt", value: "按开始按钮。" },
    ] });
    assert.deepEqual(document, original);
  } finally { globalThis.fetch = originalFetch; }
});

test("文档可先评审脱敏再用提问模型生成，会话无需模型即可保留", async () => {
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    if (body.model === "review-model") return response({ keep: true, reason: "脱敏", keepMessageIds: [], redact: ["开始"] });
    assert.equal(JSON.parse(body.messages[1].content).text, "按[已脱敏]按钮启动。");
    return response({ items: [{ question: "如何启动？", answer: "按按钮。" }] });
  }) as typeof fetch;
  try {
    const result = await prepareTrainingSource(document, { ...options(), expand: true,
      reviewConnection: { ...questionConnection, model: "review-model" } });
    assert.deepEqual(models, ["review-model", "question-model"]);
    assert.equal(result.sources.length, 1);
    const conversation = { ...document, kind: "conversation" as const, messages: [
      { id: "q", role: "user" as const, content: "问" }, { id: "a", role: "assistant" as const, content: "答" },
    ] };
    assert.deepEqual((await prepareTrainingSource(conversation, options())).sources, [conversation]);
    assert.equal(models.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("长文档分批覆盖全文并去重，取消不产生可导出结果", async () => {
  const originalFetch = globalThis.fetch;
  const parts: string[] = [];
  const progress: number[][] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(String(init?.body)).messages[1].content;
    assert.ok(input.length <= REVIEW_BATCH_CHARS);
    parts.push(JSON.parse(input).text);
    return response({ items: [{ question: "问", answer: "答" }] });
  }) as typeof fetch;
  try {
    const body = "文档🙂内容".repeat(12000) + "结束标记";
    const result = await prepareTrainingSource({ ...document, body }, { ...options(), onProgress: (m) => {
      const match = m.match(/(\d+)\/(\d+)$/); if (match) progress.push([Number(match[1]), Number(match[2])]);
    } });
    assert.ok(parts.length > 2);
    let offset = 0;
    for (const part of parts) {
      const start = body.indexOf(part, Math.max(0, offset - 256));
      assert.ok(start >= 0 && start <= offset);
      offset = start + part.length;
    }
    assert.equal(offset, body.length);
    assert.deepEqual(progress.at(-1), [parts.length, parts.length]);
    assert.equal(result.sources.length, 1);
    const controller = new AbortController();
    globalThis.fetch = (async () => { controller.abort(); return response({ items: [{ question: "问", answer: "答" }] }); }) as typeof fetch;
    await assert.rejects(prepareTrainingSource(document, { ...options(), signal: controller.signal }));
  } finally { globalThis.fetch = originalFetch; }
});

test("缺少模型、畸形结果和空结果不会把原文文档当作训练问答", async () => {
  await assert.rejects(prepareTrainingSource(document, { ...options(), questionConnection: undefined }), /提问模型/);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => response({ items: [{ question: "", answer: "答" }] })) as typeof fetch;
    await assert.rejects(prepareTrainingSource(document, options()), /空的问答/);
    globalThis.fetch = (async () => response({ items: [] })) as typeof fetch;
    assert.deepEqual(await prepareTrainingSource(document, options()), { sources: [], kept: false, reason: "生成 0 条文档问答" });
  } finally { globalThis.fetch = originalFetch; }
});
