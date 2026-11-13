import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { migratePersistedState, selectPersistedState } from "../src/app/state/persistence";
import { useAppStore } from "../src/app/state";
import { ImportLimitSettings } from "../src/knowledge/ImportLimitSettings";
import { KnowledgeLibrary } from "../src/knowledge/KnowledgeLibrary";
import { normalizeKnowledgeFileMb } from "../src/knowledge/importLimits";
import { readKnowledgeDocument } from "../src/knowledge/importDocument";
import { readContextFile } from "../src/context/fileText";

test("上传上限保存与恢复保持一致，旧配置默认 10 MB，非法值不产生无限制上传", () => {
  const previous = useAppStore.getState().knowledgeFileLimitMb;
  try {
    assert.equal(migratePersistedState({}).knowledgeFileLimitMb, 10);
    for (const value of [undefined, null, "50", 0, -1, 1.5, 201, Infinity, NaN]) assert.equal(normalizeKnowledgeFileMb(value), 10);
    for (const value of [1, 25, 200]) assert.equal(normalizeKnowledgeFileMb(value), value);
    useAppStore.getState().setKnowledgeFileLimitMb(25);
    assert.equal(useAppStore.getState().knowledgeFileLimitMb, 25);
    const saved = JSON.parse(JSON.stringify(selectPersistedState(useAppStore.getState())));
    assert.equal(migratePersistedState(saved).knowledgeFileLimitMb, 25);
    // 服务端渲染使用创建 store 时的快照，验证初始页面的默认配置。
    const settings = renderToStaticMarkup(createElement(ImportLimitSettings));
    assert.match(settings, /value="10"/);
    assert.match(settings, /保存上传限制/);
    const library = renderToStaticMarkup(createElement(KnowledgeLibrary));
    assert.match(library, /每个文件不超过 10 MB/);
  } finally { useAppStore.getState().setKnowledgeFileLimitMb(previous); }
});

test("知识库可按配置导入超过 10 MB 的文件，默认会话附件限制不变", async () => {
  const bytes = new Uint8Array(11 * 1024 * 1024).fill(65);
  const source = await readKnowledgeDocument("large.md", bytes, 12);
  assert.equal(source.body.length, bytes.length);
  await assert.rejects(readKnowledgeDocument("large.md", bytes, 10), /超过 10 MB/);
  await assert.rejects(readContextFile("large.md", bytes), /超过 10 MB/);
  const exact = new Uint8Array(1024 * 1024).fill(66);
  assert.equal((await readKnowledgeDocument("boundary.md", exact, 1)).body.length, exact.length);
  await assert.rejects(readKnowledgeDocument("boundary.md", new Uint8Array(exact.length + 1), 1), /超过 1 MB/);
});
