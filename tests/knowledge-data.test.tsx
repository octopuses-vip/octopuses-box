import assert from "node:assert/strict";
import test from "node:test";
import type { Message, Thread } from "../src/app/types";
import type { KnowledgeHit, KnowledgeSource } from "../src/knowledge/types";
import { contentHash, conversationSource, sourceChunks, splitKnowledgeText, trainingRecord } from "../src/knowledge/content";
import { knowledgeRequest } from "../src/knowledge/api";
import { knowledgeMarkdown, knowledgeMarkdownFiles, knowledgeMarkdownName, knowledgeMarkdownZip } from "../src/knowledge/markdown";
import { strFromU8, unzipSync } from "fflate";

const source: KnowledgeSource = { id: "chat", kind: "conversation", title: "多轮历史", threadId: "chat", body: "",
  updatedAt: 1, hash: "hash", messages: [
    { id: "0", role: "assistant", content: "孤立开头" },
    { id: "1", role: "user", content: "第一问" }, { id: "2", role: "assistant", content: "第一答\n换行" },
    { id: "3", role: "user", content: "第二问" }, { id: "4", role: "assistant", content: "第二答" },
    { id: "5", role: "user", content: "未回答" },
  ] };

test("三种训练格式保留多轮上下文，跳过不完整对话且不伪造文档问答", () => {
  assert.deepEqual(trainingRecord(source, "messages"), { messages: [
    { role: "user", content: "第一问" }, { role: "assistant", content: "第一答\n换行" },
    { role: "user", content: "第二问" }, { role: "assistant", content: "第二答" },
  ] });
  assert.deepEqual(trainingRecord(source, "alpaca"), {
    instruction: "第二问", input: "用户：第一问\n\n助手：第一答\n换行", output: "第二答",
  });
  assert.deepEqual(trainingRecord(source, "sharegpt"), { conversations: [
    { from: "human", value: "第一问" }, { from: "gpt", value: "第一答\n换行" },
    { from: "human", value: "第二问" }, { from: "gpt", value: "第二答" },
  ] });
  assert.equal(trainingRecord({ ...source, kind: "document" }, "messages"), null);
  assert.equal(trainingRecord({ ...source, messages: [{ id: "1", role: "user", content: "未回答" }] }, "messages"), null);
});

test("知识库切块保留重叠与 Unicode，消息定位和哈希可用于增量更新", async () => {
  const text = "知识🙂库".repeat(300);
  const parts = splitKnowledgeText(text);
  assert.equal(Array.from(parts[0]).length, 320);
  assert.equal(Array.from(parts[0]).slice(-48).join(""), Array.from(parts[1]).slice(0, 48).join(""));
  assert.equal(parts.join("").includes("\ufffd"), false);
  const chunks = await sourceChunks(source);
  assert.equal(chunks[1].messageId, "1");
  assert.equal(chunks[1].hash, (await sourceChunks(source))[1].hash);
});

test("会话入库排除推理和工具日志，保留文字附件，不收录流式片段", async () => {
  const thread = { id: "t", title: "标题" } as Thread;
  const messages: Message[] = [
    { id: "u", role: "user", items: [{ id: "t", type: "text", text: "问题", streaming: false }],
      attachments: [{ id: "f", name: "资料.txt", mime: "text/plain", size: 10, kind: "file", dataUrl: null, text: "附件原文" }] },
    { id: "a", role: "assistant", items: [{ id: "r", type: "reasoning", text: "隐藏思考", done: true },
      { id: "t", type: "text", text: "最终回复", streaming: false }, { id: "s", type: "text", text: "未完成片段", streaming: true }] },
  ];
  const value = await conversationSource(thread, messages);
  assert.match(value.body, /附件原文/); assert.match(value.body, /最终回复/);
  assert.doesNotMatch(value.body, /隐藏思考|未完成片段/);
  assert.equal(value.hash, (await conversationSource(thread, messages)).hash);
});

test("知识库上传去重、搜索、缓存隔离、删除与三种 JSONL 导出", async () => {
  const scope = "test-knowledge-api";
  const body = "中文知识库能查询文件。特殊字符 A_B% 正常检索。";
  const hash = await contentHash(body);
  const doc: KnowledgeSource = { id: `document:${hash}`, kind: "document", title: "资料.txt", threadId: null, body, messages: [], updatedAt: 1, hash };
  for (let i = 0; i < 2; i++) await knowledgeRequest(scope, { op: "put", source: doc, chunks: await sourceChunks(doc) });
  assert.equal((await knowledgeRequest<unknown[]>(scope, { op: "list" })).length, 1);
  const search = { op: "search" as const, query: "中文", kind: "", model: "v1", vector: null };
  assert.equal((await knowledgeRequest<KnowledgeHit[]>(scope, search))[0].title, "资料.txt");
  assert.deepEqual(await knowledgeRequest("another-cache", search), []);
  await knowledgeRequest(scope, { op: "put", source, chunks: await sourceChunks(source) });
  for (const format of ["messages", "alpaca", "sharegpt", "documents"] as const) {
    const result = await knowledgeRequest<{ text: string; count: number }>(scope, { op: "export", path: "test.jsonl", format });
    assert.equal(result.count, 1);
    const lines = result.text.trim().split("\n"); assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed[format === "documents" ? "text" : format === "alpaca" ? "instruction" : format === "sharegpt" ? "conversations" : "messages"]);
  }
  await knowledgeRequest(scope, { op: "prune", ids: [] });
  assert.equal((await knowledgeRequest<unknown[]>(scope, { op: "list" })).length, 1);
  await knowledgeRequest(scope, { op: "remove", id: doc.id });
  assert.deepEqual(await knowledgeRequest(scope, search), []);
});

test("过期向量不覆盖编辑后的片段，向量搜索只返回语义结果", async () => {
  const scope = "test-vector";
  const doc = { ...source, id: "doc", kind: "document" as const, body: "中文原文", messages: [], hash: "first" };
  const chunks = await sourceChunks(doc);
  await knowledgeRequest(scope, { op: "put", source: doc, chunks });
  const vector = Array.from({ length: 512 }, (_, i) => i ? 0 : 1);
  await knowledgeRequest(scope, { op: "embed", id: chunks[0].id, hash: chunks[0].hash, model: "v1", vector });
  const hits = await knowledgeRequest<KnowledgeHit[]>(scope, { op: "search", query: "中文", kind: "", model: "v1", vector });
  assert.equal(hits[0].match, "semantic");
  const changed = { ...doc, body: "新的资料", hash: "second" };
  await knowledgeRequest(scope, { op: "put", source: changed, chunks: await sourceChunks(changed) });
  assert.equal(await knowledgeRequest(scope, { op: "embed", id: chunks[0].id, hash: chunks[0].hash, model: "v1", vector }), false);
  assert.equal((await knowledgeRequest<unknown[]>(scope, { op: "pending", model: "v1" })).length, 1);
});

test("知识文档保留完整消息顺序、代码与未回答问题，不套用微调配对过滤", () => {
  const longText = "完整内容🙂".repeat(2000);
  const conversation = { ...source, title: "会话\n#标题", messages: [...source.messages,
    { id: "code", role: "assistant" as const, content: `\`\`\`ts\nconst value = 1;\n\`\`\`\n\n${longText}` }] };
  const md = knowledgeMarkdown(conversation);
  assert.match(md, /^# 会话 \\#标题/);
  assert.match(md, /## 1\. 助手\n\n孤立开头/);
  assert.match(md, /## 6\. 用户\n\n未回答/);
  assert.ok(md.includes("```ts\nconst value = 1;\n```"));
  assert.ok(md.includes(longText));
  assert.ok(md.indexOf("第一问") < md.indexOf("第一答"));
});

test("每个会话一个 Markdown，非法标题与同名不冲突，ZIP 解压后内容一致", async () => {
  const conversations = [
    { ...source, id: "b", title: "../CON:同名?/\\", updatedAt: 2 },
    { ...source, id: "a", title: "../CON:同名?/\\", updatedAt: 1 },
    { ...source, id: "empty", title: "...", messages: [], updatedAt: 3 },
    { ...source, id: "doc", kind: "document" as const },
  ];
  const files = knowledgeMarkdownFiles(conversations);
  assert.equal(files.length, 3);
  assert.equal(new Set(files.map((file) => file.name)).size, 3);
  files.forEach((file) => { assert.ok(file.name.endsWith(".md")); assert.doesNotMatch(file.name, /[<>:"/\\|?*\u0000-\u001f]/); });
  assert.match(files[2].content, /此会话暂无可导出的正文/);
  assert.ok(new TextEncoder().encode(knowledgeMarkdownName("🙂".repeat(100), 0)).length < 255);
  const unzipped = unzipSync(await knowledgeMarkdownZip(files));
  assert.deepEqual(Object.keys(unzipped).sort(), files.map((file) => file.name).sort());
  for (const file of files) assert.equal(strFromU8(unzipped[file.name]), file.content);
});

test("批量知识文档导出只包含会话，空库明确报错", async () => {
  const scope = "test-markdown-export";
  await assert.rejects(knowledgeRequest(scope, { op: "export_markdown", path: "" }), /没有可导出的会话/);
  await knowledgeRequest(scope, { op: "put", source, chunks: await sourceChunks(source) });
  const doc = { ...source, id: "doc", kind: "document" as const, title: "文档", body: "文档正文", messages: [] };
  await knowledgeRequest(scope, { op: "put", source: doc, chunks: await sourceChunks(doc) });
  const result = await knowledgeRequest<{ count: number; files: { name: string; content: string }[] }>(scope, { op: "export_markdown", path: "" });
  assert.equal(result.count, 1);
  assert.match(result.files[0].content, /未回答/);
  assert.doesNotMatch(result.files[0].content, /文档正文/);
});
