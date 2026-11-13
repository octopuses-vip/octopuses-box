import assert from "node:assert/strict";
import test from "node:test";
import { readKnowledgeDocument } from "../src/knowledge/importDocument";
import { sourceChunks, splitKnowledgeText } from "../src/knowledge/content";
import { knowledgeRequest } from "../src/knowledge/api";
import { loadExportSources } from "../src/knowledge/exportSources";
import { MAX_CONTEXT_FILE_BYTES } from "../src/context/fileText";
import type { KnowledgeSource } from "../src/knowledge/types";

test("超过百万字符的 Markdown 完整导入、自动切块，可选为训练来源并导出原文", async () => {
  const body = "# 数据库说明\n字段🙂 varchar(255)\n".repeat(50_000) + "文档结束标记";
  assert.ok(body.length > 1_000_000);
  const source = await readKnowledgeDocument("DB_DOC.MD", new TextEncoder().encode(body));
  assert.equal(source.body, body);
  const chunks = await sourceChunks(source);
  assert.ok(chunks.length > 3000);
  assert.ok(chunks.at(-1)?.text.endsWith("文档结束标记"));
  const scope = "large-markdown-import";
  await knowledgeRequest(scope, { op: "put", source, chunks });
  const loaded = await knowledgeRequest<KnowledgeSource>(scope, { op: "get", id: source.id });
  assert.equal(loaded.body, body);
  const choices = await loadExportSources(scope, "training", { sessionsRestored: true, sessionsRestoreError: null,
    threads: [], threadRunStates: {}, messages: {} });
  assert.deepEqual(choices.sources.map((s) => s.id), [source.id]);
  const exported = await knowledgeRequest<{ text: string }>(scope, { op: "export", format: "documents", path: "test.jsonl" });
  assert.equal(JSON.parse(exported.text).text, body);
  assert.equal((await readKnowledgeDocument("renamed.md", new TextEncoder().encode(body))).id, source.id);
});

test("切块保持原有 Unicode、重叠和边界行为，不改变已有片段哈希", () => {
  for (const count of [0, 1, 271, 272, 319, 320, 321, 592, 593, 2000]) {
    const text = "a中🙂 \n".repeat(500).slice(0, count);
    const points = Array.from(text);
    const expected: string[] = [];
    for (let start = 0; start < points.length; start += 272) {
      const piece = points.slice(start, start + 320).join("");
      if (piece.trim()) expected.push(piece);
      if (start + 320 >= points.length) break;
    }
    assert.deepEqual(splitKnowledgeText(text), expected);
  }
  assert.deepEqual(splitKnowledgeText(" ".repeat(1000)), []);
});

test("仍拒绝空白、二进制和超过文件字节上限的文档", async () => {
  await assert.rejects(readKnowledgeDocument("empty.md", new TextEncoder().encode(" \n ")), /没有可读取的文字/);
  await assert.rejects(readKnowledgeDocument("binary.md", new Uint8Array([0, 1, 2])), /二进制/);
  await assert.rejects(readKnowledgeDocument("large.md", new Uint8Array(MAX_CONTEXT_FILE_BYTES + 1)), /超过 10 MB/);
});
