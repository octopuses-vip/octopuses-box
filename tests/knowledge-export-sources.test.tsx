import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Thread } from "../src/app/types";
import { knowledgeRequest } from "../src/knowledge/api";
import { ExportDialog } from "../src/knowledge/ExportDialog";
import { groupExportSources } from "../src/knowledge/exportSelection";
import { loadExportSources } from "../src/knowledge/exportSources";
import type { KnowledgeSource } from "../src/knowledge/types";

const snapshot = { sessionsRestored: true, sessionsRestoreError: null, threads: [], threadRunStates: {}, messages: {} };
const document: KnowledgeSource = { id: "document:test", kind: "document", threadId: null,
  title: "测试文档.txt", body: "文件正文", messages: [], hash: "doc", updatedAt: 1 };

test("训练导出首次打开就显示文档入口和提问模型，不依赖加载结果", () => {
  const html = renderToStaticMarkup(createElement(ExportDialog, { scope: "export-visible", onClose() {} }));
  assert.match(html, /上传的文档/);
  assert.match(html, /正在读取上传的文档/);
  assert.match(html, /文档提问模型/);
  assert.match(html, /勾选上方/);
  const groups = groupExportSources([], [], [], true);
  assert.equal(groups.get("documents")?.sources.length, 0);
  const conversation = { ...document, id: "chat", kind: "conversation" as const };
  assert.equal([...groupExportSources([conversation, document], [], [], true).keys()][0], "documents");
});

test("会话未恢复或单条会话损坏时，训练导出仍加载已上传文档及有效会话", async () => {
  const scope = "export-documents-independent";
  await knowledgeRequest(scope, { op: "put", source: document, chunks: [] });
  const unrestored = await loadExportSources(scope, "training", { ...snapshot, sessionsRestored: false });
  assert.deepEqual(unrestored.sources, [document]);
  assert.match(unrestored.warnings.join(""), /会话尚未成功读回/);
  const threads = [{ id: "missing", title: "损坏会话" }, { id: "good", title: "正常会话" }, { id: "running", title: "运行中" }] as Thread[];
  const result = await loadExportSources(scope, "training", { ...snapshot, threads,
    messages: { good: [{ id: "q", role: "user", items: [{ id: "text", type: "text", text: "问题", streaming: false }] }] },
    threadRunStates: { running: { status: "running" } } });
  assert.deepEqual(result.sources.map((s) => s.id), [document.id, "conversation:good"]);
  assert.match(result.warnings.join(""), /损坏会话.*读取失败/);
  assert.match(result.warnings.join(""), /排除 1 条/);
  const documents = await loadExportSources(scope, "documents", { ...snapshot, sessionsRestored: false });
  assert.deepEqual(documents.sources, [document]);
  assert.deepEqual(documents.warnings, []);
  const markdown = await loadExportSources(scope, "markdown", snapshot);
  assert.deepEqual(markdown.sources, []);
});
