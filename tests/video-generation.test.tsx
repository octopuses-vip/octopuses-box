import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { readVideoStatus, videoRequest, videoTasksUrl, videoTaskId, VideoApiError, type VideoJob } from "../src/video/protocol";
import { advanceVideoJob, jobsForScope, restoreVideoJobs, submitVideoJob, useVideoJobs, videoJobAt, waitForVideoJob } from "../src/video/jobs";
import { toUserContent } from "../src/model/attachments";
import { artifactKind } from "../src/app/desktop/artifacts";
import { rightPanelTabs } from "../src/app/state/artifacts";
import { buildHistory, hasProducedArtifact } from "../src/hooks/useAgentRunShared";
import { useAgentRun } from "../src/hooks/useAgentRun";
import { useAppStore } from "../src/app/state";
import type { Message, MessageAttachment } from "../src/app/types";

const image: MessageAttachment = { id: "ref", name: "ocean.png", kind: "image", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,YWJj", text: null };
const prompt = JSON.stringify({ prompt: "海浪向前涌动", size: "1280x720", seconds: "4" });
const connection = { url: "https://video.test/v1", key: "mock", modelId: "ep-video" };

const copyrightFailure = {
  type: "video.generation.failed",
  data: {
    id: "gen-vid-example", status: "failed", generation_id: "gen-vid-example",
    error: "The request failed because the output video may be related to copyright restrictions. Request id: trace-copyright",
  },
};
const wrappedVideoFailure = ["message", "message", "msg"].reduce(
  (message, field) => JSON.stringify({ code: "500", [field]: message }),
  JSON.stringify(copyrightFailure),
);
const copyrightDetail = "服务商拒绝生成，输出视频可能涉及版权限制。\n请求 ID trace-copyright";

test("文字与首帧请求共用任务协议，纯文本聊天仅传递附件引用", () => {
  const text = videoRequest(prompt, [], connection.modelId);
  assert.deepEqual(text.body, { model: connection.modelId, prompt: "海浪向前涌动", seconds: "4", size: "1280x720" });
  const ref = videoRequest(prompt, [image], connection.modelId);
  assert.equal(ref.referenceId, image.id);
  assert.deepEqual(ref.body.input_reference, { image_url: image.dataUrl });
  assert.equal(ref.body.seconds, "4");
  assert.deepEqual(videoRequest(JSON.stringify({ prompt: "海浪向前涌动", duration: 4, ratio: "16:9" }), [], connection.modelId).body, text.body);
  assert.deepEqual(videoRequest('{"prompt":"x","seconds":"7","size":"832x480"}', [], "model").body, {
    model: "model", prompt: "x", seconds: "7", size: "832x480",
  });
  assert.throws(() => videoRequest('{"prompt":"x","seconds":0}', [], "model"), /seconds/);
  assert.throws(() => videoRequest('{"prompt":"x","seconds":"4.5"}', [], "model"), /seconds/);
  assert.throws(() => videoRequest('{"prompt":"x","size":"1:1"}', [], "model"), /size/);
  assert.throws(() => videoRequest('{"prompt":"x","ratio":"1:1"}', [], "model"), /size/);
  assert.equal(videoTasksUrl(connection.url), connection.url + "/videos");
  assert.deepEqual(readVideoStatus('{"id":"video_1","status":"completed"}', "openai"), { phase: "downloading", detail: "" });
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

test("读取 data/request_id 响应中的任务状态，同时保留网关失败信息", () => {
  assert.equal(videoTaskId('{"data":{"task_id":"prediction-1"},"request_id":"trace-1"}'), "prediction-1");
  assert.throws(() => videoTaskId('{"data":{},"request_id":"trace-1"}'), /缺少任务 ID/);
  assert.deepEqual(readVideoStatus('{"data":{"status":" running "},"request_id":"trace-1"}', "predictions"), {
    phase: "running", detail: "",
  });
  assert.deepEqual(readVideoStatus('{"data":{"task_status":"succeeded","content":{"video_url":"https://cdn.test/result"}},"request_id":"trace-1"}'), {
    phase: "downloading", detail: "", download: "https://cdn.test/result",
  });
  assert.deepEqual(readVideoStatus('{"data":{"status":"failed","error":{"message":"任务被拒绝"}},"request_id":"trace-1"}', "predictions"), {
    phase: "failed", detail: "任务被拒绝",
  });
  assert.throws(() => readVideoStatus('{"data":{"error":{"message":"access denied"}},"request_id":"trace-1"}', "predictions", 403), /access denied/);
  assert.throws(() => readVideoStatus('{"data":{"task_id":"prediction-1"},"request_id":"trace-1"}', "predictions"), /任务数据字段 task_id/);
});

test("网关 500 中的多层视频失败事件给出版权错误，普通网关故障仍可恢复", () => {
  const expected = { phase: "failed", detail: copyrightDetail };
  assert.deepEqual(readVideoStatus(wrappedVideoFailure, "predictions", 500), expected);
  assert.deepEqual(readVideoStatus(wrappedVideoFailure, "predictions", 200), expected);
  assert.deepEqual(readVideoStatus(JSON.stringify(copyrightFailure), "predictions", 500), expected);
  assert.throws(() => readVideoStatus('{"code":"500","message":"upstream timed out"}', "predictions", 500),
    (error) => error instanceof VideoApiError && !error.taskFailed && error.message === "upstream timed out");
  assert.throws(() => videoTaskId(wrappedVideoFailure, 500),
    (error) => error instanceof VideoApiError && error.rejected && !error.routeMissing && error.message === copyrightDetail);
});

test("400 detail、422 验证详情和纯文本错误展示具体原因，并省略验证输入原文", () => {
  assert.throws(() => videoTaskId('{"detail":"This model only supports 480p"}', 400),
    (error) => error instanceof VideoApiError && error.rejected && error.message === "This model only supports 480p");
  const body = JSON.stringify({ detail: [{ loc: ["body", "size"], msg: "Unsupported resolution", input: "private-input" }] });
  assert.throws(() => videoTaskId(body, 422),
    (error) => error instanceof VideoApiError && error.message === "body.size：Unsupported resolution" && !error.message.includes("private-input"));
  assert.throws(() => videoTaskId("Unsupported content type", 400), /HTTP 400.*Unsupported content type/);
});

test("旧统一接口任务重启后使用原协议，查询与下载失败处理保持兼容", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const base: VideoJob = { id: "compat-turn", threadId: "compat-thread", owner: "local", model: connection.modelId,
    baseUrl: connection.url, dir: "/cache/output", file: "video-compat.mp4", phase: "submitting", detail: "" };
  const stored = new Map<string, Map<string, VideoJob>>();
  const calls: string[] = [];
  let result = "success";

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
        assert.fail("旧任务恢复不能重新提交");
      }
      assert.equal(args.url, connection.url + "/predictions/prediction-1");
      if (result === "failed") return { status: 500, body: wrappedVideoFailure };
      if (result === "query-failed") return { status: 500, body: '{"message":"upstream timed out"}' };
      const data = result === "success"
        ? { status: "succeeded", output: [{ type: "video", video: "https://cdn.test/result" }] }
        : { task_status: result };
      return { status: 200, body: JSON.stringify({ request_id: "trace-1", data }) };
    });
    stored.set("compat", new Map([[base.id, { ...base, api: "predictions", taskId: "prediction-1", phase: "queued" }]]));
    await restoreVideoJobs("compat");
    const accepted = videoJobAt(useVideoJobs.getState().jobs, "compat", base.id)!;
    assert.equal(accepted.api, "predictions");
    assert.equal(accepted.taskId, "prediction-1");
    stored.set("compat-restart", new Map([[base.id, {
      ...accepted, phase: "paused", detail: "视频服务响应缺少任务状态字段（返回字段 data、request_id）。",
    }]]));
    await restoreVideoJobs("compat-restart");
    const queryStart = calls.length;
    assert(await advanceVideoJob("compat-restart", base.id, connection, "resume"));
    assert.deepEqual(calls.slice(queryStart), [`GET ${connection.url}/predictions/prediction-1`]);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-restart", base.id)?.phase, "done");
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0);
    assert(!JSON.stringify(stored.get("compat-restart")?.get(base.id)).includes("cdn.test"));
    result = "processing";
    await advanceVideoJob("compat", base.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat", base.id)?.phase, "running");
    result = "query-failed";
    await advanceVideoJob("compat", base.id, connection);
    assert.equal(stored.get("compat")?.get(base.id)?.phase, "retrying");
    result = "failed";
    await advanceVideoJob("compat", base.id, connection, "resume");
    assert.equal(stored.get("compat")?.get(base.id)?.phase, "failed");
    assert.equal(stored.get("compat")?.get(base.id)?.detail, copyrightDetail);
    const afterFailure = calls.length;
    await advanceVideoJob("compat", base.id, connection, "resume");
    assert.equal(calls.length, afterFailure);
    const legacy = { ...base, id: "legacy", phase: "unknown" as const, detail: "提交状态待确认，请先在服务方核对。\nError: 响应缺少任务 ID" };
    stored.set("compat-legacy", new Map([[legacy.id, legacy]]));
    await restoreVideoJobs("compat-legacy");
    await advanceVideoJob("compat-legacy", legacy.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-legacy", legacy.id)?.phase, "failed");
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0);
  } finally { clearMocks(); globalThis.window = oldWindow; }
});

test("业务拒绝和响应丢失均不触发另一个生成接口", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const job: VideoJob = { id: "declined", threadId: "thread", model: connection.modelId, owner: "local", baseUrl: connection.url,
    dir: "/cache/output", file: "video-declined.mp4", phase: "submitting", detail: "" };
  let posts = 0;
  let body = '{"code":500,"msg":"insufficient quota","data":{}}';
  let status = 200;
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "video_jobs") return [];
      if (cmd === "video_save_job") return;
      assert.equal(cmd, "model_fetch"); posts++;
      const args = raw as Record<string, string>;
      assert.equal(args.method, "POST");
      assert.equal(args.url, connection.url + "/videos");
      return { status, body };
    });
    const request = videoRequest(prompt, [], connection.modelId).body;
    await submitVideoJob("compat-declined", job, connection, request);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-declined", job.id)?.phase, "failed");
    body = '{"code":0,"data":{}}';
    await submitVideoJob("compat-unknown", job, connection, request);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "compat-unknown", job.id)?.phase, "unknown");
    status = 404;
    body = '{"error":{"message":"No static resource v1/videos"}}';
    await submitVideoJob("openai-missing-route", job, connection, request);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "openai-missing-route", job.id)?.phase, "failed");
    assert.equal(posts, 3);
  } finally { clearMocks(); globalThis.window = oldWindow; }
});

test("未标注协议的旧 Seedance 任务按旧路径查询和取消", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const job: VideoJob = { id: "old-seedance", threadId: "thread", model: connection.modelId, owner: "local", baseUrl: connection.url,
    dir: "/cache/output", file: "video-legacy.mp4", taskId: "old-task", phase: "queued", detail: "" };
  const calls: string[] = [];
  let cancelled = false;
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "video_jobs") return [JSON.stringify(job)];
      if (cmd === "video_save_job") return;
      assert.equal(cmd, "model_fetch");
      const args = raw as Record<string, string>;
      calls.push(args.method);
      assert.equal(args.url, connection.url + "/contents/generations/tasks/old-task");
      if (args.method === "DELETE") { cancelled = true; return { status: 204, body: "" }; }
      return { status: 200, body: JSON.stringify({ status: cancelled ? "cancelled" : "queued" }) };
    });
    await restoreVideoJobs("old-seedance");
    await advanceVideoJob("old-seedance", job.id, connection, "cancel");
    assert.deepEqual(calls, ["GET", "DELETE", "GET"]);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "old-seedance", job.id)?.phase, "cancelled");
  } finally { clearMocks(); globalThis.window = oldWindow; }
});

test("模拟网关验证OpenAI 创建、去重、重启恢复、鉴权下载重试和提交结果未知", async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const rows = new Map<string, Map<string, VideoJob>>();
  const calls: string[] = [];
  let status = "in_progress";
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
        assert.equal(a.url, connection.url + "/videos/task-1/content");
        assert.equal(a.key, connection.key);
        if (++downloads === 1) throw new Error("模拟下载中断");
        return;
      }
      assert.equal(cmd, "model_fetch");
      calls.push(a.method);
      if (a.method === "POST") {
        assert.equal(a.url, connection.url + "/videos");
        assert.deepEqual(JSON.parse(a.body), videoRequest(prompt, losePost ? [image] : [], connection.modelId).body);
        if (losePost) throw new Error("connection lost");
        return { status: 200, body: '{"id":"task-1"}' };
      }
      assert.equal(a.url, connection.url + "/videos/task-1");
      if (a.method === "DELETE") status = "cancelled";
      return { status: 200, body: JSON.stringify({ status, content: { video_url: "https://cdn.test/result" } }) };
    });
    await submitVideoJob("first", base, connection, videoRequest(prompt, [], connection.modelId).body);
    assert.equal(job("first").taskId, "task-1");
    await assert.rejects(submitVideoJob("first", base, connection, videoRequest(prompt, [], connection.modelId).body), /已处理/);
    // A fresh scope with a copy of the database starts with no in-memory jobs.
    rows.set("restart", new Map(rows.get("first")));
    await restoreVideoJobs("restart");
    await advanceVideoJob("restart", base.id, { ...connection, url: "https://other.test" });
    assert.deepEqual(calls, ["POST"]);
    await advanceVideoJob("restart", base.id, connection);
    assert.equal(job("restart").phase, "running");
    status = "completed";
    await advanceVideoJob("restart", base.id, connection);
    assert.equal(job("restart").phase, "retrying");
    assert(await advanceVideoJob("restart", base.id, connection, "resume"));
    assert.equal(job("restart").phase, "done");
    assert.deepEqual(calls, ["POST", "GET", "GET", "GET"]);
    assert(!JSON.stringify(rows.get("restart")!.get(base.id)).includes("cdn.test"));
    status = "queued";
    await assert.rejects(advanceVideoJob("first", base.id, connection, "cancel"), /不支持取消/);
    assert.equal(job("first").phase, "queued");
    assert(!calls.includes("DELETE"));
    losePost = true;
    await submitVideoJob("first", { ...base, id: "unknown" }, connection, videoRequest(prompt, [image], connection.modelId).body);
    assert.equal(job("first", "unknown").phase, "unknown");
    await assert.rejects(submitVideoJob("first", { ...base, id: "unknown" }, connection, videoRequest(prompt, [], connection.modelId).body));
    rows.set("crash", new Map([[base.id, base]]));
    await restoreVideoJobs("crash");
    assert.equal(job("crash").phase, "unknown");
    assert.equal(calls.filter((c) => c === "POST").length, 2);
  } finally {
    clearMocks();
    globalThis.window = oldWindow;
  }
});

test("/video 这一轮等到视频下载完成，自动重连时仍在运行，停止只解除等待", { timeout: 5000 }, async () => {
  const scope = "/test/video-turn";
  const before = useAppStore.getState();
  const oldWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  useAppStore.setState({ cachePath: scope, sessionsRestored: true, sessionsRestoreError: null, modelSource: "local",
    modelConfig: null, videoModelCode: connection.modelId,
    remoteModels: [{ id: 1, code: connection.modelId, baseUrl: connection.url, apiKey: connection.key, name: "视频", description: "", provider: "" }],
  });
  let agent!: ReturnType<typeof useAgentRun>;
  function Probe() { agent = useAgentRun(); return null; }
  renderToStaticMarkup(createElement(Probe));
  const threadId = useAppStore.getState().createThread("视频会话", "", true);
  const journal = new Map<string, string>();
  let posts = 0;
  let phase = "running";
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((release) => { releaseDownload = release; });
  const latestJob = () => jobsForScope(scope).find((job) => job.taskId === `task-${posts}`);
  const waitForJob = async (number: number) => {
    for (let tries = 0; tries < 100; tries += 1) {
      const job = jobsForScope(scope).find((candidate) => candidate.taskId === `task-${number}`);
      if (job) return job;
      await sleep(5);
    }
    throw new Error(`找不到任务 task-${number}`);
  };
  try {
    mockIPC(async (cmd, raw) => {
      const args = raw as Record<string, string>;
      if (cmd === "cache_read_optional") return journal.get(args.relative) ?? null;
      if (cmd === "cache_write_atomic") { journal.set(args.relative, args.contents); return; }
      if (["cache_write", "cache_append", "artifact_prepare_dir", "session_db_save", "video_save_job"].includes(cmd)) return;
      if (cmd === "video_jobs") return [];
      if (cmd === "video_download") return downloadGate;
      assert.equal(cmd, "model_fetch");
      if (args.method === "POST") return { status: 200, body: JSON.stringify({ id: `task-${++posts}`, seconds: "7", size: "832x480" }) };
      assert.equal(args.method, "GET");
      if (phase === "paused") throw new Error("查询暂时中断");
      return { status: 200, body: JSON.stringify({ status: phase, content: { video_url: "https://cdn.test/result" } }) };
    });
    const execution = () => useAppStore.getState().messages[threadId].at(-1)?.items.find((item) => item.type === "execution_details")?.details;
    const run = agent.run(threadId, "/video 海浪", []);
    const job = await waitForJob(1);
    assert.equal(execution()?.outcome, "running");
    await advanceVideoJob(scope, job.id, connection);
    assert.equal(latestJob()?.phase, "running");
    assert.equal(execution()?.outcome, "running");
    phase = "paused";
    await advanceVideoJob(scope, job.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, scope, job.id)?.phase, "retrying");
    assert.equal(execution()?.outcome, "running");
    phase = "completed";
    const resume = advanceVideoJob(scope, job.id, connection, "resume");
    await sleep(0);
    assert.equal(latestJob()?.phase, "downloading");
    assert.equal(execution()?.tools[0]?.status, "running");
    releaseDownload();
    assert(await resume);
    assert.equal(await run, "success");
    assert.equal(execution()?.outcome, "success");
    assert.equal(execution()?.tools[0]?.reason, "video_saved");
    const result = useAppStore.getState().messages[threadId].at(-1)?.items.find((item) => item.type === "tool_call");
    assert.match(result?.result ?? "", /已生成 video-.*\.mp4/);
    assert.match(result?.result ?? "", /实际规格 7 秒 · 832x480/);

    phase = "running";
    const stopped = agent.run(threadId, "/video 另一段海浪", []);
    const original = await waitForJob(2);
    assert.notEqual(original.id, job.id);
    agent.stop(threadId);
    assert.equal(await stopped, "aborted");
    assert.equal(latestJob()?.phase, "queued");
    assert.equal(await waitForVideoJob(scope, original.id, new AbortController().signal, Date.now() - 1), null);
    assert.equal(latestJob()?.taskId, "task-2");

    const failed = agent.run(threadId, "/video 第三段海浪", []);
    const rejected = await waitForJob(3);
    phase = "failed";
    await advanceVideoJob(scope, rejected.id, connection);
    assert.equal(await failed, "failed");
    assert.equal(execution()?.tools[0]?.status, "error");
    assert.equal(posts, 3);
  } finally {
    releaseDownload();
    agent.stop(threadId);
    clearMocks();
    globalThis.window = oldWindow;
    useAppStore.setState(before);
  }
});
