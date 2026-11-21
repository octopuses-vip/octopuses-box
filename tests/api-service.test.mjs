import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configureCacheDirectory } from '../api-service/cache-location.mjs';
import { createApiService } from '../api-service/server.mjs';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const mp4 = Buffer.from('00000018667479706d70343200000000', 'hex');
const recording = Buffer.from([73, 68, 51, 0, 255, 128, 65]);
const managementToken = 'test-management-client-token-fixture';
const managementUsername = 'fixture-model-reader';
const managementPassword = ' fixture password with spaces ';

function latch() {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  return { waiting, release };
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function requestBytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function setup(t, { holdChat = false, holdVideo = false, concurrency = 2, skillChoice } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'octopuses-api-test-'));
  const chats = [];
  const skillRequests = [];
  const videoRequests = [];
  const uploads = [];
  const chatStarted = latch();
  const proceed = latch();
  const videoStarted = latch();
  const videoCancelled = latch();
  const catalogRequests = [];
  let authorized = true;
  let catalogAvailable = true;
  let acceptsLogin = true;
  let loginCount = 0;
  let minimumTokenVersion = 1;
  const upstreamErrors = [];
  let backendBase, service;

  const backend = http.createServer(async (req, res) => {
    try {
      const token = req.headers.authorization;
      if (req.url.startsWith('/api/client/')) {
        catalogRequests.push(req.url);
        if (req.url === '/api/client/login') {
          assert.equal(req.method, 'POST');
          assert.equal(token, undefined);
          assert.deepEqual(JSON.parse(await requestBytes(req)), { username: managementUsername, password: managementPassword });
          if (!acceptsLogin) return json(res, { code: 401, data: null }, 401);
          return json(res, { code: 0, data: { token: `${managementToken}-${++loginCount}` } });
        }
        assert.equal(req.url, '/api/client/models');
        assert.equal(req.method, 'GET');
        const version = new RegExp(`^Bearer ${managementToken}-(\\d+)$`).exec(token)?.[1];
        assert(version && Number(version) <= loginCount, 'catalog uses the token issued by login');
        if (Number(version) < minimumTokenVersion) return json(res, { code: 401, data: null }, 401);
        if (!catalogAvailable) return json(res, { code: 403, data: null }, 403);
        const models = [{ code: 'chat-1', name: 'Chat', supportsChat: true },
          { code: 'qwen3-asr', name: 'ASR', supportsChat: false },
          { code: 'image-1', name: 'Image' }, { code: 'video-1', name: 'Video' }];
        const allowed = authorized ? models : [];
        return json(res, { code: 0, data: allowed.map((model) => ({
          ...model, baseUrl: backendBase + '/v1', apiKey: 'provider-test-key',
        })) });
      }
      assert.equal(token, 'Bearer provider-test-key');
      if (req.url === '/v1/chat/completions') {
        const input = JSON.parse(await requestBytes(req));
        if (input.stream === false && skillChoice) {
          skillRequests.push(input);
          const task = JSON.parse(input.messages.at(-1).content).task;
          return json(res, { choices: [{ message: { content: skillChoice(task) } }] });
        }
        chats.push(input);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        chatStarted.release();
        if (holdChat && chats.length === 1) await proceed.waiting;
        const data = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n');
        const split = data.indexOf(Buffer.from('你')) + 1;
        res.write(data.subarray(0, split));
        await delay(3);
        res.write(data.subarray(split));
        res.end('data: [DONE]\r\n\r\n');
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        const form = await new Response(await requestBytes(req), {
          headers: { 'Content-Type': req.headers['content-type'] },
        }).formData();
        const original = form.get('file');
        uploads.push({ filename: original.name, model: form.get('model'), format: form.get('response_format'),
          bytes: Buffer.from(await original.arrayBuffer()) });
        return json(res, { text: '一段测试录音。' });
      }
      if (req.url === '/v1/images/generations') {
        assert.deepEqual(JSON.parse(await requestBytes(req)), { model: 'image-1', prompt: '海边', n: 1 });
        return json(res, { data: [{ b64_json: png.toString('base64') }] });
      }
      if (req.url === '/v1/videos' && req.method === 'POST') {
        videoRequests.push(JSON.parse(await requestBytes(req)));
        return json(res, { id: 'video_fixture' });
      }
      if (req.url === '/v1/videos/video_fixture') {
        if (holdVideo) {
          res.once('close', videoCancelled.release);
          videoStarted.release();
          return;
        }
        return json(res, { id: 'video_fixture', status: 'completed' });
      }
      if (req.url === '/v1/videos/video_fixture/content') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(mp4);
      }
      assert.fail(`Unexpected upstream route: ${req.url}`);
    } catch (error) {
      upstreamErrors.push(error);
      if (!res.headersSent) json(res, {}, 500);
      else res.destroy();
    }
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  backendBase = `http://127.0.0.1:${backend.address().port}`;
  t.after(async () => {
    proceed.release();
    await service?.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(upstreamErrors, []);
  });

  const config = {
    managementUrl: backendBase, managementUsername, managementPassword, directory, port: 0, concurrency, pollInterval: 10,
    cacheDirectory: join(directory, 'desktop-cache'),
    agents: [{ id: 'writer', name: '编辑', model: 'chat-1', instructions: '用简洁中文回答。' }],
  };
  service = await createApiService(config);

  function call(path, { body, method = body === undefined ? 'GET' : 'POST', token = service.token } = {}) {
    return fetch(`http://127.0.0.1:${service.address.port}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }
  async function post(path, body, status = 202) {
    const response = await call(path, { body });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json;
  }
  async function done(job, stream) {
    const events = stream ?? await call(`/v1/jobs/${job.id}/events`);
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type'), /^text\/event-stream/);
    return (await events.text()).split('\n').filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
  }
  return {
    call, post, done, directory, chats, skillRequests, uploads, videoRequests, chatStarted, proceed, videoStarted, videoCancelled,
    catalogRequests,
    revoke: () => { authorized = false; },
    disableAccount: () => { catalogAvailable = false; },
    expireManagementToken: () => { minimumTokenVersion = loginCount + 1; },
    rejectLogin: () => { acceptsLogin = false; },
    apiToken: () => service.token,
    config,
    stop: () => service.close(),
    restart: async () => { await service.close(); service = await createApiService(config); },
  };
}

test('local authentication keeps management credentials separate and preserves history after token rotation', { timeout: 12_000 }, async (t) => {
  const api = await setup(t, { holdChat: true });
  assert.deepEqual(await (await api.call('/health', { token: null })).json(), { status: 'ok' });
  assert.equal((await api.call('/v1/models', { token: null })).status, 401);
  assert.equal((await api.call('/v1/models', { token: `${managementToken}-1` })).status, 401);
  assert.equal(api.catalogRequests.length, 0, 'invalid caller tokens are rejected locally');
  const models = await (await api.call('/v1/models')).json();
  assert.equal(models.data[0].code, 'chat-1');
  assert(!JSON.stringify(models).includes('provider-test-key'));
  assert(!JSON.stringify(models).includes('baseUrl'));
  assert.deepEqual(await (await api.call('/v1/agents')).json(), {
    data: [{ id: 'writer', name: '编辑', model: 'chat-1' }],
  });
  assert.equal((await api.call('/v1/jobs', { body: { type: 'chat', model: 'qwen3-asr', prompt: 'hello' } })).status, 400);
  assert.equal((await api.call('/v1/jobs', { body: { type: 'chat', model: 'not-in-catalog', prompt: 'hello' } })).status, 403);

  const session = await api.post('/v1/sessions', { agentId: 'writer' }, 201);
  const first = await api.post('/v1/jobs', { type: 'chat', prompt: '第一轮', sessionId: session.id });
  await api.chatStarted.waiting;
  const stream = await api.call(`/v1/jobs/${first.id}/events`);
  const events = api.done(first, stream);
  assert.equal((await api.call(`/v1/sessions/${session.id}`, { token: null })).status, 401);
  assert.equal((await api.call(`/v1/jobs/${first.id}/events`, { token: managementToken })).status, 401);
  assert.equal((await api.call('/v1/jobs', { body: { type: 'chat', prompt: '并发', sessionId: session.id } })).status, 409);
  api.proceed.release();
  const firstEvents = await events;
  assert(firstEvents.some((event) => event.text === '你好'));
  assert.equal(firstEvents.at(-1).status, 'completed');

  await assert.rejects(createApiService(api.config), /locked/);
  const oldToken = api.apiToken();
  await api.restart();
  assert.equal((await api.call(`/v1/sessions/${session.id}`, { token: oldToken })).status, 401);
  const history = await (await api.call(`/v1/sessions/${session.id}`)).json();
  assert.deepEqual(history.turns, [{ jobId: first.id, prompt: '第一轮', text: '你好' }]);
  const second = await api.post('/v1/jobs', { type: 'chat', prompt: '第二轮', sessionId: session.id });
  assert.equal((await api.done(second)).at(-1).status, 'completed');
  assert.deepEqual(api.chats[1].messages, [
    { role: 'system', content: '用简洁中文回答。' },
    { role: 'user', content: '第一轮' }, { role: 'assistant', content: '你好' },
    { role: 'user', content: '第二轮' },
  ]);
  api.revoke();
  assert.equal((await api.call('/v1/jobs', { body: { type: 'chat', prompt: '第三轮', sessionId: session.id } })).status, 403);
  assert.equal(api.chats.length, 2);
  const beforeAgentList = api.catalogRequests.length;
  assert.deepEqual(await (await api.call('/v1/agents')).json(), {
    data: [{ id: 'writer', name: '编辑', model: 'chat-1' }],
  });
  assert.equal(api.catalogRequests.length, beforeAgentList, 'Agent discovery is local even when its model is unavailable');
  api.disableAccount();
  const catalogFailure = await api.call('/v1/models');
  assert.equal(catalogFailure.status, 502);
  assert.equal((await catalogFailure.json()).error.code, 'management_auth_failed');
  const before = api.catalogRequests.length;
  assert.equal((await api.call(`/v1/sessions/${session.id}`)).status, 200);
  assert.equal((await api.call(`/v1/jobs/${second.id}`)).status, 200);
  assert.equal(api.catalogRequests.length, before, 'stored results stay available without the management service');
});

test('catalog requests share login, refresh an expired token once and report a rejected login without credentials', async (t) => {
  const api = await setup(t);
  assert.deepEqual(api.catalogRequests, [], 'starting and printing a local token do not require upstream login');
  for (let generation = 1; generation <= 2; generation++) {
    const responses = await Promise.all(Array.from({ length: 4 }, () => api.call('/v1/models')));
    for (const response of responses) {
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.equal(data[0].code, 'chat-1');
    }
    assert.equal(api.catalogRequests.filter((route) => route.endsWith('/login')).length, generation);
    api.expireManagementToken();
  }
  api.rejectLogin();
  const response = await api.call('/v1/models');
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.error.code, 'management_auth_failed');
  for (const secret of [managementUsername, managementPassword, managementToken]) {
    assert(!JSON.stringify(result).includes(secret));
  }
});

test('media jobs use the managed upstream formats and publish authenticated, durable downloads', { timeout: 12_000 }, async (t) => {
  const api = await setup(t);
  const reference = { image_url: 'data:image/png;base64,' + png.toString('base64') };
  const requests = [
    [{ type: 'transcribe', model: 'qwen3-asr', filename: '录音.mp3', audioBase64: recording.toString('base64') }, Buffer.from('一段测试录音。'), 'transcript.txt'],
    [{ type: 'image', model: 'image-1', prompt: '海边' }, png, 'image.png'],
    [{ type: 'video', model: 'video-1', prompt: '日出', seconds: 8, size: '832x480', input_reference: reference }, mp4, 'video.mp4'],
  ];
  let last;
  for (const [request, bytes, name] of requests) {
    const job = await api.post('/v1/jobs', request);
    const result = (await api.done(job)).at(-1);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    const artifact = result.result.artifact;
    assert.equal(artifact.name, name);
    assert.equal(artifact.bytes, bytes.length);
    const download = await api.call(artifact.url);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await api.call(artifact.url, { token: managementToken })).status, 401);
    last = artifact.url;
  }
  assert.deepEqual(api.uploads, [{ filename: '录音.mp3', model: 'qwen3-asr', format: 'json', bytes: recording }]);
  assert.deepEqual(api.videoRequests, [{ model: 'video-1', prompt: '日出', seconds: '8', size: '832x480', input_reference: reference }]);
  const oldToken = api.apiToken();
  await api.restart();
  assert.deepEqual(Buffer.from(await (await api.call(last)).arrayBuffer()), mp4);
  const db = await readFile(join(api.directory, 'service.db'));
  for (const secret of ['provider-test-key', managementUsername, managementPassword, managementToken,
    oldToken, api.apiToken(), recording.toString('base64')]) {
    assert(!db.includes(secret));
  }
});

test('natural-language tasks select only installed Skills and apply the selected text to the streaming answer', { timeout: 12_000 }, async (t) => {
  const api = await setup(t, {
    skillChoice: (task) => {
      if (task.startsWith('整理')) return '{"skillIds":["interview-notes","../unknown","interview-notes"]}';
      if (task.startsWith('打招呼')) return '{"skillIds":[]}';
      return '选择服务的响应格式错误';
    },
  });
  const root = join(api.config.cacheDirectory, 'skills');
  const interview = join(root, 'interview-notes');
  const translate = join(root, 'translate');
  await mkdir(interview, { recursive: true });
  await mkdir(translate);
  await writeFile(join(interview, 'SKILL.md'), '---\nname: 访谈整理\ndescription: >-\n  整理访谈录音\n  和问答稿\n---\n区分说话人，保留原始数字。');
  await writeFile(join(interview, 'reference.md'), 'REFERENCE_FILE_NOT_SENT');
  await writeFile(join(translate, 'SKILL.md'), '---\nname: 翻译\ndescription: 翻译正文\n---\nTRANSLATION_INSTRUCTIONS_NOT_SELECTED');
  await api.restart();
  const session = await api.post('/v1/sessions', { agentId: 'writer' }, 201);
  const prompts = ['整理这段访谈材料', '打招呼', '测试选择异常时继续回答'];
  const results = [];
  for (const prompt of prompts) {
    const task = await api.post('/v1/jobs', { type: 'chat', sessionId: session.id, prompt });
    const completed = (await api.done(task)).at(-1);
    assert.equal(completed.status, 'completed');
    results.push(completed.result);
  }

  const firstRequest = JSON.parse(api.skillRequests[0].messages[1].content);
  assert.deepEqual(firstRequest, {
    task: prompts[0], recent: [],
    candidates: [
      { id: 'interview-notes', name: '访谈整理', description: '整理访谈录音 和问答稿' },
      { id: 'translate', name: '翻译', description: '翻译正文' },
    ],
  });
  assert(!JSON.stringify(api.skillRequests).includes('区分说话人'));
  assert.deepEqual(JSON.parse(api.skillRequests[1].messages[1].content).recent, [
    { request: prompts[0], reply: '你好' },
  ]);
  assert.deepEqual(results, [
    { text: '你好', skillIds: ['interview-notes'] },
    { text: '你好', skillIds: [] },
    { text: '你好', skillIds: [], skillSelection: 'unavailable' },
  ]);
  assert.equal(api.chats[0].messages[0].content, '用简洁中文回答。\n\n## 技能：访谈整理\n区分说话人，保留原始数字。');
  for (const request of api.chats) {
    assert.equal(request.stream, true);
    assert.equal(request.messages.filter(({ role }) => role === 'system').length, 1);
    assert(!Object.hasOwn(request, 'tools'));
  }
  assert.equal(api.chats[1].messages[0].content, '用简洁中文回答。');
  assert(!JSON.stringify(api.chats).includes('TRANSLATION_INSTRUCTIONS_NOT_SELECTED'));
  assert(!JSON.stringify(api.chats).includes('REFERENCE_FILE_NOT_SENT'));
});

test('cancel queued and running jobs and release the worker without a second video submission', { timeout: 12_000 }, async (t) => {
  const api = await setup(t, { holdVideo: true, concurrency: 1 });
  const video = await api.post('/v1/jobs', { type: 'video', model: 'video-1', prompt: '海边' });
  await api.videoStarted.waiting;
  const queued = await api.post('/v1/jobs', { type: 'chat', model: 'chat-1', prompt: '排队' });
  assert.equal((await api.post(`/v1/jobs/${queued.id}/cancel`, {}, 200)).status, 'cancelled');
  const events = api.done(video);
  const cancelled = await api.post(`/v1/jobs/${video.id}/cancel`, {}, 200);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.upstreamId, 'video_fixture');
  assert.equal((await events).at(-1).status, 'cancelled');
  await api.videoCancelled.waiting;
  assert.equal((await api.call(`/v1/jobs/${video.id}/artifact`)).status, 404);
  assert.equal(api.videoRequests.length, 1);
  assert.equal(api.chats.length, 0);
  const next = await api.post('/v1/jobs', { type: 'chat', model: 'chat-1', prompt: '继续' });
  assert.equal((await api.done(next)).at(-1).status, 'completed');
});

async function startProcess(t, directory, options = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../api-service/server.mjs', import.meta.url))], {
    cwd: directory,
    env: { ...process.env, OCTOPUSES_MANAGEMENT_URL: '', OCTOPUSES_MANAGEMENT_USERNAME: '', OCTOPUSES_MANAGEMENT_PASSWORD: '',
      OCTOPUSES_API_TOKEN: undefined, OCTOPUSES_API_PORT: '0', OCTOPUSES_API_HOST: '127.0.0.1',
      OCTOPUSES_API_DATA_DIR: directory, OCTOPUSES_API_AGENTS_FILE: '',
      OCTOPUSES_API_CACHE_DIR: join(directory, 'desktop-cache'), ...options },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopped = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopped;
  });
  const output = createInterface({ input: child.stdout });
  t.after(() => output.close());
  const lines = output[Symbol.asyncIterator]();
  const { port, token } = await Promise.race([
    (async () => {
      const ready = (await lines.next()).value;
      const secret = (await lines.next()).value;
      const port = /127\.0\.0\.1:(\d+)$/.exec(ready)?.[1];
      const token = /^接口调用令牌（Bearer） ([A-Za-z0-9._~-]{32,256})$/.exec(secret)?.[1];
      assert(port && token, 'startup prints the bound address and the API token');
      return { port, token };
    })(),
    stopped.then(() => { throw new Error('API process stopped before listening'); }),
  ]);
  return { child, stopped, port, token };
}

test('desktop-owned API starts with the selected model source and stops when its parent disconnects', { timeout: 12_000 }, async (t) => {
  const api = await setup(t);
  const cache = api.config.cacheDirectory;
  await mkdir(cache);
  await writeFile(join(cache, 'models.json'), JSON.stringify([{
    code: 'local-chat', name: '本地模型', baseUrl: api.config.managementUrl + '/v1', apiKey: 'provider-test-key',
  }]));
  const login = await fetch(api.config.managementUrl + '/api/client/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: managementUsername, password: managementPassword }),
  });
  const sessionToken = (await login.json()).data.token;
  for (const local of [true, false]) {
    const dataDirectory = join(cache, 'api-service', local ? 'local' : 'remote');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../api-service/desktop.mjs', import.meta.url))], {
      cwd: cache,
      env: { ...process.env, OCTOPUSES_API_HOST: '0.0.0.0', OCTOPUSES_API_TOKEN: 'unrelated-standalone-token' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stopped = once(child, 'exit');
    const output = createInterface({ input: child.stdout });
    try {
      const launched = once(output, 'line');
      child.stdin.write(JSON.stringify({
        cacheDirectory: cache, dataDirectory, local,
        managementUrl: local ? null : api.config.managementUrl,
        managementSessionToken: local ? null : sessionToken,
      }) + '\n');
      const [line] = await launched;
      const { error, port, token } = JSON.parse(line);
      assert.equal(error, undefined);
      assert(Number.isInteger(port) && port > 0);
      assert(typeof token === 'string' && token.length === 43);
      const url = `http://127.0.0.1:${port}`;
      const headers = { Authorization: `Bearer ${token}` };
      assert.equal((await fetch(url + '/v1/models')).status, 401);
      const models = await (await fetch(url + '/v1/models', { headers })).json();
      const model = local ? 'local-chat' : 'chat-1';
      assert.equal(models.data[0].code, model);
      assert(!JSON.stringify(models).includes('provider-test-key'));
      const job = await fetch(url + '/v1/jobs', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'chat', model, prompt: '测试桌面服务' }),
      });
      assert.equal(job.status, 202);
      const { id } = await job.json();
      const events = await fetch(url + `/v1/jobs/${id}/events`, { headers });
      assert.match(await events.text(), /"status":"completed"/);
      child.stdin.end();
      assert.deepEqual(await stopped, [0, null]);
      await assert.rejects(fetch(url + '/health'));
    } finally {
      output.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await stopped;
    }
  }
  assert.equal(api.catalogRequests.filter((route) => route.endsWith('/login')).length, 1, 'desktop API reuses the existing session');
});

test('standalone process prints a usable API token even without management configuration', { timeout: 8_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'octopuses-api-local-token-test-'));
  const { child, stopped, port, token } = await startProcess(t, directory);
  try {
    const endpoint = `http://127.0.0.1:${port}/v1/models`;
    assert.equal((await fetch(endpoint)).status, 401);
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'model_catalog_not_configured');
  } finally {
    child.kill('SIGTERM');
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
});

test('standalone startup loads .env and gives exported variables precedence', { timeout: 8_000 }, async (t) => {
  const api = await setup(t);
  await api.stop();
  await writeFile(join(api.directory, '.env'), [
    `OCTOPUSES_MANAGEMENT_URL=${api.config.managementUrl}`,
    'OCTOPUSES_MANAGEMENT_USERNAME=overridden-by-environment',
    `OCTOPUSES_MANAGEMENT_PASSWORD="${managementPassword}"`,
  ].join('\n'), { mode: 0o600 });
  const { child, stopped, port, token } = await startProcess(t, api.directory, {
    OCTOPUSES_MANAGEMENT_URL: undefined,
    OCTOPUSES_MANAGEMENT_USERNAME: managementUsername,
    OCTOPUSES_MANAGEMENT_PASSWORD: undefined,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].code, 'chat-1');
  } finally {
    child.kill('SIGTERM');
    await stopped;
  }
});

test('a saved desktop cache is added to .env once without replacing existing configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'octopuses-cache-location-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const cache = join(directory, "desktop cache's #2");
  const newerCache = join(directory, 'desktop cache 3');
  const envFile = join(directory, '.env');
  const desktopConfig = join(home, '.octopuses', 'cache-location.json');
  await mkdir(join(home, '.octopuses'), { recursive: true });
  await mkdir(cache);
  await mkdir(newerCache);
  const initial = '# existing settings\nOTHER_SETTING=keep';
  await writeFile(envFile, initial);
  await writeFile(desktopConfig, JSON.stringify({ cachePath: cache }));
  assert.equal(await configureCacheDirectory(undefined, { home, envFile }), cache);
  const saved = await readFile(envFile, 'utf8');
  assert(saved.startsWith(initial + '\nOCTOPUSES_API_CACHE_DIR='));
  assert.equal(saved.match(/OCTOPUSES_API_CACHE_DIR=/g).length, 1);

  await writeFile(desktopConfig, JSON.stringify({ cachePath: newerCache }));
  assert.equal(await configureCacheDirectory(undefined, { home, envFile }), cache);
  assert.equal(await configureCacheDirectory(newerCache, { home, envFile }), newerCache);
  assert.equal(await readFile(envFile, 'utf8'), saved);

  const api = await setup(t);
  await api.stop();
  await mkdir(join(cache, 'agents', 'reader'), { recursive: true });
  await writeFile(join(cache, 'agents', 'reader', 'AGENT.md'), '# Read using the configured cache');
  await writeFile(join(api.directory, '.env'), saved);
  const { child, stopped, port, token } = await startProcess(t, api.directory, { OCTOPUSES_API_CACHE_DIR: undefined });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: 'reader', name: 'reader', model: null }] });
  } finally {
    child.kill('SIGTERM');
    await stopped;
  }
});

test('standalone process records a crashed video as interrupted, retains its upstream ID and removes partial bytes', { timeout: 12_000 }, async (t) => {
  const api = await setup(t, { holdVideo: true });
  await api.stop();
  const { child, stopped, port, token } = await startProcess(t, api.directory, {
    OCTOPUSES_MANAGEMENT_URL: api.config.managementUrl,
    OCTOPUSES_MANAGEMENT_USERNAME: managementUsername,
    OCTOPUSES_MANAGEMENT_PASSWORD: managementPassword,
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'video', model: 'video-1', prompt: '测试重启' }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  await api.videoStarted.waiting;
  const partial = join(api.directory, 'artifacts', `${id}.part`);
  await writeFile(partial, 'partial output');
  child.kill('SIGKILL');
  await stopped;
  await api.restart();
  const job = await (await api.call(`/v1/jobs/${id}`)).json();
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'service_restarted');
  assert.equal(job.upstreamId, 'video_fixture');
  assert.equal(api.videoRequests.length, 1);
  await assert.rejects(readFile(partial), { code: 'ENOENT' });
});

test('startup exports desktop Agents from the chosen cache and uses them for API jobs', { timeout: 12_000 }, async (t) => {
  const api = await setup(t);
  await api.stop();
  const cache = join(api.directory, 'custom cache');
  const agents = join(cache, 'agents');
  const editorFile = join(agents, 'editor', 'AGENT.md');
  await mkdir(join(agents, 'editor'), { recursive: true });
  await mkdir(join(agents, 'empty-prompt'));
  await mkdir(join(agents, 'broken'));
  const name = '编辑 "稿件"';
  const instructions = '按要求整理稿件。\n\n保留原意。';
  const source = [
    '---', `name: ${JSON.stringify(name)}`, 'description: ""', 'model: "chat-1"',
    'tools: "write_file, ssh"', 'permissionMode: "auto-all"', '---', '', instructions,
  ].join('\r\n');
  await writeFile(editorFile, source);
  await writeFile(join(agents, 'empty-prompt', 'AGENT.md'), "---\nname: '默认助手' # comment\nmodel: ''\n---\n");
  await writeFile(join(agents, 'broken', 'AGENT.md'), '---\nname: malformed\n');
  await writeFile(join(cache, 'AGENTS.md'), '# This is an index, not an Agent');
  const options = {
    OCTOPUSES_MANAGEMENT_URL: api.config.managementUrl,
    OCTOPUSES_MANAGEMENT_USERNAME: managementUsername,
    OCTOPUSES_MANAGEMENT_PASSWORD: managementPassword,
    OCTOPUSES_API_CACHE_DIR: cache,
  };
  const launch = await startProcess(t, api.directory, options);
  const url = `http://127.0.0.1:${launch.port}`;
  const headers = { Authorization: `Bearer ${launch.token}` };
  const file = join(api.directory, 'agents.generated.json');
  try {
    const generated = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(generated, [
      { id: 'editor', name, model: 'chat-1', instructions },
      { id: 'empty-prompt', name: '默认助手', model: null, instructions: '' },
    ]);
    assert.equal(await readFile(editorFile, 'utf8'), source, 'desktop files are read only');
    const listed = await fetch(url + '/v1/agents', { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [
      { id: 'editor', name, model: 'chat-1' },
      { id: 'empty-prompt', name: '默认助手', model: null },
    ] });
    const submitted = await fetch(url + '/v1/jobs', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'chat', agentId: 'editor', prompt: '改写这句话' }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(submitted.status, 202);
    const { id } = await submitted.json();
    const events = await fetch(url + `/v1/jobs/${id}/events`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.match(await events.text(), /"status":"completed"/);
    assert.deepEqual(api.chats[0].messages[0], { role: 'system', content: instructions });
    assert.equal(Object.hasOwn(api.chats[0], 'tools'), false);
  } finally {
    launch.child.kill('SIGTERM');
    await launch.stopped;
  }

  const restored = await startProcess(t, api.directory, {
    OCTOPUSES_API_CACHE_DIR: join(api.directory, 'unmounted-cache'),
  });
  try {
    const base = `http://127.0.0.1:${restored.port}`;
    const headers = { Authorization: `Bearer ${restored.token}` };
    const listed = await fetch(base + '/v1/agents', { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).data.length, 2);
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].instructions, instructions);
    const job = await fetch(base + '/v1/jobs', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'chat', agentId: 'editor', prompt: '继续' }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(job.status, 503, 'execution still requires the management catalog');
    assert.equal((await job.json()).error.code, 'model_catalog_not_configured');
  } finally {
    restored.child.kill('SIGTERM');
    await restored.stopped;
  }

  const manual = join(api.directory, 'agents.json');
  await writeFile(manual, JSON.stringify([{ id: 'manual', name: '手动', model: 'chat-1', instructions: '手动提示词' }]));
  const override = await startProcess(t, api.directory, { ...options, OCTOPUSES_API_AGENTS_FILE: manual });
  try {
    const listed = await fetch(`http://127.0.0.1:${override.port}/v1/agents`, {
      headers: { Authorization: `Bearer ${override.token}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.deepEqual(await listed.json(), { data: [{ id: 'manual', name: '手动', model: 'chat-1' }] });
  } finally {
    override.child.kill('SIGTERM');
    await override.stopped;
  }
});

test('chunked requests over the body limit return 413 before a session can be created', { timeout: 8_000 }, async (t) => {
  const api = await setup(t);
  const base = (await api.call('/health')).url;
  async function* chunks() {
    yield Buffer.from('{"model":"chat-1","unused":"');
    yield Buffer.alloc(40_000, 'x');
    yield Buffer.alloc(40_000, 'x');
    yield Buffer.from('"}');
  }
  const response = await fetch(new URL('/v1/sessions', base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.apiToken()}`, 'Content-Type': 'application/json' },
    duplex: 'half',
    body: chunks(),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'request_too_large');
});
