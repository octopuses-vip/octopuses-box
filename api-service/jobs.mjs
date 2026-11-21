import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError, failure } from './http.mjs';
import { providers } from './providers.mjs';

export const terminal = new Set(['completed', 'failed', 'cancelled']);

/** Keep account identifiers, provider connection parameters and local paths inside the service. */
export function jobView(row) {
  return {
    id: row.id, type: row.kind, model: row.model, sessionId: row.session_id,
    status: row.status, stage: row.stage, createdAt: row.created_at, updatedAt: row.updated_at,
    upstreamId: row.upstream_id, result: JSON.parse(row.result), error: JSON.parse(row.error),
  };
}

/** Start a bounded queue whose workers can be cancelled without holding a caller's HTTP connection. */
export async function createJobs({ store, directory, concurrency, queueLimit, pollInterval, jobTimeout, skills }) {
  const artifacts = join(directory, 'artifacts');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const waiting = [];
  const running = new Map();
  const events = new EventEmitter().setMaxListeners(0);
  let stopping = false;

  /** Use opaque server-generated names for storage regardless of the artifact's display name. */
  function artifactPath(id) { return join(artifacts, `${id}.bin`); }

  /** Drop partial files after error, cancellation or restart. */
  async function removeFiles(id) {
    await Promise.all([artifactPath(id), join(artifacts, `${id}.part`)].map((path) => rm(path, { force: true })));
  }
  // An interrupted process may have published a complete file before recording completion.
  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    const name = /^([a-f0-9-]{36})\.(bin|part)$/.exec(entry.name);
    if (entry.isFile() && name && (name[2] === 'part' || !store.completed(name[1]))) {
      await rm(join(artifacts, entry.name), { force: true });
    }
  }

  /** Stream large artifacts to a private temporary file and publish only after the full write. */
  async function save(id, name, mime, content, signal) {
    const part = join(artifacts, `${id}.part`);
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) {
          callback(new ApiError(502, 'artifact_too_large', '产物超过 256 MiB。'));
        } else callback(null, chunk);
      },
    });
    try {
      const source = Readable.from(content instanceof Uint8Array ? [content] : content);
      await pipeline(source, meter, createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal });
      if (bytes === 0) throw new ApiError(502, 'empty_artifact', '模型返回的产物为空。');
      signal.throwIfAborted();
      await rename(part, artifactPath(id));
      return { name, mime, bytes, url: `/v1/jobs/${id}/artifact` };
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
  }

  /** Persist status changes before notifying polling or streaming clients. */
  function publish(task, status, stage, data) {
    if (store.update(task.id, status, stage, data)) {
      events.emit(task.id, 'status', jobView(store.job(task.id, task.owner)));
    }
  }

  /** Handle a job from its authorized provider to a durable terminal state. */
  async function execute(task) {
    const deadline = AbortSignal.timeout(jobTimeout);
    const signal = AbortSignal.any([task.controller.signal, deadline]);
    let complete = false;
    try {
      const selectsSkills = task.input.kind === 'chat' && skills.length > 0;
      publish(task, 'running', selectsSkills ? 'selecting_skills' : 'requesting_model');
      const result = await providers[task.input.kind]({
        ...task, signal, pollInterval, skills,
        history: task.session ? store.history(task.session.id) : [],
        instructions: task.session?.instructions ?? task.instructions,
        progress: (stage, upstreamId) => publish(task, 'running', stage, { upstreamId }),
        delta: (text) => events.emit(task.id, 'delta', { text }),
        saveArtifact: (name, mime, content) => save(task.id, name, mime, content, signal),
      });
      signal.throwIfAborted();
      publish(task, 'completed', 'completed', { result });
      complete = true;
    } catch (error) {
      if (!task.controller.signal.aborted) {
        const detail = deadline.aborted || ['AbortError', 'TimeoutError'].includes(error.name)
          ? new ApiError(504, 'job_timeout', '模型响应或任务执行超时。')
          : failure(error);
        publish(task, 'failed', 'failed', { error: { code: detail.code, message: detail.message } });
      }
    } finally {
      if (!complete) await removeFiles(task.id);
    }
  }

  /** Maintain FIFO ordering while allowing independent sessions to run concurrently. */
  function drain() {
    while (!stopping && waiting.length && running.size < concurrency) {
      const task = waiting.shift();
      const done = execute(task).catch((error) => {
        console.error('任务状态或产物清理失败', task.id, error.code ?? error.name);
      }).finally(() => {
        running.delete(task.id);
        drain();
      });
      running.set(task.id, { task, done });
    }
  }

  return {
    artifactPath,
    /** Admit a job before starting any billable request. */
    submit(owner, input, model, session, instructions) {
      if (stopping || waiting.length + running.size >= queueLimit) {
        throw new ApiError(503, 'queue_full', '任务队列已满，请稍后重试。');
      }
      const id = randomUUID();
      const row = store.createJob(id, owner, input.kind, model.code, session?.id ?? null,
        input.prompt ?? null);
      waiting.push({ id, owner, input, model, session, instructions, controller: new AbortController() });
      queueMicrotask(drain);
      return jobView(row);
    },
    /** Cancel local processing immediately and ignore late upstream responses. */
    cancel(row) {
      if (terminal.has(row.status)) return jobView(row);
      publish(row, 'cancelled', 'cancelled');
      const index = waiting.findIndex((item) => item.id === row.id);
      if (index !== -1) waiting.splice(index, 1);
      running.get(row.id)?.task.controller.abort();
      return jobView(store.job(row.id, row.owner));
    },
    /** Attach an event stream to a task that the server has already authorized. */
    subscribe(id, listener) {
      events.on(id, listener);
      return () => events.off(id, listener);
    },
    /** Settle outstanding jobs before closing the database and releasing the service lock. */
    async close() {
      stopping = true;
      for (const task of [...waiting, ...[...running.values()].map(({ task }) => task)]) {
        publish(task, 'failed', 'failed', { error: { code: 'service_stopped', message: '服务停止打断了此任务。' } });
        task.controller.abort();
      }
      waiting.length = 0;
      await Promise.all([...running.values()].map(({ done }) => done));
    },
  };
}
