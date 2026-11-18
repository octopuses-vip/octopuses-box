import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHost } from '../companion/server.mjs';
import { containedPath } from '../companion/storage.mjs';
import { shellSpec } from '../companion/agent.mjs';
import { createOAuthManager } from '../companion/oauth.mjs';
import crypto from 'node:crypto';

async function setup(t, model) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopuses-host-'));
  const workspace = path.join(directory, 'project'); await fs.mkdir(workspace);
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: model(body) }] }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const host = await createHost({ directory: path.join(directory, 'host') });
  const request = async (route, body, token = host.token) => {
    const response = await fetch(`http://127.0.0.1:${host.port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  await request('/configure', { projects: [{ id: 'p', name: 'Project', path: workspace }], model: { url: `http://127.0.0.1:${mock.address().port}/v1`, key: 'TEST_SECRET_NOT_ON_DISK', model: 'test' } });
  t.after(async () => { await host.close(); await new Promise((resolve) => mock.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { host, request, directory, workspace };
}
async function waitFor(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 20)); } throw new Error('Timed out'); }

test('host runs approved tools independently, retains result and excludes credentials from task records', async (t) => {
  const fixture = await setup(t, (body) => body.messages.some((m) => m.role === 'tool') ? { role: 'assistant', content: 'verified output' } : { role: 'assistant', content: null, tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'written' }) } }] });
  const created = await fixture.request('/jobs', { projectId: 'p', prompt: 'Write result' }); assert.equal(created.status, 201);
  const id = created.data.id;
  await waitFor(async () => (await fixture.request(`/jobs/${id}`)).data.approval);
  await assert.rejects(fs.access(path.join(fixture.workspace, 'result.txt')));
  const wrong = await fixture.request(`/jobs/${id}/approve`, { id: 'stale', approved: true }); assert.equal(wrong.status, 409);
  await fixture.request(`/jobs/${id}/approve`, { id: 'write-1', approved: true });
  await waitFor(async () => (await fixture.request(`/jobs/${id}`)).data.status === 'complete');
  assert.equal(await fs.readFile(path.join(fixture.workspace, 'result.txt'), 'utf8'), 'written');
  const disk = await fs.readFile(path.join(fixture.directory, 'host/jobs', `${id}.json`), 'utf8'); assert.ok(!disk.includes('TEST_SECRET_NOT_ON_DISK'));
});

test('host rejects unknown identities and pairs browser clients with limited privileges', async (t) => {
  const { request } = await setup(t, () => ({ role: 'assistant', content: 'done' }));
  assert.equal((await request('/status', undefined, 'wrong')).status, 401);
  const pairing = await request('/pair-code', {});
  const paired = await request('/pair', { code: pairing.data.code, kind: 'browser' }, ''); assert.equal(paired.status, 200);
  assert.equal((await request('/pair', { code: pairing.data.code, kind: 'mobile' }, '')).status, 403);
  assert.equal((await request('/status', undefined, paired.data.token)).status, 403);
  assert.equal((await request('/browser/next', undefined, paired.data.token)).status, 200);
  await request('/revoke', {}); assert.equal((await request('/browser/next', undefined, paired.data.token)).status, 401);
});

test('project path resolver rejects traversal and links to outside the authorized root', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'octopuses-path-')); const root = path.join(folder, 'root'); await fs.mkdir(root);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await assert.rejects(containedPath(root, '../outside', true), /outside/);
  if (process.platform !== 'win32') { await fs.symlink(folder, path.join(root, 'link')); await assert.rejects(containedPath(root, 'link/outside', true), /outside/); }
  assert.equal(await containedPath(root, 'new/file.txt', true), path.join(await fs.realpath(root), 'new/file.txt'));
});

test('container commands have enforced boundaries and command text remains one argument', () => {
  const [program, args] = shellSpec('/tmp/project', 'echo $HOME; touch /outside', { container: true, network: false });
  assert.equal(program, 'docker'); assert.ok(args.includes('--read-only')); assert.ok(args.includes('none')); assert.equal(args.at(-1), 'echo $HOME; touch /outside');
});

test('interrupted tool calls are reconciled on resume instead of replaying prior approvals', async (t) => {
  const fixture = await setup(t, (body) => body.messages.some((m) => m.role === 'tool') ? { role: 'assistant', content: 'Need to inspect interrupted work' } : { role: 'assistant', content: null, tool_calls: [{ id: 'pending-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'never.txt', content: 'must not write' }) } }] });
  const created = await fixture.request('/jobs', { projectId: 'p', prompt: 'Task' }); const id = created.data.id;
  await waitFor(async () => (await fixture.request(`/jobs/${id}`)).data.approval);
  await fixture.request(`/jobs/${id}/pause`, {});
  await waitFor(async () => (await fixture.request(`/jobs/${id}`)).data.status === 'paused');
  await fixture.request(`/jobs/${id}/resume`, {});
  await waitFor(async () => (await fixture.request(`/jobs/${id}`)).data.status === 'complete');
  await assert.rejects(fs.access(path.join(fixture.workspace, 'never.txt')));
  const final = await fixture.request(`/jobs/${id}`);
  assert.ok(final.data.messages.some((m) => m.role === 'tool' && m.content.includes('prior approval does not authorize replay')));
});

test('OAuth discovery, dynamic registration and PKCE bind the authorization code to the MCP resource', async (t) => {
  let origin; let challenge; let registeredRedirect; let verifier;
  const issuer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return res.end(JSON.stringify({ resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['tools'] }));
    if (req.url === '/.well-known/oauth-authorization-server') return res.end(JSON.stringify({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', code_challenge_methods_supported: ['S256'] }));
    if (req.url === '/register') { const body = JSON.parse(Buffer.concat(chunks).toString()); registeredRedirect = body.redirect_uris[0]; return res.end(JSON.stringify({ client_id: 'public-client' })); }
    if (req.url === '/token') { const form = new URLSearchParams(Buffer.concat(chunks).toString()); verifier = form.get('code_verifier'); assert.equal(form.get('resource'), origin + '/mcp'); assert.equal(form.get('redirect_uri'), registeredRedirect); return res.end(JSON.stringify({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 3600 })); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => issuer.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${issuer.address().port}`;
  t.after(() => new Promise((resolve) => issuer.close(resolve)));
  const manager = createOAuthManager('http://127.0.0.1:12345/oauth/callback'); const begun = await manager.begin({ resource: origin + '/mcp' });
  const authorization = new URL(begun.authorizationUrl); challenge = authorization.searchParams.get('code_challenge');
  await assert.rejects(manager.callback(new URL('http://127.0.0.1/callback?state=wrong&code=code')), /state/);
  const callback = new URL('http://127.0.0.1/callback'); callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'code');
  await manager.callback(callback); assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
  assert.equal(manager.status(begun.id).token.resource, origin + '/mcp'); manager.forget(begun.id); assert.throws(() => manager.status(begun.id), /expired/);
});
