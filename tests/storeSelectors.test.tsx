import assert from "node:assert/strict";
import test from "node:test";
import { selectChatModelConnectionByCode, selectModelConnectionByCode } from "../src/app/storeSelectors";
import { applyLoadedModels } from "../src/app/state/models";
import { useAppStore } from "../src/app/state";
import { parseLocalModels, serializeLocalModels } from "../src/model/localModels";

/** 构造带一个授权模型的 store 状态切片。 */
function stateWith(models: unknown[]) {
  return { remoteModels: models, imageInputEnabled: false } as never;
}

test("按 code 选中模型时返回完整连接信息而非崩溃", () => {
  const connection = selectModelConnectionByCode(
    stateWith([{ code: "m1", name: "测试模型", baseUrl: "https://example.com/v1", apiKey: "sk-test" }]),
    "m1",
  );
  assert.ok(connection);
  assert.equal(connection.modelId, "m1");
  assert.equal(connection.url, "https://example.com/v1");
  assert.equal(connection.key, "sk-test");
});

test("空选择码与未知 code 均返回 null，不进入派生逻辑", () => {
  const state = stateWith([{ code: "m1", name: "测试模型", baseUrl: "https://example.com/v1", apiKey: "sk-test" }]);
  assert.equal(selectModelConnectionByCode(state, ""), null);
  assert.equal(selectModelConnectionByCode(state, "missing"), null);
  assert.equal(selectModelConnectionByCode(stateWith([]), "m1"), null);
});

test("对话列表过滤专用模型，保留工具连接与显式支持聊天的多用途模型", () => {
  const { models, errors } = parseLocalModels(JSON.stringify([
    { code: "doubao-seedance-2-5-260628" },
    { code: "openai/whisper-1" },
    { code: "gpt-4o-mini-transcribe" },
    { code: "text-embedding-3-small" },
    { code: "gpt-image-1" },
    { code: "custom-tool", supportsChat: false },
    { code: "custom-audio", supportsAudioTranscription: true },
    { code: "old-video-endpoint" },
    { code: "old-image-endpoint" },
    { code: "gemini-vision", supportsImages: true },
    { code: "multi-purpose", supportsChat: true, supportsAudioTranscription: true },
  ].map((entry) => ({ ...entry, baseUrl: "https://example.com/v1" }))));
  assert.deepEqual(errors, []);
  assert.deepEqual(parseLocalModels(serializeLocalModels(models)).models, models);
  const selections = { imageModelCode: "old-image-endpoint", videoModelCode: "old-video-endpoint", audioModelCode: "multi-purpose" };
  const loaded = applyLoadedModels(models, "doubao-seedance-2-5-260628", false, selections);
  assert.deepEqual(loaded.modelOptions.map(({ id }) => id), ["gemini-vision", "multi-purpose"]);
  assert.equal(loaded.modelConfig?.modelId, "gemini-vision");
  assert.equal(loaded.modelOptions[0].supportsImages, true);
  assert.equal(loaded.remoteModels, models);
  const multiUse = applyLoadedModels(models, "multi-purpose", false, { ...selections, imageModelCode: "multi-purpose" });
  assert.equal(multiUse.model, "multi-purpose");
  const toolsOnly = applyLoadedModels(models.slice(0, 8), "old-video-endpoint", false, selections);
  assert.equal(toolsOnly.model, "");
  assert.equal(toolsOnly.modelConfig, null);
  assert.deepEqual(toolsOnly.modelOptions, []);
});

test("调整专用模型配置更新对话选择，无法把专用模型切为对话连接", () => {
  const before = useAppStore.getState();
  const video = "custom-endpoint";
  const audio = "custom-transcription";
  const image = "custom-image-endpoint";
  const chat = "gpt-5.5";
  const { models } = parseLocalModels(JSON.stringify([video, audio, image, chat].map((code) => ({ code, baseUrl: "https://example.com/v1" }))));
  const selections = { imageModelCode: "", videoModelCode: "", audioModelCode: "" };
  try {
    useAppStore.setState({ ...selections, ...applyLoadedModels(models, video, false, selections) });
    useAppStore.getState().setVideoModelCode(video);
    assert.equal(useAppStore.getState().model, audio);
    useAppStore.getState().setAudioModelCode(audio);
    useAppStore.getState().setImageModelCode(image);
    useAppStore.getState().setImageInputEnabled(true);
    assert.deepEqual(useAppStore.getState().modelOptions.map(({ id }) => id), [chat]);
    useAppStore.getState().setModel(video);
    const state = useAppStore.getState();
    assert.equal(state.model, chat);
    assert.equal(state.modelConfig?.modelId, chat);
    assert.equal(selectChatModelConnectionByCode(state, video), null);
    assert.equal(selectModelConnectionByCode(state, video)?.modelId, video);
    assert.equal(selectChatModelConnectionByCode(state, image), null);
    assert.equal(selectModelConnectionByCode(state, image)?.modelId, image);
    state.setAudioModelCode(chat);
    assert.equal(useAppStore.getState().model, chat);
    state.setVideoModelCode(video);
    assert.deepEqual(useAppStore.getState().modelOptions.map(({ id }) => id), [audio, chat]);
  } finally {
    useAppStore.setState(before);
  }
});
