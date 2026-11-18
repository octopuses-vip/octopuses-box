import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { readVideoStatus, videoRequest, predictionRequest, videoTaskId, VideoApiError, type VideoJob } from "../src/video/protocol";
import { advanceVideoJob, restoreVideoJobs, submitVideoJob, useVideoJobs, videoJobAt } from "../src/video/jobs";
import { toUserContent } from "../src/model/attachments";
import { artifactKind } from "../src/app/desktop/artifacts";
import { rightPanelTabs } from "../src/app/state/artifacts";
import { buildHistory, hasProducedArtifact } from "../src/hooks/useAgentRunShared";
import type { Message, MessageAttachment } from "../src/app/types";

const image: MessageAttachment = { id: "ref", name: "ocean.png", kind: "image", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,YWJj", text: null };
const prompt = JSON.stringify({ prompt: "海浪向前涌动", ratio: "16:9", duration: 5 });
const connection = { url: "https://video.test/api/v3", key: "mock", modelId: "ep-video" };

test("文字与首帧请求共用任务协议，纯文本聊天仅传递附件引用", () => {
  const text = videoRequest(prompt, [], connection.modelId);
  assert.equal(text.body.content.length, 1);
  const ref = videoRequest(prompt, [image], connection.modelId);
  assert.equal(ref.referenceId, image.id);
  assert.deepEqual(ref.body.content[1], { type: "image_url", role: "first_frame", image_url: { url: image.dataUrl } });
  assert.equal(ref.body.duration, 5);
  assert.doesNotMatch(String(toUserContent("/video 海浪", [image], false)), /data:image/);
  assert.match(String(toUserContent("/video 海浪", [image], false)), /ref/);
  assert.throws(() => videoRequest(prompt, [image, { ...image, id: "other" }], "model"), /指定一张/);
  assert.throws(() => videoRequest('{"prompt":"x","referenceId":"old"}', [image], "model"), /找不到/);
  assert.throws(() => videoRequest(prompt, [{ ...image, mime: "image/svg+xml" }], "model"), /JPEG/);
  assert.throws(() => videoRequest('{"prompt":""}', [], "model"), /描述/);
  assert.equal(artifactKind("clip.MP4"), "video");
  assert(rightPanelTabs([{ name: "clip.mp4", bytes: 1, kind: "video", modifiedAt: 0 }], [], [], "idle").includes("media"));
  assert.equal(readVideoStatus('{"status":"expired"}').phase, "failed");
  assert.throws(() => readVideoStatus('{"status":"succeeded","content":{}}'), /下载地址/);
});

test("恢复后聊天历史使用已完成的视频状态，排队中的视频不会被当作产物", () => {
  const messages: Message[] = [{ id: "turn", role: "assistant", items: [{
    id: "card", type: "tool_call", kind: "video_gen", videoJobId: "turn", status: "running",
    title: "生成视频", output: "", durationMs: null, command: null, callId: "call", name: "generate_video",
  }] }];
  assert(!hasProducedArtifact(messages));
  assert(hasProducedArtifact(messages, (id) => id === "turn"));
  const { history } = buildHistory(messages, "视频在哪里？", [], 0, false, () => "已生成 video-turn.mp4");
  assert(history.some((item) => item.role === "tool" && item.content === "已生成 video-turn.mp4"));
});

test("统一视频接口使用网关业务信封、首帧字段和输出视频，拒绝信息不误报为缺少任务 ID", () => {
  assert.deepEqual(predictionRequest(videoRequest(prompt, [image], connection.modelId).body), {
    model: connection.modelId, function: "video",
    input: { prompt: "海浪向前涌动", duration: 5, aspect_ratio: "16:9", first_frame_url: image.dataUrl },
  });
  assert.equal(videoTaskId('{"code":0,"data":{"task_id":"prediction-1"},"msg":""}'), "prediction-1");
  assert.equal(videoTaskId('{"code":0,"data":{"id":"native-1"}}'), "native-1");
  assert.equal(readVideoStatus('{"code":0,"data":{"task_status":"processing"}}', "predictions").phase, "running");
  assert.deepEqual(readVideoStatus('{"code":0,"data":{"task_status":"success","output":[{"type":"video","video":"https://cdn.test/result"}]}}', "predictions"), {
    phase: "downloading", detail: "", download: "https://cdn.test/result",
  });
  assert.equal(readVideoStatus('{"status":"failed","error":{"message":"rejected"}}').phase, "failed");
  assert.throws(() => videoTaskId('{"code":500,"data":{},"msg":"insufficient quota"}'), (e) => e instanceof VideoApiError && e.rejected && !e.routeMissing && e.message === "insufficient quota");
  assert.throws(() => videoTaskId('{"error":{"code":"422","message":"model:video,groups:[third-party] providers not found"}}', 422), (e) => e instanceof VideoApiError && e.rejected && !e.routeMissing && /没有所选模型的可用视频渠道/.test(e.message));
});

test("原生路由明确不存在才切换统一接口，持久化协议后重启仍查询原任务", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const base: VideoJob = { id: "compat-turn", threadId: "compat-thread", owner: "local", model: connection.modelId,
    baseUrl: connection.url, dir: "/cache/output", file: "video-compat.mp4", phase: "submitting", detail: "" };
  const stored = new Map<string, Map<string, VideoJob>>();
  const calls: string[] = [];
  let result = "success";
  const native = videoRequest(prompt, [image], connection.modelId).body;
  const missing = { status: 200, body: '{"code":500,"data":{},"msg":"No static resource v1/contents/generations/tasks for request"}' };
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, string>;
      if (cmd === "video_jobs") return [...(stored.get(args.cacheDir)?.values() ?? [])].map((j) => JSON.stringify(j));
      if (cmd === "video_save_job") {
        const rows = stored.get(args.cacheDir) ?? new Map();
        rows.set(args.id, JSON.parse(args.payload)); stored.set(args.cacheDir, rows); return;
      }
      if (cmd === "video_download") {
        assert.equal(args.url, "https://cdn.test/result"); return;
      }
      assert.equal(cmd, "model_fetch");
      calls.push(args.method + " " + args.url);
      if (args.url.endsWith("/contents/generations/tasks")) return missing;
      if (args.method === "POST") {
        assert.equal(args.url, connection.url + "/predictions");
        assert.deepEqual(JSON.parse(args.body), predictionRequest(native));
        return { status: 200, body: '{"code":0,"data":{"task_id":"prediction-1"}}' };
      }
      assert.equal(args.url, connection.url + "/predictions/prediction-1");
      return { status: 200, body: JSON.stringify({ code: 0, data: { task_status: result, output: [{ type: "video", video: "https://cdn.test/result" }] } }) };
    });
    await submitVideoJob("compat", base, connection, native);
    const accepted = videoJobAt(useVideoJobs.getState().jobs, "compat", base.id)!;
    assert.equal(accepted.api, "predictions");
    assert.equal(accepted.taskId, "prediction-1");
    stored.set("compat-restart", new Map(stored.get("compat")));
    await restoreVideoJobs("compat-restart");
    assert(await advanceVideoJob("compat-restart", base.id, connection));
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-restart", base.id)?.phase, "done");
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2);
    assert(!JSON.stringify(stored.get("compat-restart")?.get(base.id)).includes("cdn.test"));
    result = "processing";
    await advanceVideoJob("compat", base.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat", base.id)?.phase, "running");
    const legacy = { ...base, id: "legacy", phase: "unknown" as const, detail: "提交状态待确认，请先在服务方核对。\nError: 响应缺少任务 ID" };
    stored.set("compat-legacy", new Map([[legacy.id, legacy]]));
    await restoreVideoJobs("compat-legacy");
    await advanceVideoJob("compat-legacy", legacy.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-legacy", legacy.id)?.phase, "failed");
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2);
  } finally { clearMocks(); globalThis.window = oldWindow; }
});

test("业务拒绝和响应丢失均不触发另一个生成接口", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const job: VideoJob = { id: "declined", threadId: "thread", model: connection.modelId, owner: "local", baseUrl: connection.url,
    dir: "/cache/output", file: "video-declined.mp4", phase: "submitting", detail: "" };
  let posts = 0;
  let body = '{"code":500,"msg":"insufficient quota","data":{}}';
  try {
    mockIPC((cmd) => {
      if (cmd === "video_jobs") return [];
      if (cmd === "video_save_job") return;
      assert.equal(cmd, "model_fetch"); posts++;
      return { status: 200, body };
    });
    const request = videoRequest(prompt, [], connection.modelId).body;
    await submitVideoJob("compat-declined", job, connection, request);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-declined", job.id)?.phase, "failed");
    body = '{"code":0,"data":{}}';
    await submitVideoJob("compat-unknown", job, connection, request);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-unknown", job.id)?.phase, "unknown");
    assert.equal(posts, 2);
  } finally { clearMocks(); globalThis.window = oldWindow; }
});

test("模拟网关验证去重、重启恢复、下载重试、取消确认和提交结果未知", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const rows = new Map<string, Map<string, VideoJob>>();
  const calls: string[] = [];
  let status = "running";
  let downloads = 0;
  let losePost = false;
  const base: VideoJob = { id: "msg-1", threadId: "a", model: connection.modelId, owner: "local", baseUrl: connection.url,
    dir: "/cache/outputs/day", file: "video-msg-1.mp4", phase: "submitting", detail: "" };
  const job = (scope: string, id = base.id) => videoJobAt(useVideoJobs.getState().jobs, scope, id)!;
  try {
    mockIPC(async (cmd, raw) => {
      const a = raw as Record<string, string>;
      const records = rows.get(a.cacheDir) ?? new Map<string, VideoJob>();
      if (cmd === "video_jobs") return [...records.values()].map((r) => JSON.stringify(r));
      if (cmd === "video_save_job") {
        assert(!(raw as { create: boolean }).create || !records.has(a.id));
        records.set(a.id, JSON.parse(a.payload));
        rows.set(a.cacheDir, records);
        return;
      }
      if (cmd === "video_download") {
        assert.equal(a.url, "https://cdn.test/result");
        assert(!("key" in a));
        if (++downloads === 1) throw new Error("模拟下载中断");
        return;
      }
      assert.equal(cmd, "model_fetch");
      calls.push(a.method);
      if (a.method === "POST") {
        assert.equal(a.url, connection.url + "/contents/generations/tasks");
        if (losePost) throw new Error("connection lost");
        return { status: 200, body: '{"id":"task-1"}' };
      }
      assert.equal(a.url, connection.url + "/contents/generations/tasks/task-1");
      if (a.method === "DELETE") status = "cancelled";
      return { status: 200, body: JSON.stringify({ status, content: { video_url: "https://cdn.test/result" } }) };
    });
    await submitVideoJob("first", base, connection, videoRequest(prompt, [], connection.modelId).body);
    assert.equal(job("first").taskId, "task-1");
    await assert.rejects(submitVideoJob("first", base, connection, {}), /已处理/);
    // A fresh scope with a copy of the database starts with no in-memory jobs.
    rows.set("restart", new Map(rows.get("first")));
    await restoreVideoJobs("restart");
    await advanceVideoJob("restart", base.id, { ...connection, url: "https://other.test" });
    assert.deepEqual(calls, ["POST"]);
    await advanceVideoJob("restart", base.id, connection);
    assert.equal(job("restart").phase, "running");
    status = "succeeded";
    await advanceVideoJob("restart", base.id, connection);
    assert.equal(job("restart").phase, "paused");
    assert(await advanceVideoJob("restart", base.id, connection, "resume"));
    assert.equal(job("restart").phase, "done");
    assert.deepEqual(calls, ["POST", "GET", "GET", "GET"]);
    assert(!JSON.stringify(rows.get("restart")!.get(base.id)).includes("cdn.test"));
    status = "queued";
    await advanceVideoJob("first", base.id, connection, "cancel");
    assert.equal(job("first").phase, "cancelled");
    assert.deepEqual(calls.slice(-3), ["GET", "DELETE", "GET"]);
    losePost = true;
    await submitVideoJob("first", { ...base, id: "unknown" }, connection, videoRequest(prompt, [image], connection.modelId).body);
    assert.equal(job("first", "unknown").phase, "unknown");
    await assert.rejects(submitVideoJob("first", { ...base, id: "unknown" }, connection, {}));
    rows.set("crash", new Map([[base.id, base]]));
    await restoreVideoJobs("crash");
    assert.equal(job("crash").phase, "unknown");
    assert.equal(calls.filter((c) => c === "POST").length, 2);
  } finally {
    clearMocks();
    globalThis.window = oldWindow;
  }
});
