import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { KnowledgeSettings } from "../src/knowledge/KnowledgeSettings";
import { KNOWLEDGE_MODEL_BYTES, useKnowledgeModel } from "../src/knowledge/model";

test("浏览器设置展示可选模型，不自动下载或伪造已就绪状态", async () => {
  await useKnowledgeModel.getState().refresh();
  assert.equal(useKnowledgeModel.getState().status, null);
  const html = renderToStaticMarkup(createElement(KnowledgeSettings));
  assert.match(html, /知识库/);
  assert.match(html, /24.6 MB/);
  assert.match(html, /浏览器预览不会下载文件/);
  assert.match(html, /disabled=""/);
  assert.equal(KNOWLEDGE_MODEL_BYTES, 24_560_715);
  await useKnowledgeModel.getState().download();
  assert.match(useKnowledgeModel.getState().error ?? "", /请在桌面应用/);
  assert.equal(useKnowledgeModel.getState().busy, null);
  assert.equal(useKnowledgeModel.getState().status, null);
});
