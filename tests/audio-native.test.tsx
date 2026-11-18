import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { nativeAudioSource } from "../src/app/desktop/audioFiles";
import { prepareAudio } from "../src/app/desktop/audioSegments";
import { restoreFiles } from "../src/app/fileDrop";
import { transcribeAudio } from "../src/audio/transcription";
import type { NativeAudioFile } from "../src/audio/files";

const file: NativeAudioFile = { kind: "nativeAudio", name: "interview.mp4", path: "/source/interview.mp4", size: 5 * 1024 ** 3,
  type: "audio/mp4", fingerprint: "native-revision", contentKey: "native-revision" };
const connection = { url: "https://audio.example/v1", key: "test-token", modelId: "asr", supportsImages: false, visionModelId: "" };

test("原生路径支持 GB 文件、失败续传、账号隔离、缓存恢复和取消", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const stored = new Map<string, string>();
  const options = { cachePath: "/audio-resume-cache", scope: "local-owner" };
  const calls: number[] = [];
  const releases: string[] = [];
  const progress: string[] = [];
  let fail = true, prepareCalls = 0;
  let stop: AbortController | undefined;
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, unknown>;
      if (cmd === "audio_inspect") return file;
      if (cmd === "cache_read") return stored.get(args.relative as string) ?? null;
      if (cmd === "audio_checkpoint_save") { stored.set(`temp/audio-transcriptions/${args.key}.json`, args.contents as string); return; }
      if (cmd === "audio_release") { releases.push(args.preparedId as string); return; }
      if (cmd === "model_abort") return;
      if (cmd === "audio_prepare") {
        prepareCalls++;
        assert.deepEqual(args.source, file);
        assert(!("encoded" in args));
        return { id: args.requestId, count: 3 };
      }
      assert.equal(cmd, "audio_transcribe_segment");
      assert.equal(args.url, "https://audio.example/v1/audio/transcriptions");
      assert.equal(args.model, "asr");
      assert.equal(args.key, "test-token");
      calls.push(args.index as number);
      if (stop) stop.abort();
      if (args.index === 1 && fail) return { status: 429, body: "", aborted: false };
      return { status: 200, body: JSON.stringify({ text: ["第一段", "", "最后一段"][args.index as number] }), aborted: false };
    });
    await assert.rejects(transcribeAudio(file, connection, undefined, undefined, options), /第 2\/3 段转写失败.*HTTP 429.*已保存/);
    assert.deepEqual(calls, [0, 1]);
    assert.equal(releases.length, 1);
    assert(![...stored.values()].join("").includes(connection.key));
    fail = false; calls.length = 0;
    assert.equal(await transcribeAudio(file, connection, undefined, (label) => progress.push(label), options), "第一段\n\n最后一段");
    assert.deepEqual(calls, [1, 2]);
    assert(progress.some((label) => label.includes("已恢复 1/3")));
    calls.length = 0;
    assert.equal(await transcribeAudio(file, connection, undefined, undefined, options), "第一段\n\n最后一段");
    assert.equal(prepareCalls, 2);
    assert.deepEqual(calls, []);
    assert.equal(releases.length, 2);
    await transcribeAudio(file, connection, undefined, undefined, { ...options, scope: "other-owner" });
    assert.deepEqual(calls, [0, 1, 2]);
    calls.length = 0; stop = new AbortController();
    await assert.rejects(transcribeAudio(file, connection, stop.signal, undefined, { ...options, scope: "cancel" }), { name: "AbortError" });
    assert.deepEqual(calls, [0]);
    assert.equal(releases.length, 4);
    stop = undefined; calls.length = 0;
    const concurrent = { ...options, scope: "concurrent-owner" };
    const both = await Promise.all([transcribeAudio(file, connection, undefined, undefined, concurrent), transcribeAudio(file, connection, undefined, undefined, concurrent)]);
    assert.equal(both[0], both[1]);
    assert.deepEqual(calls, [0, 1, 2]);
  } finally { clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window"); }
});

test("剪贴板导入按 1 MiB 传输，禁止读取整文件，取消后清理临时原文件", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const blob = new File([new Uint8Array(2 * 1024 * 1024 + 3)], "clipboard.mp3");
  blob.arrayBuffer = async () => { throw new Error("不得读取整文件"); };
  let bytes = 0, releases = 0, appends = 0;
  let stop: AbortController | undefined;
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, unknown>;
      if (cmd === "audio_stage_create") { assert.equal(args.size, blob.size); bytes = 0; return; }
      if (cmd === "audio_stage_append") {
        const chunk = atob(args.encoded as string);
        assert(chunk.length <= 1024 * 1024);
        assert.equal(args.offset, bytes);
        bytes += chunk.length; appends++;
        stop?.abort(); return;
      }
      if (cmd === "audio_stage_finish") return { ...file, name: blob.name, size: blob.size };
      if (cmd === "audio_stage_release") { releases++; return; }
      assert.fail(`unexpected ${cmd}`);
    });
    const prepared = await nativeAudioSource(blob);
    assert.equal(bytes, blob.size);
    assert.equal(appends, 3);
    await prepared.release();
    assert.equal(releases, 1);
    stop = new AbortController();
    await assert.rejects(nativeAudioSource(blob, stop.signal), { name: "AbortError" });
    assert.equal(releases, 2);
    assert.equal(bytes, 1024 * 1024);
  } finally { clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window"); }
});

test("原生拖入音视频只读取元信息，不调用二进制文件读取", async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  try {
    mockIPC((cmd) => { assert.equal(cmd, "audio_inspect"); return file; });
    const batch = await restoreFiles([{ name: file.name, path: file.path, file: null }]);
    assert.deepEqual(batch.files, [file]);
    assert.deepEqual(batch.failed, []);
  } finally { clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window"); }
});

test("取消早于原生注册时通过就绪通知重发，并清理迟到的准备结果", { timeout: 3000 }, async () => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const stop = new AbortController();
  let acknowledge!: () => void, complete!: (value: unknown) => void;
  const firstAbort = new Promise<void>((resolve) => { acknowledge = resolve; });
  const result = new Promise((resolve) => { complete = resolve; });
  let aborts = 0, releases = 0;
  try {
    mockIPC(async (cmd, raw) => {
      const args = raw as { requestId: string; source: NativeAudioFile; onReady: { onmessage: (value: null) => void } };
      if (cmd === "audio_release") { releases++; return; }
      if (cmd === "model_abort") { aborts++; if (aborts === 1) acknowledge(); else complete({ id: args.requestId, count: 1 }); return; }
      assert.equal(cmd, "audio_prepare");
      assert.deepEqual(args.source, file);
      stop.abort(); await firstAbort; args.onReady.onmessage(null);
      return result;
    });
    await assert.rejects(prepareAudio(file, stop.signal), { name: "AbortError" });
    assert.equal(aborts, 2);
    assert.equal(releases, 1);
  } finally { clearMocks(); if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, "window"); }
});
