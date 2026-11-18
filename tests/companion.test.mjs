import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHost } from '../companion/server.mjs';

async function setup(t, { directory, port } = {}) {
  const root = directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'octopuses-host-'));
  const host = await createHost({ directory: root, port });
  const base = `http://127.0.0.1:${host.port}`;
  const request = async (route, body, token = host.token) => {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await host.close();
    if (!directory) await fs.rm(root, { recursive: true, force: true });
  });
  return { host, request };
}

test('the bridge removes desktop and phone job APIs without touching saved task files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopuses-legacy-'));
  // Remove after closing the bridge, which also verifies that saved files survive startup.
  const jobs = path.join(directory, 'jobs');
  await fs.mkdir(jobs);
  const storedTask = path.join(jobs, 'old.json');
  await fs.writeFile(storedTask, '{"id":"old","status":"paused"}');
  await fs.writeFile(path.join(directory, 'identity.json'), JSON.stringify({
    token: 'fixture-desktop',
    clients: [{ token: 'fixture-mobile', kind: 'mobile' }, { token: 'fixture-browser', kind: 'browser' }],
  }));

  const { request } = await setup(t, { directory });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual((await request('/health')).data, { name: 'octopuses-host', version: 3 });
  for (const [route, body] of [
    ['/', undefined], ['/mobile.js', undefined], ['/configure', {}], ['/jobs', {}],
    ['/jobs/old', undefined], ['/jobs/old/resume', {}], ['/jobs/old/approve', {}],
  ]) {
    assert.equal((await request(route, body)).status, 404, route);
  }
  assert.equal((await request('/browser/next', undefined, 'fixture-mobile')).status, 401);
  assert.equal((await request('/browser/next', undefined, 'fixture-browser')).status, 200);
  assert.equal((await fs.readFile(storedTask, 'utf8')), '{"id":"old","status":"paused"}');
});

test('extension pairing and authenticated tab relay work on loopback', { timeout: 5000 }, async (t) => {
  const { host, request } = await setup(t);
  assert.equal(host.server.address().address, '127.0.0.1');
  assert.equal((await request('/status', undefined, 'wrong')).status, 401);
  const { data: pairing } = await request('/pair-code', {});
  assert.equal((await request('/pair', { code: pairing.code, kind: 'mobile' }, '')).status, 403);
  const paired = await request('/pair', { code: pairing.code, kind: 'browser' }, '');
  assert.equal(paired.status, 200);
  const token = paired.data.token;
  assert.equal((await request('/pair', { code: pairing.code, kind: 'browser' }, '')).status, 403);
  assert.equal((await request('/status', undefined, token)).status, 403);
  assert.deepEqual((await request('/browser/next', undefined, token)).data, null);
  assert.deepEqual((await request('/status')).data, { browserOnline: true });

  const waiting = request('/browser/action', { action: 'tabs' });
  let queued;
  for (let attempt = 0; attempt < 10 && !queued; attempt++) {
    queued = (await request('/browser/next', undefined, token)).data;
  }
  assert.equal(queued?.action, 'tabs');
  const tabs = [{ id: 7, title: 'Project preview', url: 'http://localhost:3000' }];
  await request('/browser/result', { id: queued.id, result: tabs }, token);
  assert.deepEqual((await waiting).data, tabs);
  await request('/revoke', {});
  assert.equal((await request('/browser/next', undefined, token)).status, 401);
  assert.deepEqual((await request('/status')).data, { browserOnline: false });
});

test('a stale preferred port falls back to an available loopback port', async (t) => {
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const port = occupied.address().port;
  const { host, request } = await setup(t, { port });
  assert.notEqual(host.port, port);
  assert.equal((await request('/status')).status, 200);
});

test('the browser bridge no longer handles MCP account authorization', async (t) => {
  const { request } = await setup(t);
  for (const route of ['/oauth/begin', '/oauth/status', '/oauth/forget']) {
    assert.equal((await request(route, {})).status, 404, route);
  }
  assert.equal((await request('/oauth/callback')).status, 404);
  assert.equal((await request('/oauth/callback', undefined, '')).status, 401);
});
