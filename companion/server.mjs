import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { atomicJSON, boundedBody, randomToken, readJSON, sameToken } from './storage.mjs';

const VERSION = 3;
const LOOPBACK = '127.0.0.1';

/** Serve browser extension pairing and tab relay only on this computer. */
export async function createHost({ directory, port = 0 }) {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  const keyFile = path.join(root, 'identity.json');
  const identity = await readJSON(keyFile, { token: randomToken(), clients: [] });
  identity.clients = identity.clients.filter((client) => client.kind === 'browser');
  await atomicJSON(keyFile, identity);

  const browserQueue = [];
  const browserWaiters = new Map();
  const attempts = new Map();
  let browserLastSeen = 0;
  let pairing = null;

  const browserOnline = () => Date.now() - browserLastSeen < 65000;

  function browserAction(action) {
    if (!browserOnline()) throw new Error('浏览器扩展未连接，请先配对或打开扩展。');
    const id = crypto.randomUUID();
    browserQueue.push({ ...action, id });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        browserWaiters.delete(id);
        const index = browserQueue.findIndex((item) => item.id === id);
        if (index >= 0) browserQueue.splice(index, 1);
        reject(new Error('等待浏览器扩展响应超时。'));
      }, 45000);
      browserWaiters.set(id, (response) => {
        clearTimeout(timeout);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      });
    });
  }

  function disconnectBrowser() {
    browserLastSeen = 0;
    pairing = null;
    browserQueue.length = 0;
    for (const callback of browserWaiters.values()) callback({ error: '浏览器连接已断开。' });
    browserWaiters.clear();
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };

    try {
      const url = new URL(req.url, 'http://host.local');
      const route = url.pathname;
      if (route === '/health' && req.method === 'GET') {
        return send(200, { name: 'octopuses-host', version: VERSION });
      }
      if (route === '/pair' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        let attempt = attempts.get(ip);
        if (!attempt || now - attempt.at > 60000) {
          attempt = { at: now, count: 0 };
          attempts.set(ip, attempt);
        }
        if (++attempt.count > 5) return send(429, { error: '配对尝试过于频繁，请稍后再试。' });
        const body = await boundedBody(req, 1024);
        if (body.kind !== 'browser' || !pairing || Date.now() > pairing.expires || !sameToken(body.code, pairing.code)) {
          return send(403, { error: '配对码无效或已过期。' });
        }
        const client = { token: randomToken(), kind: 'browser', id: crypto.randomUUID() };
        pairing = null;
        identity.clients.push(client);
        await atomicJSON(keyFile, identity);
        return send(200, client);
      }

      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!sameToken(token, identity.token)) {
        if (!identity.clients.some((client) => sameToken(token, client.token))) {
          return send(401, { error: '请先配对浏览器扩展。' });
        }
        if (route === '/browser/next' && req.method === 'GET') {
          browserLastSeen = Date.now();
          return send(200, browserQueue.shift() ?? null);
        }
        if (route === '/browser/result' && req.method === 'POST') {
          const response = await boundedBody(req);
          const callback = browserWaiters.get(response.id);
          if (callback) {
            browserWaiters.delete(response.id);
            callback(response);
          }
          return send(200, { ok: true });
        }
        return send(403, { error: '此接口仅供桌面客户端使用。' });
      }

      if (route === '/status' && req.method === 'GET') return send(200, { browserOnline: browserOnline() });
      if (req.method === 'POST') {
        if (route === '/pair-code') {
          pairing = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), expires: Date.now() + 300000 };
          return send(200, pairing);
        }
        if (route === '/revoke') {
          identity.clients = [];
          disconnectBrowser();
          await atomicJSON(keyFile, identity);
          return send(200, { ok: true });
        }
        if (route === '/browser/action') return send(200, await browserAction(await boundedBody(req)));
      }
      send(404, { error: '接口不存在。' });
    } catch (error) {
      if (!res.headersSent) send(400, { error: error.message });
      else res.destroy();
    }
  });

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const listen = (requestedPort) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, LOOPBACK, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await listen(port);
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || !port) throw error;
    await listen(0);
  }
  const address = server.address();
  await atomicJSON(path.join(root, 'state.json'), {
    port: address.port, pid: process.pid, version: VERSION, token: identity.token,
  });

  const close = async () => {
    disconnectBrowser();
    await new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    }));
  };
  return { server, port: address.port, token: identity.token, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const host = await createHost({
    directory: at('--directory', path.join(process.cwd(), '.octopuses-host')),
    port: Number(at('--port', '0')),
  });
  console.log(JSON.stringify({ ready: true, port: host.port }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void host.close().then(() => process.exit(0)));
  }
}
