import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { runAudioTool } from "../src/audio/tool";
import { TRANSCRIBE_AUDIO_NAME } from "../src/audio/protocol";
import { CLIENT_TOOL_NAMES, BUILTIN_TOOL_GROUPS } from "../src/tools/catalog";
import type { ToolCallExecutionContext } from "../src/hooks/agentToolCall";
import type { MessageAttachment, StreamItem } from "../src/app/types";

test("模型工具经审批后按路径转写，保存全文并分页回传，后续读取复用转写", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const stored = new Map<string, string>();
  const text = "会议记录".repeat(6000);
  const items: StreamItem[] = [];
  let accepted = false, networkCalls = 0, inspected = 0, written = "", counter = 0;
  const context = {
    nextId: () => `audio-${++counter}`, push: (item: StreamItem) => items.push(item),
    patch: (id: string, update: (item: StreamItem) => StreamItem) => { const at = items.findIndex((item) => item.id === id); if (at >= 0) items[at] = update(items[at]); },
    controller: new AbortController(), valid: () => true, cachePath: "/tool-cache", artifactDir: "/artifacts", workspacePath: "/project",
    approvalHost: { threadId: "audio-test", push: () => {}, patch: () => {}, wait: async () => accepted },
    store: { audioModelCode: "asr", modelSource: "local", endpoint: null, currentUser: null, loadArtifacts: async () => {}, remoteModels: [
      { id: 1, code: "asr", name: "语音", provider: "test", baseUrl: "https://asr.example/v1", apiKey: "test-token", description: "" },
    ] },
  } as unknown as ToolCallExecutionContext;
  const call = { id: "transcribe", type: "function" as const, function: { name: TRANSCRIBE_AUDIO_NAME, arguments: JSON.stringify({ path: "meeting.mp4" }) } };
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, unknown>;
      if (cmd === "audio_inspect") {
        inspected++; assert(accepted); assert.equal(args.base, args.path === "meeting.mp4" ? "/project" : null);
        return { kind: "nativeAudio", name: "meeting.mp4", path: "/project/meeting.mp4", size: 3 * 1024 ** 3, type: "audio/mp4", fingerprint: "tool-fixture", contentKey: "tool-fixture" };
      }
      if (cmd === "cache_read") return stored.get(args.relative as string) ?? null;
      if (cmd === "audio_checkpoint_save") { stored.set(`temp/audio-transcriptions/${args.key}.json`, args.contents as string); return; }
      if (cmd === "audio_prepare") return { id: args.requestId, count: 1 };
      if (cmd === "audio_release") return;
      if (cmd === "audio_transcribe_segment") { networkCalls++; return { status: 200, body: JSON.stringify({ text }), aborted: false }; }
      if (cmd === "artifact_write") { written = args.contents as string; assert.match(args.name as string, /^transcript-/); return { bytes: Buffer.byteLength(written) }; }
      assert.fail(`unexpected ${cmd}`);
    });
    assert.match(await runAudioTool(call, context), /未获批准/);
    assert.equal(inspected, 0);
    assert.equal(networkCalls, 0);
    accepted = true;
    const output = await runAudioTool(call, context);
    assert.equal(written.length, text.length);
    assert.match(output, /offset=16000/);
    assert.equal(networkCalls, 1);
    const next = await runAudioTool({ ...call, function: { ...call.function, arguments: JSON.stringify({ path: "meeting.mp4", offset: 16000 }) } }, context);
    assert.match(next, /已到末尾/);
    assert.equal(networkCalls, 1);
    assert(CLIENT_TOOL_NAMES.includes(TRANSCRIBE_AUDIO_NAME));
    assert(BUILTIN_TOOL_GROUPS.some((group) => group.tools.some((tool) => tool.function.name === TRANSCRIBE_AUDIO_NAME)));
  } finally { clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window"); }
});

test("明确转写会话音频附件时按 ID 解析原文件，经审批调用管理端模型，并保留原附件", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const audio: MessageAttachment = {
    id: "recording-original", name: "采访.mp3", kind: "audio", mime: "audio/mpeg", size: 100,
    audioPath: "/cache/sessions/attachments/audio/saved/采访.mp3", text: null, dataUrl: null,
  };
  const original = structuredClone(audio);
  const items: StreamItem[] = [];
  let accepted = false, approvals = 0, reads = 0, uploads = 0, written = "", counter = 0;
  const context = {
    attachments: [], threadId: "this-chat",
    nextId: () => `attachment-tool-${++counter}`, push: (item: StreamItem) => items.push(item),
    patch: (id: string, update: (item: StreamItem) => StreamItem) => { const at = items.findIndex((item) => item.id === id); if (at >= 0) items[at] = update(items[at]); },
    controller: new AbortController(), valid: () => true, cachePath: "/tool-cache", artifactDir: "/artifacts", workspacePath: "/project",
    approvalHost: { threadId: "this-chat", push: () => { approvals++; }, patch: () => {}, wait: async () => accepted },
    store: {
      audioModelCode: "", modelSource: "remote", endpoint: null, currentUser: null, loadArtifacts: async () => {},
      messages: {
        "this-chat": [{ id: "previous-user-turn", role: "user", items: [], attachments: [audio] }],
        "other-chat": [{ id: "another-user-turn", role: "user", items: [], attachments: [{ ...audio, id: "other-recording" }] }],
      },
      remoteModels: [{ id: 1, code: "qwen3-asr", name: "Qwen3-ASR", provider: "test", baseUrl: "https://asr.example/v1", apiKey: "test-token", description: "" }],
    },
  } as unknown as ToolCallExecutionContext;
  const call = (args: Record<string, unknown>) => ({ id: "transcribe-attachment", type: "function" as const,
    function: { name: TRANSCRIBE_AUDIO_NAME, arguments: JSON.stringify(args) } });
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, unknown>;
      if (cmd === "audio_inspect") {
        reads++; assert(accepted); assert.equal(args.path, audio.audioPath);
        return { kind: "nativeAudio", name: audio.name, path: audio.audioPath, size: audio.size, type: audio.mime, fingerprint: "attached-fixture", contentKey: "attached-fixture" };
      }
      if (cmd === "cache_read") return null;
      if (cmd === "audio_checkpoint_save" || cmd === "audio_release") return;
      if (cmd === "audio_prepare") return { id: args.requestId, count: 1 };
      if (cmd === "audio_transcribe_segment") {
        uploads++; assert.equal(args.model, "qwen3-asr");
        assert.equal(args.url, "https://asr.example/v1/audio/transcriptions");
        return { status: 200, body: '{"text":"采访内容。"}', aborted: false };
      }
      if (cmd === "artifact_write") { written = args.contents as string; assert.match(args.name as string, /^transcript-/); return { bytes: 15 }; }
      assert.fail(`unexpected ${cmd}`);
    });
    assert.match(await runAudioTool(call({ attachmentId: "other-recording" }), context), /当前会话中找不到/);
    assert.match(await runAudioTool(call({ attachmentId: audio.id, path: "/override.mp3" }), context), /二者选一/);
    assert.equal(approvals, 0);
    assert.match(await runAudioTool(call({ attachmentId: audio.id }), context), /未获批准/);
    assert.equal(reads, 0); assert.equal(uploads, 0);
    accepted = true;
    assert.match(await runAudioTool(call({ attachmentId: audio.id }), context), /采访内容。/);
    assert.equal(uploads, 1);
    assert.equal(written, "采访内容。");
    assert.deepEqual(audio, original, "转写产物单独保存，不把原 MP3 替换为 TXT");
  } finally { clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window"); }
});
