import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { runAudioTool } from "../src/audio/tool";
import { TRANSCRIBE_AUDIO_NAME } from "../src/audio/protocol";
import { CLIENT_TOOL_NAMES, BUILTIN_TOOL_GROUPS } from "../src/tools/catalog";
import type { ToolCallExecutionContext } from "../src/hooks/agentToolCall";
import type { StreamItem } from "../src/app/types";

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
