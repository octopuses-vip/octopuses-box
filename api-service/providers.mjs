import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, readUpstreamJSON, upstream } from './http.mjs';
import { selectedSkills, skillSelectionMessages } from './skills.mjs';

const MiB = 1024 * 1024;
const AUDIO_BYTES = 25 * MiB;
const IMAGE_BYTES = 10 * MiB;
const AUDIO_TYPES = {
  mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav',
  mp4: 'audio/mp4', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', webm: 'audio/webm',
};
export const JOB_BODY_LIMIT = Math.ceil(AUDIO_BYTES / 3) * 4 + 64 * 1024;

/** Reject missing or oversized fields before a provider can consume quota. */
export function requiredText(value, field, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new ApiError(400, 'invalid_input', `${field} 必须是有效的非空字符串（最多 ${max} 字符）。`);
  }
  return value.trim();
}

/** Check standard base64 without allocating decoded bytes at admission time. */
function encodedSize(value, max, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ApiError(400, 'invalid_input', `${field} 必须是标准 Base64。`);
  }
  const size = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (size > max) throw new ApiError(413, 'file_too_large', `${field} 解码后不得超过 ${max / MiB} MiB。`);
  return size;
}

/** Validate task-specific data and forward only the fields allowed by the service. */
export function taskInput(body) {
  const kind = body.type;
  if (kind === 'transcribe') {
    const filename = requiredText(body.filename, 'filename', 255);
    const extension = filename.split('.').at(-1).toLowerCase();
    const mime = Object.hasOwn(AUDIO_TYPES, extension) ? AUDIO_TYPES[extension] : undefined;
    if (!filename.includes('.') || /[\\/\x00-\x1f]/.test(filename) || !mime) {
      throw new ApiError(400, 'unsupported_audio', '请提供受支持的音视频文件名。');
    }
    encodedSize(body.audioBase64, AUDIO_BYTES, 'audioBase64');
    const language = body.language === undefined ? undefined : requiredText(body.language, 'language', 16);
    return { kind, filename, mime, audioBase64: body.audioBase64, language };
  }
  if (!['chat', 'image', 'video'].includes(kind)) {
    throw new ApiError(400, 'invalid_task_type', 'type 必须是 chat、transcribe、image 或 video。');
  }
  const prompt = requiredText(body.prompt, 'prompt', 32_000);
  if (kind === 'chat') return { kind, prompt };
  const size = body.size === undefined ? undefined : requiredText(body.size, 'size', 20);
  if (size && !/^[1-9][0-9]*x[1-9][0-9]*$/.test(size)) {
    throw new ApiError(400, 'invalid_input', 'size 应为宽x高，例如 832x480。');
  }
  if (kind === 'image') return { kind, prompt, size };
  const seconds = typeof body.seconds === 'number' ? String(body.seconds) : body.seconds;
  if (seconds !== undefined && (typeof seconds !== 'string' || !/^[1-9][0-9]{0,5}$/.test(seconds))) {
    throw new ApiError(400, 'invalid_input', 'seconds 应为正整数秒。');
  }
  const reference = body.input_reference;
  let inputReference;
  if (reference !== undefined) {
    const data = typeof reference?.image_url === 'string'
      ? /^data:image\/(?:png|jpeg|webp);base64,/.exec(reference.image_url)
      : null;
    if (!data) throw new ApiError(400, 'invalid_input', '参考图需要使用 JPEG、PNG 或 WebP 的 Base64 data URL。');
    encodedSize(reference.image_url.slice(data[0].length), IMAGE_BYTES, '参考图');
    inputReference = { image_url: reference.image_url };
  }
  return { kind, prompt, size, seconds, inputReference };
}

/** Mark HTTP errors with the original status for retry decisions without leaking provider bodies. */
async function requireSuccess(response) {
  if (response.ok) return response;
  await response.body?.cancel();
  const error = new ApiError(502, 'model_http_error', `模型请求失败（HTTP ${response.status}）。`);
  error.providerStatus = response.status;
  throw error;
}

/** Normalize business errors from gateways that wrap a task in an envelope. */
function videoData(payload) {
  if (payload?.code != null && String(payload.code) !== '0') {
    throw new ApiError(502, 'video_provider_error', '视频服务拒绝了请求。');
  }
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

/** Send JSON to the selected provider, never forwarding caller-supplied headers. */
async function modelJSON(model, route, signal, json, limit, timeout) {
  const response = await upstream(model.base + route, { key: model.key, json, signal, timeout });
  return readUpstreamJSON(await requireSuccess(response), limit);
}

/** Convert provider SSE to text deltas while retaining the completed response for session history. */
async function chat({ input, model, signal, history, instructions, delta, progress, skills }) {
  let applied = [];
  let selectionUnavailable = false;
  if (skills.length > 0) {
    try {
      const choice = await modelJSON(model, '/chat/completions', signal, {
        model: model.code, messages: skillSelectionMessages(skills, input.prompt, history), stream: false,
      }, 128 * 1024, 20_000);
      const selection = selectedSkills(choice?.choices?.[0]?.message?.content, skills);
      applied = selection ?? [];
      selectionUnavailable = selection === null;
    } catch {
      signal.throwIfAborted();
      selectionUnavailable = true;
    }
    progress('requesting_model');
  }
  const resultDetails = skills.length > 0 ? { skillIds: applied.map(({ id }) => id) } : {};
  if (selectionUnavailable) resultDetails.skillSelection = 'unavailable';
  const prior = [];
  let remaining = 96_000;
  for (const turn of [...history].reverse()) {
    remaining -= turn.prompt.length + turn.text.length;
    if (remaining < 0) break;
    prior.unshift({ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.text });
  }
  const systemPrompt = [
    instructions,
    ...applied.map((skill) => `## 技能：${skill.name}\n${skill.instructions}`),
  ].filter(Boolean).join('\n\n');
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...prior,
    { role: 'user', content: input.prompt },
  ];
  const response = await requireSuccess(await upstream(model.base + '/chat/completions', {
    key: model.key, signal, timeout: 180_000, json: { model: model.code, messages, stream: true },
  }));
  if (response.headers.get('content-type')?.includes('application/json')) {
    const item = await readUpstreamJSON(response);
    const text = item?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim() || text.length > 256_000) {
      throw new ApiError(502, 'invalid_chat_response', '模型未返回有效的对话文字。');
    }
    delta(text);
    return { text, ...resultDetails };
  }
  if (!response.body) throw new ApiError(502, 'invalid_chat_response', '模型未返回事件流。');
  let pending = '', text = '', bytes = 0, finished = false;
  const decoder = new TextDecoder();
  /** Read an individual upstream event line and require evidence of completion before saving a turn. */
  function consume(line) {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    if (!data) return false;
    let packet;
    try { packet = JSON.parse(data); }
    catch { throw new ApiError(502, 'invalid_chat_stream', '模型返回了无效的事件。'); }
    if (packet?.error) throw new ApiError(502, 'model_stream_error', '模型在生成过程中返回错误。');
    const choice = packet?.choices?.[0];
    finished ||= ['stop', 'length', 'content_filter'].includes(choice?.finish_reason);
    const fragment = choice?.delta?.content;
    if (typeof fragment === 'string' && fragment) {
      text += fragment;
      if (text.length > 256_000) throw new ApiError(502, 'chat_output_too_large', '模型对话结果超过限制。');
      delta(fragment);
    }
    return false;
  }
  loop: for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 8 * MiB) throw new ApiError(502, 'chat_stream_too_large', '模型事件流超过限制。');
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (consume(line)) { finished = true; pending = ''; break loop; }
    }
  }
  finished = consume(pending + decoder.decode()) || finished;
  if (!finished || !text.trim()) throw new ApiError(502, 'incomplete_chat', '对话流中断或模型未返回文字。');
  return { text, ...resultDetails };
}

/** Explicit audio tasks upload the original file as multipart and save the text as an artifact. */
async function transcribe({ input, model, signal, saveArtifact }) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(input.audioBase64, 'base64')], { type: input.mime }), input.filename);
  form.append('model', model.code);
  form.append('response_format', 'json');
  if (input.language) form.append('language', input.language);
  const response = await upstream(model.base + '/audio/transcriptions', {
    key: model.key, body: form, signal, timeout: 300_000,
  });
  const result = await readUpstreamJSON(await requireSuccess(response));
  const text = result?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new ApiError(502, 'invalid_transcript', '语音服务未返回可用文字。');
  }
  const artifact = await saveArtifact('transcript.txt', 'text/plain; charset=utf-8', Buffer.from(text));
  return { text, artifact };
}

/** Preserve the actual format of the returned image when it is saved. */
async function image({ input, model, signal, saveArtifact }) {
  const result = await modelJSON(model, '/images/generations', signal,
    { model: model.code, prompt: input.prompt, size: input.size, n: 1 }, 28 * MiB, 300_000);
  const encoded = result?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 28 * MiB
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ApiError(502, 'invalid_image_response', '图片模型未返回有效的 b64_json。');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const format = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'png'
    : bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'jpeg'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : null;
  if (!format) throw new ApiError(502, 'invalid_image_format', '图片服务未返回 PNG、JPEG 或 WebP 数据。');
  return { artifact: await saveArtifact(`image.${format}`, `image/${format}`, bytes) };
}

/** Retry safe reads only, since a timed-out video submission may have been accepted by the provider. */
async function retryRead(read, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      const transient = error.code === 'upstream_unreachable'
        || [408, 429, 500, 502, 503, 504].includes(error.providerStatus)
        || error.name === 'AbortError' || error.name === 'TimeoutError';
      if (!transient || attempt >= 3) throw error;
      await delay(5_000 * 2 ** attempt, undefined, { signal });
    }
  }
}

/** Use the same OpenAI-style video submit, status and content paths as the desktop. */
async function video({ input, model, signal, progress, saveArtifact, pollInterval }) {
  progress('submitting');
  const submitted = videoData(await modelJSON(model, '/videos', signal, {
    model: model.code, prompt: input.prompt, seconds: input.seconds, size: input.size, input_reference: input.inputReference,
  }));
  const id = submitted?.id ?? submitted?.task_id ?? submitted?.taskId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) {
    throw new ApiError(502, 'video_id_missing', '视频提交状态未知，上游未返回有效任务 ID。');
  }
  const route = '/videos/' + id;
  progress('generating', id);
  for (;;) {
    const statusData = videoData(await retryRead(() => modelJSON(model, route, signal), signal));
    const status = statusData?.status ?? statusData?.task_status;
    if (['completed', 'success', 'succeeded'].includes(status)) break;
    if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) {
      throw new ApiError(502, 'video_provider_failed', '视频服务报告任务失败、已取消或过期。');
    }
    if (!['pending', 'starting', 'queued', 'running', 'in_progress', 'processing'].includes(status)) {
      throw new ApiError(502, 'invalid_video_status', '视频服务返回了未知的任务状态。');
    }
    await delay(pollInterval, undefined, { signal });
  }
  progress('downloading');
  const artifact = await retryRead(async () => {
    const response = await requireSuccess(await upstream(model.base + route + '/content', {
      key: model.key, signal, timeout: 180_000,
    }));
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.body || (type && !['video/mp4', 'application/octet-stream'].includes(type))) {
      await response.body?.cancel();
      throw new ApiError(502, 'invalid_video_content', '视频服务未返回 MP4 内容。');
    }
    return saveArtifact('video.mp4', 'video/mp4', response.body);
  }, signal);
  return { artifact };
}

export const providers = { chat, transcribe, image, video };
