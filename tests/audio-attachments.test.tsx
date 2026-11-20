import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { restoreFiles, routeDroppedFiles, subscribeDropSink } from "../src/app/fileDrop";
import { AttachmentDraft } from "../src/model/attachmentDraft";
import { createAttachment, toUserContent } from "../src/model/attachments";
import { UserMessage } from "../src/conversation/blocks/UserMessage";
import type { NativeAudioFile } from "../src/audio/files";

const source: NativeAudioFile = {
  kind: "nativeAudio", name: "采访.MP3", path: "/recordings/采访.MP3", size: 53 * 1024 * 1024,
  type: "audio/mpeg", fingerprint: "original-fixture", contentKey: "original-fixture",
};
const saved: NativeAudioFile = {
  ...source, path: "/attachment-cache/sessions/attachments/audio/audio-fixture/采访.MP3",
  fingerprint: "saved-fixture", contentKey: "saved-fixture",
};

test("MP3 通过实际拖放路由导入原文件，不选择模型、不解码、不上传或生成 TXT", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("导入不应访问网络"); };
  const draft = new AttachmentDraft();
  const off = subscribeDropSink((batch) => draft.add(batch, (file) => createAttachment(file, "/attachment-cache")));
  const calls: string[] = [];
  try {
    mockIPC((cmd, raw) => {
      calls.push(cmd);
      if (cmd === "audio_inspect") return source;
      assert.equal(cmd, "audio_attachment_import", "禁止导入时转写或读取整个音频到 WebView");
      assert.deepEqual(raw, { cachePath: "/attachment-cache", source });
      return saved;
    });
    await routeDroppedFiles([{ name: source.name, path: source.path, file: null }]);
    await draft.ready();
    assert.equal(draft.getSnapshot().notice, null);
    const [audio] = draft.getSnapshot().attachments;
    assert.equal(audio.kind, "audio");
    assert.equal(audio.name, source.name);
    assert.equal(audio.mime, "audio/mpeg");
    assert.equal(audio.size, source.size);
    assert.equal(audio.audioPath, saved.path);
    assert.equal(audio.text, null);
    assert.equal(audio.dataUrl, null);
    assert.equal(calls.filter((cmd) => cmd === "audio_attachment_import").length, 1);
    for (const includeImages of [true, false]) {
      const content = JSON.stringify(toUserContent("", [audio], includeImages));
      assert.match(content, /attachmentId/);
      assert.match(content, /尚未转写/);
      assert.match(content, /仅附加文件不代表要求转写/);
      assert(!content.includes(saved.path), "本地路径只供工具解析，不发给聊天模型");
      assert(!content.includes("transcript.txt"));
    }
    const html = renderToStaticMarkup(createElement(UserMessage, { text: "", attachments: [audio] }));
    assert.match(html, /采访.MP3/);
    assert.match(html, /53.0 MB/);
    assert(!html.includes("transcript.txt"));
    draft.sent([audio]);
    assert.equal(draft.getSnapshot().attachments.length, 0);
    draft.restore([audio]);
    assert.deepEqual(draft.getSnapshot().attachments, [audio], "撤销排队仍恢复原文件引用");

    const { useAppStore } = await import("../src/app/state");
    const { toStoredConversation, fromStoredConversation } = await import("../src/cache/sessionDb");
    useAppStore.setState({ sessionsRestored: true, sessionsRestoreError: null });
    useAppStore.getState().newChat();
    const id = useAppStore.getState().activeThreadId;
    useAppStore.getState().startAssistantReply(id, "", [audio]);
    const state = useAppStore.getState();
    const thread = state.threads.find((item) => item.id === id)!;
    const reloaded = fromStoredConversation(toStoredConversation(thread, state.messages[id]));
    assert.deepEqual(reloaded.messages[0].attachments, [audio], "重新加载保留音频类型与本地副本");
  } finally {
    off(); clearMocks(); globalThis.fetch = originalFetch;
    if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window");
  }
});

test("粘贴或选择 MP3 分批保存原始字节，保存完成后才发送，失败会清理临时文件", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const bytes = new Uint8Array(1024 * 1024 + 5);
  bytes.set([73, 68, 51, 0, 255]); bytes[bytes.length - 1] = 128;
  const file = new File([bytes], "clipboard.mp3", { type: "audio/mpeg" });
  file.arrayBuffer = async () => { throw new Error("禁止读取整个原文件"); };
  const staged = { ...source, name: file.name, size: file.size, path: "/temporary/audio-source" };
  let copied = 0, released = 0, fail = false;
  let begin!: () => void;
  const copyingStarted = new Promise<void>((resolve) => { begin = resolve; });
  let complete!: (value: NativeAudioFile) => void;
  const copying = new Promise<NativeAudioFile>((resolve) => { complete = resolve; });
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, unknown>;
      if (cmd === "audio_stage_create") { assert.equal(args.name, file.name); copied = 0; return; }
      if (cmd === "audio_stage_append") {
        const chunk = Buffer.from(args.encoded as string, "base64");
        assert.equal(args.offset, copied);
        assert(chunk.length <= 1024 * 1024);
        assert.deepEqual(chunk, Buffer.from(bytes.slice(copied, copied + chunk.length)));
        copied += chunk.length; return;
      }
      if (cmd === "audio_stage_finish") return staged;
      if (cmd === "audio_stage_release") { released++; return; }
      assert.equal(cmd, "audio_attachment_import");
      assert.deepEqual(args.source, staged);
      if (fail) throw new Error("磁盘空间不足");
      begin();
      return copying;
    });
    const draft = new AttachmentDraft();
    draft.add(restoreFiles([{ name: file.name, path: null, file }]), (item) => createAttachment(item, "/attachment-cache"));
    let ready = false;
    const sending = draft.ready().then(() => { ready = true; });
    await copyingStarted;
    assert.equal(ready, false);
    complete({ ...saved, name: file.name, size: file.size });
    await sending;
    assert.equal(copied, file.size);
    assert.equal(released, 1);
    assert.equal(draft.getSnapshot().attachments[0].name, file.name);
    fail = true;
    draft.add(Promise.resolve({ files: [file], failed: [] }), (item) => createAttachment(item, "/attachment-cache"));
    await draft.ready();
    assert.equal(draft.getSnapshot().attachments.length, 1, "失败不生成空附件或替换已有文件");
    assert.match(draft.getSnapshot().notice!, /磁盘空间不足/);
    assert.equal(released, 2);
  } finally {
    clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window");
  }
});
