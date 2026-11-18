import { createOAuthManager } from './oauth.mjs';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { atomicJSON, boundedBody, randomToken, readJSON, sameToken } from './storage.mjs';
import { runAgent, runCommand, cleanupContainer } from './agent.mjs';

export async function createHost({ directory, bind = '127.0.0.1', port = 0 }) {
  const root = path.resolve(directory); await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const keyFile = path.join(root, 'identity.json');
  const identity = await readJSON(keyFile, { token: randomToken(), clients: [] }); await atomicJSON(keyFile, identity);
  const jobs = new Map(); const active = new Map(); const runners = new Map(); const decisions = new Map(); const waiters = new Map();
  const browserQueue = []; const browserResults = new Map(); const browserWaiters = new Map();
  let browserLastSeen = 0; let configuration = { projects: [], model: null };
  let oauth;
  let pairing = null; const attempts = new Map();
  const jobDir = path.join(root, 'jobs'); await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(jobDir)) {
    if (!name.endsWith('.json')) continue;
    const job = await readJSON(path.join(jobDir, name), null);
    if (!job?.id) continue;
    if (['running', 'queued', 'approval'].includes(job.status)) { job.status = 'interrupted'; job.error = 'Host restarted. Inspect tool effects before resuming.'; }
    delete job.approval; jobs.set(job.id, job);
  }
  const save = (job) => atomicJSON(path.join(jobDir, `${job.id}.json`), job);
  const cleanJob = (job) => ({ id: job.id, projectId: job.projectId, prompt: job.prompt, workspace: job.workspace, status: job.status, result: job.result, error: job.error, approval: job.approval, turn: job.turn, createdAt: job.createdAt, container: job.container });
  const start = async (job) => {
    if (active.has(job.id)) throw new Error('Job is already running');
    if (job.containerName) { await cleanupContainer(job.containerName); delete job.containerName; }
    if (!configuration.model) throw new Error('Reconnect the desktop client to supply model credentials');
    const config = { ...configuration.model }; const controller = new AbortController(); active.set(job.id, controller);
    // Interrupted tools are reconciled by the model, never replayed as approved operations.
    const messages = job.messages ?? [];
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].tool_calls) continue;
      const replies = new Set(messages.slice(i + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      const missing = messages[i].tool_calls.filter((c) => !replies.has(c.id));
      if (missing.length) { messages.splice(i + 1, 0, ...missing.map((c) => ({ role: 'tool', tool_call_id: c.id, content: 'Execution interrupted. Side effects are unknown. Inspect current state before deciding the next step; prior approval does not authorize replay.' }))); i += missing.length; }
    }
    delete job.error; job.status = 'queued'; await save(job);
    const work = runAgent(job, config, {
      signal: controller.signal, save: () => save(job),
      approve: (callId) => new Promise((resolve, reject) => {
        const key = `${job.id}:${callId}`;
        if (controller.signal.aborted) { reject(new Error('Job paused')); return; }
        const abort = () => { waiters.delete(key); reject(new Error('Job paused')); };
        controller.signal.addEventListener('abort', abort, { once: true });
        const settle = (value) => { controller.signal.removeEventListener('abort', abort); resolve(value); };
        if (decisions.has(key)) { const decision = decisions.get(key); decisions.delete(key); settle(decision); } else waiters.set(key, settle);
      }),
      backup: async (file, callId) => {
        const folder = path.join(root, 'backups', job.id); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        const id = crypto.createHash('sha256').update(callId + file).digest('hex');
        try { await fs.copyFile(file, path.join(folder, id)); await atomicJSON(path.join(folder, `${id}.json`), { file, existed: true }); }
        catch (e) { if (e.code !== 'ENOENT') throw e; await atomicJSON(path.join(folder, `${id}.json`), { file, existed: false }); }
      },
    }).catch(async (error) => { job.status = controller.signal.aborted ? 'paused' : 'failed'; job.error = error.message; delete job.approval; await save(job); }).finally(() => { active.delete(job.id); runners.delete(job.id); }).catch((error) => { job.status = 'failed'; job.error = 'Recovery journal could not be saved: ' + error.message; console.error(job.error); });
    runners.set(job.id, work);
  };
  const browserAction = async (action) => {
    if (Date.now() - browserLastSeen > 65000) throw new Error('Browser extension is offline');
    const id = crypto.randomUUID(); browserQueue.push({ id, ...action });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { browserWaiters.delete(id); const at = browserQueue.findIndex((v) => v.id === id); if (at >= 0) browserQueue.splice(at, 1); reject(new Error('Browser action timed out')); }, 45000);
      browserWaiters.set(id, (result) => { clearTimeout(timer); result.error ? reject(new Error(result.error)) : resolve(result.result); });
    });
  };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://host.local'); const route = url.pathname;
      if (req.method === 'GET' && ['/', '/mobile.js', '/mobile.css'].includes(route)) {
        const file = route === '/' ? 'mobile.html' : route.slice(1);
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        res.end(await fs.readFile(new URL(file, import.meta.url))); return;
      }
      if (route === '/oauth/callback' && req.method === 'GET') {
        try { await oauth.callback(url); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Authorization complete. Return to octopuses.'); }
        catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message); } return;
      }
      if (route === '/health' && req.method === 'GET') return send(200, { name: 'octopuses-host', version: 1 });
      if (route === '/pair' && req.method === 'POST') {
        const ip = req.socket.remoteAddress; const now = Date.now(); const attempt = attempts.get(ip) ?? { at: now, count: 0 };
        if (now - attempt.at > 60000) { attempt.at = now; attempt.count = 0; } attempt.count++; attempts.set(ip, attempt);
        if (attempt.count > 5) return send(429, { error: 'Too many pairing attempts' });
        const body = await boundedBody(req, 1024);
        if (!pairing || now > pairing.expires || !sameToken(body.code, pairing.code) || !['mobile', 'browser'].includes(body.kind)) return send(403, { error: 'Invalid or expired pairing code' });
        const client = { token: randomToken(), kind: body.kind, id: crypto.randomUUID() }; pairing = null;
        identity.clients.push(client); await atomicJSON(keyFile, identity); return send(200, client);
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const master = sameToken(token, identity.token); const client = master ? { kind: 'master' } : identity.clients.find((c) => sameToken(token, c.token));
      if (!client) return send(401, { error: 'Pairing required' });
      if (route.startsWith('/browser/') && client.kind === 'browser') {
        browserLastSeen = Date.now();
        if (route === '/browser/next' && req.method === 'GET') return send(200, browserQueue.shift() ?? null);
        if (route === '/browser/result' && req.method === 'POST') {
          const body = await boundedBody(req); const callback = browserWaiters.get(body.id);
          if (callback) { browserWaiters.delete(body.id); callback(body); } return send(200, { ok: true });
        }
      }
      if (client.kind === 'browser') return send(403, { error: 'Browser client cannot control jobs' });
      if (master && req.method === 'POST' && route.startsWith('/oauth/')) {
        const body = await boundedBody(req);
        if (route === '/oauth/begin') return send(200, await oauth.begin(body));
        if (route === '/oauth/status') return send(200, oauth.status(body.id));
        if (route === '/oauth/forget') { oauth.forget(body.id); return send(200, { ok: true }); }
      }
      if (route === '/pair-code' && req.method === 'POST' && master) { pairing = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), expires: Date.now() + 300000 }; return send(200, pairing); }
      if (route === '/revoke' && req.method === 'POST' && master) { identity.clients = []; await atomicJSON(keyFile, identity); return send(200, { ok: true }); }
      if (route === '/configure' && req.method === 'POST' && master) {
        const body = await boundedBody(req); const projects = [];
        for (const p of body.projects ?? []) { if (typeof p.id !== 'string' || typeof p.path !== 'string') throw new Error('Invalid project'); projects.push({ id: p.id, name: String(p.name), path: await fs.realpath(p.path) }); }
        if (body.model) {
          const endpoint = new URL(body.model.url);
          if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid model URL');
          if (endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Model URL must use HTTPS except on loopback');
        }
        configuration = { projects, model: body.model }; return send(200, { ok: true });
      }
      if (route === '/status' && req.method === 'GET') return send(200, { projects: configuration.projects, modelReady: Boolean(configuration.model), browserOnline: Date.now() - browserLastSeen < 65000, jobs: [...jobs.values()].map(cleanJob) });
      if (route === '/browser/action' && req.method === 'POST') return send(200, await browserAction(await boundedBody(req)));
      if (route === '/jobs' && req.method === 'POST') {
        const body = await boundedBody(req); const project = configuration.projects.find((p) => p.id === body.projectId);
        if (!project || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32000) throw new Error('Invalid project or prompt');
        if (!configuration.model) throw new Error('No model configured');
        const job = { id: crypto.randomUUID(), projectId: project.id, workspace: project.path, prompt: body.prompt, createdAt: Date.now(), turn: 0, maxTurns: 50, network: Boolean(body.network), container: Boolean(body.container), image: 'octopuses-runner:local' };
        if (job.container) {
          const destination = path.join(root, 'workspaces', job.id); await fs.mkdir(path.dirname(destination), { recursive: true });
          const result = await runCommand('git', ['clone', '--no-local', '--no-hardlinks', project.path, destination]);
          if (result.code !== 0) throw new Error('Container repository creation failed: ' + result.output);
          const origin = await runCommand('git', ['-C', project.path, 'remote', 'get-url', 'origin']);
          if (origin.code === 0 && origin.output.trim()) { const changed = await runCommand('git', ['-C', destination, 'remote', 'set-url', 'origin', origin.output.trim()]); if (changed.code !== 0) throw new Error(changed.output); }
          job.workspace = destination;
        }
        jobs.set(job.id, job); await start(job); return send(201, cleanJob(job));
      }
      const match = route.match(/^\/jobs\/([a-f0-9-]+)(?:\/(resume|pause|approve))?$/);
      if (match) {
        const job = jobs.get(match[1]); if (!job) return send(404, { error: 'Unknown job' });
        if (req.method === 'GET' && !match[2]) return send(200, { ...cleanJob(job), messages: job.messages });
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
        if (match[2] === 'pause') { active.get(job.id)?.abort(); await runners.get(job.id); return send(200, { ok: true }); }
        if (match[2] === 'resume') { job.maxTurns = Math.min(1000, Math.max(job.maxTurns, job.turn + 50)); await start(job); return send(200, cleanJob(job)); }
        if (match[2] === 'approve') {
          const body = await boundedBody(req, 1024);
          if (job.approval?.id !== body.id || typeof body.approved !== 'boolean') return send(409, { error: 'Approval is no longer pending' });
          const key = `${job.id}:${body.id}`; const waiter = waiters.get(key);
          if (waiter) { waiters.delete(key); waiter(body.approved); } else decisions.set(key, body.approved);
          return send(200, { ok: true });
        }
      }
      if (route === '/shutdown' && req.method === 'POST' && master) { send(200, { ok: true }); setTimeout(() => void close(), 100); return; }
      send(404, { error: 'Unknown endpoint' });
    } catch (e) { if (!res.headersSent) send(400, { error: e.message }); else res.destroy(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  const address = server.address();
  oauth = createOAuthManager(`http://127.0.0.1:${address.port}/oauth/callback`);
  await atomicJSON(path.join(root, 'state.json'), { port: address.port, pid: process.pid, bind, token: identity.token });
  const close = async () => { browserQueue.length = 0; for (const callback of browserWaiters.values()) callback({ error: "Host stopped" }); browserWaiters.clear(); for (const controller of active.values()) controller.abort(); await Promise.allSettled([...runners.values()]); await new Promise((resolve) => server.close(resolve)); };
  return { server, port: address.port, token: identity.token, close, jobs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
  const host = await createHost({ directory: at('--directory', path.join(process.cwd(), '.octopuses-host')), bind: at('--bind', '127.0.0.1'), port: Number(at('--port', '0')) });
  console.log(JSON.stringify({ ready: true, port: host.port }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void host.close().then(() => process.exit(0)));
}
