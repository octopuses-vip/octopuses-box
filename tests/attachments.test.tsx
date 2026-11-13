import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AttachmentDraft, type AttachmentBatch } from "../src/model/attachmentDraft";
import { attachmentMime, createAttachment, isTextFile, toUserContent } from "../src/model/attachments";
import { UserMessage } from "../src/conversation/blocks/UserMessage";
import type { MessageAttachment } from "../src/app/types";
import { pdfFile } from "./fixtures/pdf";

// Node 没有 FileReader；仅补齐异步文件读取接口，生产端仍使用 WebView 原生实现。
globalThis.FileReader = class {
  result: string | null = null;
  onload?: () => void;
  onerror?: () => void;
  readAsText(file: Blob) {
    file.text().then((text) => { this.result = text; this.onload?.(); }, () => this.onerror?.());
  }
  readAsDataURL(file: Blob) {
    file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    }, () => this.onerror?.());
  }
} as unknown as typeof FileReader;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const attachment = (name: string): MessageAttachment => ({
  id: name, name, mime: "text/plain", size: 5, kind: "file", text: "hello", dataUrl: null,
});

test("发送等待原生拖放还原与附件读取，最终快照包含文件", async () => {
  const draft = new AttachmentDraft();
  const nativeRead = deferred<AttachmentBatch>();
  draft.add(nativeRead.promise, createAttachment);
  assert.equal(draft.getSnapshot().pending, 1);
  let ready = false;
  const sending = draft.ready().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  nativeRead.resolve({ files: [new File(["hello"], "notes.txt")], failed: [] });
  await sending;
  assert.equal(draft.getSnapshot().attachments[0].name, "notes.txt");
  assert.equal(draft.getSnapshot().attachments[0].text, "hello");
  assert.equal(draft.getSnapshot().pending, 0);
});

test("等待或排队确认期间新增的附件也进入发送快照", async () => {
  const draft = new AttachmentDraft();
  const first = deferred<AttachmentBatch>();
  const second = deferred<AttachmentBatch>();
  draft.add(first.promise, createAttachment);
  const ready = draft.ready();
  draft.add(second.promise, createAttachment);
  first.resolve({ files: [new File(["a"], "a.txt")], failed: [] });
  second.resolve({ files: [new File(["b"], "b.txt")], failed: [] });
  await ready;
  assert.deepEqual(draft.getSnapshot().attachments.map((item) => item.name).sort(), ["a.txt", "b.txt"]);
  const outgoing = draft.getSnapshot().attachments;
  draft.sent(outgoing);
  assert.equal(outgoing.length, 2, "清空草稿不能修改已发送消息的附件数组");
  assert.equal(draft.getSnapshot().attachments.length, 0);
});

test("单个文件读取失败仍保留其余文件，移除附件不会误发", async () => {
  const draft = new AttachmentDraft();
  draft.add(Promise.resolve({ files: [new File([], "broken.txt"), new File([], "keep.txt")], failed: ["folder"] }), async (file) => {
    if (file.name === "broken.txt") throw new Error("无法读取");
    return { ok: true, attachment: attachment(file.name) };
  });
  await draft.ready();
  assert.match(draft.getSnapshot().notice!, /broken.txt/);
  assert.match(draft.getSnapshot().notice!, /folder/);
  assert.equal(draft.getSnapshot().attachments.length, 1);
  draft.remove("keep.txt");
  assert.equal(draft.getSnapshot().attachments.length, 0);
});

test("浏览器未提供 MIME 的图片与常用文本文件能正确识别", async () => {
  const image = new File(["image"], "photo.PNG");
  assert.equal(attachmentMime(image), "image/png");
  const result = await createAttachment(image);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.attachment.dataUrl!, /^data:image\/png;base64,/);
  for (const name of ["main.cpp", "main.cs", ".gitignore", ".env.local", "Dockerfile", "Makefile"]) {
    assert.equal(isTextFile(new File(["text"], name)), true, name);
  }
  assert.equal(isTextFile(new File(["binary"], "archive.zip")), false);
});

test("发送内容带有附件文字，消息气泡显示文件名与大小", () => {
  const files = [attachment("说明.txt"), { ...attachment("文档.pdf"), mime: "application/pdf", text: "PDF CONTENT" }];
  const content = toUserContent("请阅读", files);
  assert.deepEqual(content, [{ type: "text", text: '请阅读\n\n<file name="说明.txt">\nhello\n</file>\n\n<file name="文档.pdf">\nPDF CONTENT\n</file>' }]);
  const html = renderToStaticMarkup(createElement(UserMessage, { text: "请阅读", attachments: files }));
  assert.match(html, /说明.txt/);
  assert.match(html, /文档.pdf/);
  assert.match(html, /5 B/);
});

test("PDF 通过真实解析器提取文字，并作为文本片段进入请求", async () => {
  const result = await createAttachment(pdfFile("ATTACHMENT_SENTINEL"));
  assert.equal(result.ok, true, !result.ok ? result.reason : "");
  if (!result.ok) return;
  assert.equal(result.attachment.mime, "application/pdf");
  assert.match(result.attachment.text!, /ATTACHMENT_SENTINEL/);
  assert.match(JSON.stringify(toUserContent("", [result.attachment])), /ATTACHMENT_SENTINEL/);
});

test("空白 PDF 与损坏 PDF 明确拒绝，不生成只有文件名的假附件", async () => {
  const blank = await createAttachment(pdfFile(""));
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.reason, /OCR/);
  const broken = await createAttachment(new File(["broken"], "broken.pdf"));
  assert.equal(broken.ok, false);
});

test("消息入库和重新加载后仍保留附件原文与元数据", async () => {
  const { useAppStore } = await import("../src/app/state");
  const { toStoredConversation, fromStoredConversation } = await import("../src/cache/sessionDb");
  useAppStore.setState({ sessionsRestored: true, sessionsRestoreError: null });
  const store = useAppStore.getState();
  store.newChat();
  const id = useAppStore.getState().activeThreadId;
  const files = [attachment("history.txt")];
  store.startAssistantReply(id, "检查附件", files);
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.id === id)!;
  const restored = fromStoredConversation(toStoredConversation(thread, state.messages[id]));
  assert.deepEqual(restored.messages[0].attachments, files);
  assert.match(JSON.stringify(toUserContent("", restored.messages[0].attachments!)), /hello/);
});

test("原生拖放读取期间切换接收方，不会把旧附件交给新会话", async () => {
  const { routeDroppedFiles, subscribeDropSink } = await import("../src/app/fileDrop");
  let oldBatch: Promise<AttachmentBatch> | undefined;
  let newReceived = false;
  const off = subscribeDropSink((batch) => { oldBatch = batch; });
  const routing = routeDroppedFiles([{ name: "missing.txt", path: "/not-an-existing-file.txt", file: null }]);
  off();
  const offNew = subscribeDropSink(() => { newReceived = true; });
  try {
    await routing;
    assert.ok(oldBatch, "必须在原生读取完成之前绑定接收方");
    assert.equal(newReceived, false);
  } finally {
    offNew();
  }
});
