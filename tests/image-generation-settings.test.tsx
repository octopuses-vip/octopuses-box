import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { useAppStore } from "../src/app/state";
import { migratePersistedState, selectPersistedState } from "../src/app/state/persistence";
import { connectionFromModel, selectImageModelConnection } from "../src/app/storeSelectors";
import type { RemoteModel, StreamItem } from "../src/app/types";
import { runToolCall, type ToolCallExecutionContext } from "../src/hooks/agentToolCall";
import { IMAGE_GEN_TOOL_NAME, runGenerateImageTool } from "../src/tools/imageGen";

const image: RemoteModel = { id: 1, code: "custom-art", name: "图片服务", provider: "test", description: "",
  baseUrl: "https://image.example/v1", apiKey: "image-key" };
const chat: RemoteModel = { ...image, id: 2, code: "chat", name: "对话服务", supportsChat: true,
  baseUrl: "https://chat.example/v1", apiKey: "chat-key" };
const chatConnection = connectionFromModel(chat, false);
const args = JSON.stringify({ prompt: "一只猫", size: "1536x1024", name: "cat.png" });

test("图片模型选择重启可恢复，只保存模型 code，并处理原模型下架", () => {
  const before = useAppStore.getState();
  try {
    useAppStore.setState({ imageModelCode: "", remoteModels: [image, chat], model: chat.code });
    assert.equal(selectImageModelConnection(useAppStore.getState(), chatConnection), chatConnection);
    useAppStore.getState().setImageModelCode(image.code);
    const selected = useAppStore.getState();
    assert.deepEqual(selectImageModelConnection(selected, chatConnection), connectionFromModel(image, false));
    const saved = JSON.parse(JSON.stringify(selectPersistedState(selected)));
    assert.equal(migratePersistedState(saved).imageModelCode, image.code);
    assert.equal(migratePersistedState({}).imageModelCode, "");
    assert(!("remoteModels" in saved));
    assert(!("modelConfig" in saved));
    assert(!JSON.stringify(saved).includes(image.apiKey));
    assert(!JSON.stringify(saved).includes(image.baseUrl));
    useAppStore.setState({ remoteModels: [chat] });
    assert.equal(selectImageModelConnection(useAppStore.getState(), chatConnection), null);
  } finally { useAppStore.setState(before); }
});

test("图片工具使用独立模型的地址、密钥与模型名，模型下架后不会改用对话服务", async () => {
  const before = useAppStore.getState();
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const items: StreamItem[] = [];
  let posts = 0, writes = 0, refreshes = 0, counter = 0;
  try {
    useAppStore.setState({ imageModelCode: image.code, remoteModels: [image, chat], model: chat.code,
      loadArtifacts: async () => { refreshes++; } });
    const threadId = useAppStore.getState().createThread("图片模型测试", "", false);
    const thread = useAppStore.getState().threads.find((item) => item.id === threadId)!;
    const push = (item: StreamItem) => { items.push(item); };
    const patch: ToolCallExecutionContext["patch"] = (id, update) => {
      const at = items.findIndex((item) => item.id === id);
      if (at >= 0) items[at] = update(items[at]);
    };
    const context: ToolCallExecutionContext = {
      controller: new AbortController(), startedAt: Date.now(), valid: () => true, push, patch,
      state: { producedAny: false, askPending: false }, canSpawnSubagent: false,
      threadId, threadProjectId: "", thread, execute: async () => "success", mcpBindings: [],
      cachePath: "/test/image-settings", skillToolScope: { mounted: new Set([IMAGE_GEN_TOOL_NAME]), known: new Set([IMAGE_GEN_TOOL_NAME]) },
      messageId: "image-answer", attachments: [], artifactDir: "/artifacts", config: chatConnection, store: useAppStore.getState(),
      approvalHost: { threadId, push, patch, wait: async () => false }, workspacePath: null,
      renderedCheckpoints: new Set(), sshHosts: [], pendingImages: [], runId: "image-run", model: chat.code,
      nextId: (prefix) => `${prefix}-${++counter}`,
    };
    mockIPC((cmd, raw) => {
      const request = raw as Record<string, string>;
      if (cmd === "model_fetch") {
        posts++;
        assert.equal(request.method, "POST");
        assert.equal(request.url, image.baseUrl + "/images/generations");
        assert.equal(request.key, image.apiKey);
        assert.deepEqual(JSON.parse(request.body), { model: image.code, prompt: "一只猫", n: 1, size: "1536x1024" });
        return { status: 200, body: '{"data":[{"b64_json":"YWJj"}]}' };
      }
      assert.equal(cmd, "artifact_write_bytes");
      writes++;
      assert.equal(request.dir, "/artifacts");
      assert.equal(request.name, "cat.png");
      assert.equal(request.data, "YWJj");
      return { bytes: 3 };
    });
    const call = { id: "image-call", type: "function" as const, function: { name: IMAGE_GEN_TOOL_NAME, arguments: args } };
    assert.match(String((await runToolCall(call, context)).content), /已生成 cat.png/);
    assert.equal(items.find((item) => item.type === "tool_call")?.status, "success");
    assert.equal(refreshes, 1);
    assert.equal(posts, 1);
    assert.equal(writes, 1);
    // Authorization can change during a conversation; do not reuse the stale context.store connection.
    useAppStore.setState({ remoteModels: [chat] });
    assert.match(String((await runToolCall(call, context)).content), /所选图片生成模型当前不可用/);
    assert.equal(posts, 1);
    assert.equal(writes, 1);
  } finally { clearMocks(); globalThis.window = oldWindow; useAppStore.setState(before); }
});

test("未配置图片模型仍沿用对话服务自动探测，选定模型请求失败时不再探测其他模型", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const calls: string[] = [];
  let selected = false;
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "artifact_write_bytes") return { bytes: 3 };
      assert.equal(cmd, "model_fetch");
      const request = raw as Record<string, string>;
      calls.push(request.method + " " + request.url);
      assert.equal(request.key, chat.apiKey);
      if (request.method === "GET") return { status: 200, body: '{"data":[{"id":"auto-image"}]}' };
      assert.equal(JSON.parse(request.body).model, selected ? chat.code : "auto-image");
      return selected ? { status: 403, body: '{"error":{"message":"access denied"}}' }
        : { status: 200, body: '{"data":[{"b64_json":"YWJj"}]}' };
    });
    assert((await runGenerateImageTool("/artifacts", chatConnection, args)).ok);
    assert.deepEqual(calls, ["GET " + chat.baseUrl + "/models", "POST " + chat.baseUrl + "/images/generations"]);
    selected = true;
    const failed = await runGenerateImageTool("/artifacts", chatConnection, args, undefined, chat.code);
    assert(!failed.ok);
    assert.match(failed.output, /403/);
    assert.equal(calls.length, 3);
    assert.equal(calls[2], "POST " + chat.baseUrl + "/images/generations");
  } finally { clearMocks(); globalThis.window = oldWindow; }
});
