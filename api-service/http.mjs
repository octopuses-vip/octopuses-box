export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Return only deliberate client errors and keep unexpected implementation details in the service. */
export function failure(error) {
  return error instanceof ApiError ? error : new ApiError(500, 'internal_error', '服务内部错误。');
}

/** Enforce the body size even for chunked requests without closing the socket before sending an error. */
export async function readObject(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'unsupported_content_type', '请求需要使用 application/json。');
  }
  const tooLarge = new ApiError(413, 'request_too_large', '请求超过允许的大小。');
  if (Number(request.headers['content-length']) > limit) throw tooLarge;
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw tooLarge;
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', '请求需要包含有效的 JSON 对象。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_json', '请求需要包含有效的 JSON 对象。');
  }
  return body;
}

/** Send JSON using the status and content type expected by API callers. */
export function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** Validate configured service addresses before adding credentials or appending endpoint paths. */
export function httpBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址必须是无账号、密码、查询参数或片段的 HTTP(S) 地址。');
  }
  return url.href.replace(/\/+$/, '');
}

/** Read upstream JSON responses with a byte limit even when no length header is present. */
export async function readUpstreamJSON(response, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new ApiError(502, 'upstream_response_too_large', '上游响应超过限制。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(502, 'invalid_upstream_response', '上游未返回有效的 JSON。'); }
}

/** Bound each request independently of the overall job and never follow a redirect with credentials. */
export async function upstream(url, { key, json, body, signal, timeout = 30_000 } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const deadline = AbortSignal.timeout(timeout);
  try {
    return await fetch(url, {
      method: json !== undefined || body !== undefined ? 'POST' : 'GET',
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch {
    signal?.throwIfAborted();
    throw new ApiError(deadline.aborted ? 504 : 502, 'upstream_unreachable', '无法连接上游服务或请求超时。');
  }
}
