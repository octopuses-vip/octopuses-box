import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeRequest } from "../src/knowledge/api";
import type { KnowledgeChunk, KnowledgeHit, KnowledgeSource } from "../src/knowledge/types";

test("搜索按会话/文档聚合，保留最佳片段跳转，重复片段不挤占其他来源", async () => {
  const scope = "search-distinct-sources";
  const vector = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2), ...Array(510).fill(0)];
  for (const [id, kind, count, similarity] of [
    ["chat", "conversation", 130, .9], ["other-chat", "conversation", 1, .7],
    ["doc", "document", 3, .6],
  ] as const) {
    const source: KnowledgeSource = { id, kind, threadId: kind === "conversation" ? id : null,
      title: "防火墙", body: "防火墙", messages: [], updatedAt: 1, hash: id };
    const chunks: KnowledgeChunk[] = Array.from({ length: count }, (_, ordinal) => ({
      id: `${id}:${ordinal}`, sourceId: id, messageId: kind === "conversation" ? `message:${ordinal}` : null,
      ordinal, text: `防火墙片段 ${ordinal}`, hash: `${id}:${ordinal}`,
    }));
    await knowledgeRequest(scope, { op: "put", source, chunks });
    for (const chunk of chunks) await knowledgeRequest(scope, { op: "embed", id: chunk.id, hash: chunk.hash,
      model: "v1", vector: vector(id === "chat" && chunk.ordinal === 129 ? 1 : similarity) });
  }
  const action = { op: "search" as const, query: "防火墙", kind: "", model: "v1", vector: vector(1) };
  const hits = await knowledgeRequest<KnowledgeHit[]>(scope, action);
  assert.deepEqual(hits.map((h) => h.sourceId), ["chat", "other-chat", "doc"]);
  assert.equal(hits[0].messageId, "message:129");
  assert.equal(hits[0].text, "防火墙片段 129");
  assert.equal((await knowledgeRequest<KnowledgeHit[]>(scope, { ...action, vector: null })).length, 3);
  assert.deepEqual((await knowledgeRequest<KnowledgeHit[]>(scope, { ...action, kind: "document" })).map((h) => h.sourceId), ["doc"]);
  assert.equal((await knowledgeRequest<KnowledgeHit[]>(scope, { ...action, kind: "conversation" })).length, 2);
  assert.deepEqual(await knowledgeRequest(scope, { ...action, query: "" }), []);
  assert.equal((await knowledgeRequest<{ chunks: number }>(scope, { op: "stats", model: "v1" })).chunks, 134);
});
