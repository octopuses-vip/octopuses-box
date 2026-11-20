import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { advanceVideoJob, jobsForScope, restoreVideoJobs, submitVideoJob, useVideoJobs, videoJobAt, waitForVideoJob } from "../src/video/jobs";
import type { VideoJob } from "../src/video/protocol";

const connection = { url: "https://video.test/v1", key: "test-key", modelId: "test-model" };
const base: VideoJob = { id: "turn", threadId: "thread", owner: "local", model: connection.modelId,
  baseUrl: connection.url, dir: "/cache/output", file: "video-turn.mp4", phase: "submitting", detail: "" };

test("旧版本因一次网络错误暂停的任务在升级后自动查询原 ID", async () => {
  const before = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  const scope = "old-transport-pause";
  let gets = 0;
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "video_jobs") return [JSON.stringify({ ...base, api: "openai", phase: "paused", taskId: "original",
        detail: "请求模型服务失败：error sending request for url (https://video.test/v1/videos/original)" })];
      if (cmd === "video_save_job") return;
      assert.equal(cmd, "model_fetch");
      const args = raw as { method: string; url: string };
      assert.equal(args.method, "GET");
      assert.equal(args.url, connection.url + "/videos/original");
      gets++;
      return { status: 200, body: '{"status":"in_progress"}' };
    });
    await restoreVideoJobs(scope);
    assert.equal(jobsForScope(scope).length, 1);
    await advanceVideoJob(scope, base.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, scope, base.id)?.phase, "running");
    assert.equal(gets, 1);
  } finally { clearMocks(); globalThis.window = before; }
});

test("短暂断网、503 与 429 按原任务退避重连，重启保留等待时间，恢复后完成下载", async (t) => {
  const before = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const rows = new Map<string, VideoJob>();
  const calls: string[] = [];
  let response = "offline";
  let downloads = 0;
  try {
    mockIPC((cmd, raw) => {
      const args = raw as Record<string, unknown>;
      if (cmd === "video_jobs") return rows.has(String(args.cacheDir)) ? [JSON.stringify(rows.get(String(args.cacheDir)))] : [];
      if (cmd === "video_save_job") { rows.set(String(args.cacheDir), JSON.parse(String(args.payload))); return; }
      if (cmd === "video_download") {
        downloads++;
        assert.equal(args.url, connection.url + "/videos/original/content");
        assert.equal(args.key, connection.key);
        return;
      }
      assert.equal(cmd, "model_fetch");
      calls.push(String(args.method));
      if (args.method === "POST") {
        assert.equal(args.timeoutSecs, null);
        return { status: 200, body: '{"id":"original"}' };
      }
      assert.equal(args.method, "GET");
      assert.equal(args.url, connection.url + "/videos/original");
      assert.equal(args.timeoutSecs, 30);
      if (response === "offline") throw new Error("connection refused");
      if (response !== "completed") return { status: Number(response), body: '{"detail":"temporarily unavailable"}' };
      return { status: 200, body: '{"status":"completed","seconds":"5","size":"832x480"}' };
    });
    await submitVideoJob("reconnect", base, connection, { model: connection.modelId, prompt: "sunrise" });
    await advanceVideoJob("reconnect", base.id, connection);
    let job = videoJobAt(useVideoJobs.getState().jobs, "reconnect", base.id)!;
    assert.equal(job.phase, "retrying");
    assert.equal(job.retryAt, now + 5000);
    assert.equal(jobsForScope("reconnect").length, 0);
    await advanceVideoJob("reconnect", base.id, connection);
    assert.deepEqual(calls, ["POST", "GET"]);

    rows.set("reconnect-restart", rows.get("reconnect")!);
    await restoreVideoJobs("reconnect-restart");
    const waiting = waitForVideoJob("reconnect-restart", base.id, new AbortController().signal);
    for (const [status, delay] of [["503", 10000], ["429", 20000]] as const) {
      now = job.retryAt!;
      assert.equal(jobsForScope("reconnect-restart").length, 1);
      response = status;
      await advanceVideoJob("reconnect-restart", base.id, connection);
      job = videoJobAt(useVideoJobs.getState().jobs, "reconnect-restart", base.id)!;
      assert.equal(job.retryAt, now + delay);
    }
    now = job.retryAt!;
    response = "completed";
    assert(await advanceVideoJob("reconnect-restart", base.id, connection));
    const finished = await waiting;
    assert.equal(finished?.phase, "done");
    assert.equal(finished?.seconds, "5");
    assert.equal(finished?.size, "832x480");
    assert.equal(finished?.retryAt, undefined);
    assert.equal(finished?.retryCount, undefined);
    assert.equal(downloads, 1);
    assert.equal(calls.filter((method) => method === "POST").length, 1);
    assert(!JSON.stringify([...rows.values()]).includes(connection.key));
  } finally { clearMocks(); globalThis.window = before; }
});

test("连续查询失败只重试三次，结束本轮等待，手动继续仍使用原任务", async (t) => {
  const before = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  let now = 2_000_000;
  t.mock.method(Date, "now", () => now);
  let gets = 0;
  let online = false;
  const scope = "retry-limit";
  const current = () => videoJobAt(useVideoJobs.getState().jobs, scope, base.id)!;
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "video_jobs") return [JSON.stringify({ ...base, api: "openai", phase: "running", taskId: "original" })];
      if (["video_save_job", "video_download"].includes(cmd)) return;
      assert.equal(cmd, "model_fetch");
      assert.equal((raw as { method: string }).method, "GET");
      gets++;
      if (!online) throw new Error("模型服务请求超时");
      return { status: 200, body: '{"status":"completed"}' };
    });
    await restoreVideoJobs(scope);
    const waiting = waitForVideoJob(scope, base.id, new AbortController().signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      await advanceVideoJob(scope, base.id, connection);
      if (attempt < 3) {
        assert.equal(current().phase, "retrying");
        now = current().retryAt!;
      }
    }
    assert.equal((await waiting)?.phase, "paused");
    assert.equal(current().taskId, "original");
    assert.match(current().detail, /自动重连未恢复/);
    assert.equal(jobsForScope(scope).length, 0);
    await advanceVideoJob(scope, base.id, connection);
    assert.equal(gets, 4);
    online = true;
    assert(await advanceVideoJob(scope, base.id, connection, "resume"));
    assert.equal(current().phase, "done");
    assert.equal(gets, 5);
  } finally { clearMocks(); globalThis.window = before; }
});

test("鉴权、任务不存在与无效状态不自动循环，服务端明确失败直接结束", async () => {
  const before = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  let response = { status: 401, body: '{"detail":"authentication required"}' };
  let gets = 0;
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "video_jobs") return [JSON.stringify({ ...base, api: "openai", phase: "running", taskId: "original" })];
      if (cmd === "video_save_job") return;
      assert.equal(cmd, "model_fetch");
      assert.equal((raw as { method: string }).method, "GET");
      gets++;
      return response;
    });
    for (const status of [401, 403, 404, 200]) {
      const scope = `permanent-${status}`;
      response = { status, body: '{"detail":"authentication required"}' };
      await restoreVideoJobs(scope);
      const waiting = waitForVideoJob(scope, base.id, new AbortController().signal);
      await advanceVideoJob(scope, base.id, connection);
      assert.equal((await waiting)?.phase, "paused");
      assert.equal(jobsForScope(scope).length, 0);
    }
    response = { status: 200, body: '{"status":"failed","error":{"message":"inference failed"}}' };
    await restoreVideoJobs("provider-failed");
    await advanceVideoJob("provider-failed", base.id, connection);
    assert.equal(videoJobAt(useVideoJobs.getState().jobs, "provider-failed", base.id)?.phase, "failed");
    assert.equal(gets, 5);
  } finally { clearMocks(); globalThis.window = before; }
});

test("已完成但内容 404 时重试下载并明确文件缺失，不能标记成功或无限等待", async (t) => {
  const before = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  let now = 3_000_000;
  t.mock.method(Date, "now", () => now);
  let downloads = 0;
  const scope = "missing-content";
  try {
    mockIPC((cmd, raw) => {
      if (cmd === "video_jobs") return [JSON.stringify({ ...base, api: "openai", phase: "running", taskId: "original" })];
      if (cmd === "video_save_job") return;
      if (cmd === "video_download") { downloads++; throw new Error("视频下载失败（HTTP 404 Not Found）"); }
      assert.equal(cmd, "model_fetch");
      assert.equal((raw as { method: string }).method, "GET");
      return { status: 200, body: '{"status":"completed"}' };
    });
    await restoreVideoJobs(scope);
    const waiting = waitForVideoJob(scope, base.id, new AbortController().signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      assert(!await advanceVideoJob(scope, base.id, connection));
      const job = videoJobAt(useVideoJobs.getState().jobs, scope, base.id)!;
      assert.notEqual(job.phase, "done");
      now = job.retryAt ?? now;
    }
    const result = await waiting;
    assert.equal(result?.phase, "paused");
    assert.match(result!.detail, /找不到视频文件（HTTP 404）/);
    assert.equal(downloads, 4);
  } finally { clearMocks(); globalThis.window = before; }
});
