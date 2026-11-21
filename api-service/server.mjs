import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { loadAgentCatalog } from './agents.mjs';
import { configureCacheDirectory } from './cache-location.mjs';
import { ApiError, failure, readObject, sendJSON } from './http.mjs';
import { createJobs, jobView, terminal } from './jobs.mjs';
import { managementClient, selectModel } from './management.mjs';
import { JOB_BODY_LIMIT, requiredText, taskInput } from './providers.mjs';
import { loadSkills } from './skills.mjs';
import { openStore } from './store.mjs';

const uuid = '[a-f0-9-]{36}';
const sessionRoute = new RegExp(`^/v1/sessions/(${uuid})$`);
const jobRoute = new RegExp(`^/v1/jobs/(${uuid})(?:/(events|cancel|artifact))?$`);
const localOwner = 'local-api';

/** Resolve the model and Agent instructions for a new session or a standalone task. */
function configuration(body, agents) {
  const agentId = body.agentId === undefined ? null : requiredText(body.agentId, 'agentId', 80);
  const agent = agentId ? agents.get(agentId) : null;
  if (agentId && !agent) throw new ApiError(404, 'agent_not_found', 'Agent 不存在。');
  const requested = body.model === undefined ? null : requiredText(body.model, 'model');
  if (requested && agent?.model && requested !== agent.model) {
    throw new ApiError(400, 'agent_model_mismatch', '此 Agent 已指定模型。');
  }
  return { model: requiredText(agent?.model ?? requested, 'model'), agentId, instructions: agent?.instructions ?? null };
}

/** Compare fixed-length digests so a failed credential check reveals no part of the service token. */
function digest(token) {
  return createHash('sha256').update(token).digest();
}

/** Authenticate callers entirely in this process, including when the model catalog is offline. */
function requireLocalToken(request, expectedDigest) {
  const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(request.headers.authorization ?? '');
  if (!match || !timingSafeEqual(digest(match[1]), expectedDigest)) {
    throw new ApiError(401, 'unauthorized', '请使用独立 API 启动时打印的 Bearer 令牌。');
  }
}

/** Hold no per-client event queue. Clients can reconnect for the latest persisted state. */
function streamEvents(response, row, jobs) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
  /** End streams on terminal state so clients do not wait indefinitely. */
  function send(event, payload) {
    if (response.writableLength > 1024 * 1024) {
      response.destroy();
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (event === 'status' && terminal.has(payload.status)) response.end();
  }
  if (terminal.has(row.status)) {
    send('status', jobView(row));
    return;
  }
  const unsubscribe = jobs.subscribe(row.id, send);
  const heartbeat = setInterval(() => {
    if (response.writableLength > 1024 * 1024) response.destroy();
    else response.write(': heartbeat\n\n');
  }, 15_000).unref();
  response.once('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  send('status', jobView(row));
}

/** Start an independent API process with no desktop runtime or browser bridge dependency. */
export async function createApiService({
  managementUrl, managementUsername, managementPassword, managementSessionToken, modelCatalog,
  apiToken = randomBytes(32).toString('base64url'),
  directory, host = '127.0.0.1', port = 8180, agents: entries, agentsFile, cacheDirectory,
  autoSkills = true,
  concurrency = 2, queueLimit = 8, pollInterval = 3_000, jobTimeout = 30 * 60_000,
}) {
  if (typeof apiToken !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(apiToken)) {
    throw new Error('OCTOPUSES_API_TOKEN 必须是 32 至 256 位，由字母、数字或 . _ ~ - 组成。');
  }
  const expectedDigest = digest(apiToken);
  const shutdown = new AbortController();
  const loadModels = modelCatalog ?? managementClient(managementUrl, {
    username: managementUsername, password: managementPassword,
    sessionToken: managementSessionToken, shutdownSignal: shutdown.signal,
  }).models;
  const root = resolve(directory);
  const store = openStore(root);
  let jobs, agents, generatedAgents;
  try {
    ({ catalog: agents, generated: generatedAgents } = await loadAgentCatalog({
      entries, configFile: agentsFile, cacheDirectory, directory: root,
    }));
    const skills = autoSkills ? await loadSkills(cacheDirectory) : [];
    jobs = await createJobs({ store, directory: root, concurrency, queueLimit, pollInterval, jobTimeout, skills });
  } catch (error) { store.close(); throw error; }
  let submissions = 0;
  let closing;

  /** Bind sessions to this service's workspace so token rotation does not orphan conversations. */
  function getSession(id) {
    const session = store.session(id, localOwner);
    if (!session) throw new ApiError(404, 'session_not_found', '会话不存在。');
    return session;
  }

  /** Submissions are bounded before buffering uploads and authorized before queuing work. */
  async function submit(request, response, signal) {
    if (submissions >= 4) throw new ApiError(503, 'busy', '当前提交请求过多，请稍后重试。');
    submissions++;
    try {
      const body = await readObject(request, JOB_BODY_LIMIT);
      const input = taskInput(body);
      const sessionId = body.sessionId === undefined ? null : requiredText(body.sessionId, 'sessionId', 36);
      if (input.kind !== 'chat' && (sessionId || body.agentId !== undefined)) {
        throw new ApiError(400, 'invalid_input', 'sessionId 和 agentId 仅适用于对话。');
      }
      const session = sessionId ? getSession(sessionId) : null;
      if (session && (body.model !== undefined || body.agentId !== undefined)) {
        throw new ApiError(400, 'invalid_input', '此会话已绑定模型和 Agent，请仅提供 sessionId。');
      }
      const config = session ? { model: session.model } : configuration(body, agents);
      const model = selectModel(await loadModels(signal), config.model, input.kind);
      signal.throwIfAborted();
      const job = jobs.submit(localOwner, input, model, session, config.instructions);
      response.setHeader('Location', `/v1/jobs/${job.id}`);
      sendJSON(response, 202, job);
    } finally { submissions--; }
  }

  /** Protect every business route with the local token, then fetch models only where needed. */
  async function handle(request, response, signal) {
    const method = request.method;
    const route = new URL(request.url, 'http://api.local').pathname;
    if (route === '/health' && method === 'GET') return sendJSON(response, 200, { status: 'ok' });
    if (!route.startsWith('/v1/')) throw new ApiError(404, 'not_found', '接口不存在。');
    requireLocalToken(request, expectedDigest);
    if (closing) throw new ApiError(503, 'service_stopping', '服务正在停止。');
    if (route === '/v1/models' && method === 'GET') {
      const models = await loadModels(signal);
      return sendJSON(response, 200, { data: models.map((model) => ({
        code: model.code, name: typeof model.name === 'string' ? model.name : model.code,
        supportsChat: model.supportsChat ?? model.supports_chat,
        supportsImages: model.supportsImages,
        supportsAudioTranscription: model.supportsAudioTranscription ?? model.supports_audio_transcription,
      })) });
    }
    if (route === '/v1/agents' && method === 'GET') {
      const data = [...agents.values()].map(({ id, name, model }) => ({ id, name, model }));
      return sendJSON(response, 200, { data });
    }
    if (route === '/v1/sessions' && method === 'POST') {
      const config = configuration(await readObject(request, 64 * 1024), agents);
      selectModel(await loadModels(signal), config.model, 'chat');
      signal.throwIfAborted();
      const { id, model, agent, created_at: createdAt } = store.createSession(
        randomUUID(), localOwner, config.model, config.agentId, config.instructions,
      );
      response.setHeader('Location', `/v1/sessions/${id}`);
      return sendJSON(response, 201, { id, model, agentId: agent, createdAt });
    }
    const sessionMatch = sessionRoute.exec(route);
    if (sessionMatch && method === 'GET') {
      const { id, model, agent, created_at: createdAt } = getSession(sessionMatch[1]);
      return sendJSON(response, 200, { id, model, agentId: agent, createdAt, turns: store.history(id) });
    }
    if (route === '/v1/jobs' && method === 'POST') return submit(request, response, signal);
    const jobMatch = jobRoute.exec(route);
    if (jobMatch) {
      const [, id, action] = jobMatch;
      const row = store.job(id, localOwner);
      if (!row) throw new ApiError(404, 'job_not_found', '任务不存在。');
      if (method === 'GET' && !action) return sendJSON(response, 200, jobView(row));
      if (method === 'GET' && action === 'events') return streamEvents(response, row, jobs);
      if (method === 'POST' && action === 'cancel') return sendJSON(response, 200, jobs.cancel(row));
      if (method === 'GET' && action === 'artifact') {
        const artifact = jobView(row).result?.artifact;
        if (!artifact) throw new ApiError(404, 'artifact_not_found', '任务还没有可下载的产物。');
        const file = jobs.artifactPath(id);
        const metadata = await stat(file).catch(() => null);
        if (!metadata?.isFile() || metadata.size !== artifact.bytes) {
          throw new ApiError(404, 'artifact_not_found', '产物文件不存在或不完整。');
        }
        response.writeHead(200, {
          'Content-Type': artifact.mime, 'Content-Length': artifact.bytes,
          'Content-Disposition': `attachment; filename="${artifact.name}"`,
        });
        await pipeline(createReadStream(file), response, { signal });
        return;
      }
    }
    throw new ApiError(404, 'not_found', '接口不存在。');
  }

  const server = http.createServer({ requestTimeout: 60_000, headersTimeout: 15_000 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    void handle(request, response, controller.signal).catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const detail = failure(error);
      if (detail.status === 500) console.error('API 请求失败', error.code ?? error.name);
      if (!request.complete) {
        response.setHeader('Connection', 'close');
        request.resume();
      }
      if (detail.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
      sendJSON(response, detail.status, { error: { code: detail.code, message: detail.message } });
    });
  });
  server.maxConnections = 64;
  try {
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        ready();
      });
    });
  } catch (error) {
    await jobs.close();
    store.close();
    throw error;
  }

  /** Stop accepting traffic, finish workers and release persistent resources. */
  function close() {
    closing ??= (async () => {
      const stopped = new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready()));
      server.closeAllConnections();
      shutdown.abort();
      try { await Promise.all([jobs.close(), stopped]); }
      finally { store.close(); }
    })();
    return closing;
  }

  return { address: server.address(), token: apiToken, generatedAgents, close };
}

/** Read the optional local configuration while preserving deployment environment overrides. */
async function main() {
  try { loadEnvFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = process.env;
  const port = Number(env.OCTOPUSES_API_PORT ?? 8180);
  const concurrency = Number(env.OCTOPUSES_API_CONCURRENCY ?? 2);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('OCTOPUSES_API_PORT 无效。');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('OCTOPUSES_API_CONCURRENCY 必须为 1 到 8。');
  }
  const cacheDirectory = await configureCacheDirectory(env.OCTOPUSES_API_CACHE_DIR);
  const service = await createApiService({
    managementUrl: env.OCTOPUSES_MANAGEMENT_URL,
    managementUsername: env.OCTOPUSES_MANAGEMENT_USERNAME,
    managementPassword: env.OCTOPUSES_MANAGEMENT_PASSWORD,
    apiToken: env.OCTOPUSES_API_TOKEN,
    directory: env.OCTOPUSES_API_DATA_DIR ?? '.octopuses-api',
    host: env.OCTOPUSES_API_HOST ?? '127.0.0.1', port, concurrency,
    agentsFile: env.OCTOPUSES_API_AGENTS_FILE, cacheDirectory,
    autoSkills: env.OCTOPUSES_API_AUTO_SKILLS !== 'false',
  });
  console.log(`octopuses API 正在监听 ${service.address.address}:${service.address.port}`);
  console.log(`接口调用令牌（Bearer） ${service.token}`);
  if (service.generatedAgents) {
    const { count, file, restored } = service.generatedAgents;
    console.log(`已${restored ? '恢复' : '导入'} ${count} 个 Agent，配置文件 ${file}`);
  }
  /** Release the data directory lock when the process is stopped by its supervisor. */
  const stop = () => {
    void service.close().catch((error) => {
      console.error('停止服务失败', error.code ?? error.name);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error('无法启动 octopuses API', error.message);
    process.exitCode = 1;
  }
}
