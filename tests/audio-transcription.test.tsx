import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { AUDIO_MIME, MAX_AUDIO_BYTES, audioMime, isAudioFile, validateAudio, validateAudioUpload } from "../src/audio/files";
import { parseTranscription, transcribeAudio, transcriptAttachment, transcriptionConnection } from "../src/audio/transcription";
import { toUserContent } from "../src/model/attachments";
import { AttachmentDraft } from "../src/model/attachmentDraft";
import { selectPersistedState, migratePersistedState } from "../src/app/state/persistence";
import { createModelsSlice } from "../src/app/state/slices/models";
import { selectTranscriptionModel, transcriptionCapability } from "../src/audio/models";
import type { AppStore } from "../src/app/storeTypes";
import type { RemoteModel } from "../src/app/types";

const models: RemoteModel[] = [
  { id: 1, code: "chat", name: "聊天", provider: "local", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "", description: "" },
  { id: 2, code: "asr", name: "语音识别", provider: "test", baseUrl: "https://audio.example/v1/", apiKey: "test-token", description: "" },
];
const connection = transcriptionConnection(models, "asr");

test("音频校验区分 原文件大小和 25 MB 上传上限，转写不会回退到聊天模型", () => {
  for (const extension of Object.keys(AUDIO_MIME)) {
    assert(isAudioFile({ name: `音频.${extension.toUpperCase()}`, type: "" }));
    validateAudio({ name: `音频.${extension}`, size: MAX_AUDIO_BYTES });
  }
  assert.equal(audioMime("录音.M4A"), "audio/mp4");
  assert(isAudioFile({ name: "clip.aac", type: "audio/aac" }));
  assert(!isAudioFile({ name: "readme.txt", type: "text/plain" }));
  assert.throws(() => validateAudio({ name: "clip.aac", size: 4 }), /不支持/);
  assert.throws(() => validateAudio({ name: "clip.wav", size: 0 }), /为空/);
  validateAudio({ name: "clip.mp3", size: MAX_AUDIO_BYTES + 1 });
  validateAudio({ name: "clip.mp3", size: 5 * 1024 ** 3 });
  assert.throws(() => validateAudioUpload({ name: "clip.wav", size: MAX_AUDIO_BYTES + 1 }), /分段/);
  assert.throws(() => transcriptionConnection(models, ""), /选择/);
  assert.throws(() => transcriptionConnection(models, "removed-model"), /选择/);
  assert.equal(connection.modelId, "asr");
  assert.equal(connection.url, models[1].baseUrl);
  assert.equal(connection.key, models[1].apiKey);
});

test("拖入音频不会发给误选的聊天模型，唯一的授权语音模型可自动选择", () => {
  const chat = { ...models[0], code: "gpt-6.1-sol" };
  const speech = { ...models[1], code: "gpt-transcribe" };
  assert.throws(() => transcriptionConnection([chat, speech], chat.code), /不支持文件转写/);
  assert.equal(transcriptionConnection([chat, speech], "").modelId, speech.code);
  assert.throws(() => transcriptionConnection([chat, speech, { ...speech, code: "whisper-1" }], ""), /选择/);
  const gateway = { ...chat, supportsAudioTranscription: true };
  assert.equal(transcriptionConnection([gateway], gateway.code).modelId, gateway.code);
});

test("Qwen3-ASR 别名、规格与完整仓库名可自动识别，显式能力声明优先", () => {
  for (const code of ["qwen3-asr", "Qwen3-ASR-0.6B", "Qwen/Qwen3-ASR-1.7B", "qwen3_asr"]) {
    const speech = { ...models[1], code };
    assert.equal(transcriptionCapability(speech), "supported");
    assert.equal(selectTranscriptionModel([models[0], speech], ""), speech);
    assert.equal(transcriptionConnection([models[0], speech], "").modelId, code);
    assert.equal(transcriptionCapability({ ...speech, supportsAudioTranscription: false }), "unsupported");
  }
  assert.equal(transcriptionCapability({ ...models[1], code: "Qwen3-ForcedAligner-0.6B" }), "unverified");
  assert.equal(transcriptionCapability({ ...models[1], code: "qwen3-asrish" }), "unverified");
});

test("自动与显式语音模型选择共用可用性判断，缺失或被禁用时不回退", () => {
  const speech = { ...models[1], code: "qwen3-asr" };
  const list = [models[0], speech];
  assert.equal(selectTranscriptionModel(list, ""), speech);
  assert.equal(selectTranscriptionModel(list, speech.code), speech);
  assert.equal(selectTranscriptionModel(list, "removed"), null);
  assert.equal(selectTranscriptionModel([{ ...speech, supportsAudioTranscription: false }], speech.code), null);
  assert.equal(selectTranscriptionModel([speech, { ...speech, code: "Qwen/Qwen3-ASR-1.7B" }], ""), null);
  assert.equal(selectTranscriptionModel([], ""), null);
});

test("转写响应拒绝无效结果，并给出授权、路由和额度的操作提示", () => {
  assert.equal(parseTranscription(200, JSON.stringify({ text: "  会议记录\n第二段。  " })), "会议记录\n第二段。");
  assert.throws(() => parseTranscription(200, "<html>gateway</html>"), /JSON/);
  assert.throws(() => parseTranscription(200, '{"message":"ok"}'), /未返回/);
  assert.throws(() => parseTranscription(200, '{"text":"  "}'), /未识别/);
  assert.throws(() => parseTranscription(200, '{"text":4}'), /未返回/);
  assert.throws(() => parseTranscription(401, "private upstream details"), /授权/);
  assert.throws(() => parseTranscription(404, ""), /接口/);
  assert.throws(() => parseTranscription(413, ""), /分段/);
  assert.throws(() => parseTranscription(429, ""), /额度/);
});

test("上传真实音频字节和选定模型，失败不重试，取消不产生请求", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(input, "https://audio.example/v1/audio/transcriptions");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer test-token");
      assert.equal(headers.get("Content-Type"), null); // fetch must generate the multipart boundary.
      const form = init?.body as FormData;
      assert.equal(form.get("model"), "asr");
      assert.equal(form.get("response_format"), "json");
      const part = form.get("file") as File;
      assert.equal(part.name, "recording.WAV");
      assert.equal(part.type, "audio/wav");
      assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [0, 255, 65]);
      return new Response('{"text":"你好，世界。"}', { status: calls === 2 ? 503 : 200 });
    };
    const file = new File([new Uint8Array([0, 255, 65])], "recording.WAV");
    assert.equal(await transcribeAudio(file, connection), "你好，世界。");
    await assert.rejects(transcribeAudio(file, connection), /HTTP 503/);
    assert.equal(calls, 2);
    const stop = new AbortController(); stop.abort();
    await assert.rejects(transcribeAudio(file, connection, stop.signal), { name: "AbortError" });
    assert.equal(calls, 2);
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
    });
    const running = new AbortController();
    const result = transcribeAudio(file, connection, running.signal);
    running.abort();
    await assert.rejects(result, { name: "AbortError" });
  } finally { globalThis.fetch = originalFetch; }
});

test("转写作为普通文字附件完整进入对话，等待完成后才能发送，原始录音不进入历史", async () => {
  const draft = new AttachmentDraft();
  let finish!: (text: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  draft.add(Promise.resolve({ files: [new File(["data"], "meeting.mp3")], failed: [] }), async (file) => ({
    ok: true, attachment: transcriptAttachment(file.name, await pending),
  }));
  assert.equal(draft.getSnapshot().pending, 1);
  let ready = false;
  const sending = draft.ready().then(() => { ready = true; });
  await Promise.resolve();
  assert(!ready);
  finish("你好\n会议结论");
  await sending;
  const [attachment] = draft.getSnapshot().attachments;
  assert.equal(attachment.name, "meeting.mp3.transcript.txt");
  assert.equal(attachment.dataUrl, null);
  assert.equal(attachment.size, new TextEncoder().encode("你好\n会议结论").length);
  assert.match(String(toUserContent("总结会议", [attachment], false)), /你好\n会议结论/);
  draft.sent([attachment]);
  assert.equal(draft.getSnapshot().attachments.length, 0);
});

test("音频模型仅持久化选择，旧设置升级默认不配置音频服务", () => {
  let state = createModelsSlice((patch) => {
    Object.assign(state, typeof patch === "function" ? patch(state as AppStore) : patch);
  }, () => state as AppStore, {} as never);
  assert.equal(state.audioModelCode, "");
  state.setAudioModelCode("asr");
  const persisted = selectPersistedState(state as AppStore);
  assert.equal(persisted.audioModelCode, "asr");
  assert(!("modelConfig" in persisted));
  assert(!("remoteModels" in persisted));
  assert.equal(migratePersistedState({ audioModelCode: "asr" }).audioModelCode, "asr");
});

