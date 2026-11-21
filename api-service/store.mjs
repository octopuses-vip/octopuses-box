import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from './http.mjs';

/** Create owner-only databases before SQLite opens them. */
function openDatabase(directory, name) {
  const file = join(directory, name);
  closeSync(openSync(file, 'a', 0o600));
  return new DatabaseSync(file);
}

/** Keep task results and conversation history in one database. A separate lock protects restart recovery. */
export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = openDatabase(directory, 'process.db');
  let db;
  try {
    lock.exec('BEGIN EXCLUSIVE');
    db = openDatabase(directory, 'service.db');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, model TEXT NOT NULL, agent TEXT, instructions TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id), status TEXT NOT NULL, stage TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        prompt TEXT, result TEXT, error TEXT, upstream_id TEXT
      );
      CREATE INDEX IF NOT EXISTS session_turns ON jobs (session_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS desktop_job_history ON jobs (owner, session_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS session_active ON jobs (session_id)
        WHERE session_id IS NOT NULL AND status IN ('queued', 'running');
    `);
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }
  db.prepare(`
    UPDATE jobs SET status='failed', stage='failed', updated_at=?, error=?
    WHERE status IN ('queued', 'running')
  `).run(Date.now(), JSON.stringify({ code: 'service_restarted', message: '服务重启打断了此任务。' }));
  const sessionById = db.prepare('SELECT * FROM sessions WHERE id = ? AND owner = ?');
  const jobById = db.prepare('SELECT * FROM jobs WHERE id = ? AND owner = ?');
  const turns = db.prepare(`
    SELECT id, prompt, result FROM jobs WHERE session_id = ? AND status = 'completed'
    ORDER BY created_at DESC, rowid DESC LIMIT 20
  `);
  const active = db.prepare("SELECT 1 FROM jobs WHERE session_id = ? AND status IN ('queued', 'running')");
  const completed = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND status = 'completed'");
  const insertSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)');
  const insertJob = db.prepare(`
    INSERT INTO jobs(id, owner, kind, model, session_id, status, stage, created_at, updated_at, prompt)
    VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE jobs SET status=?, stage=?, updated_at=?, result=?, error=?, upstream_id=COALESCE(?, upstream_id)
    WHERE id=? AND status IN ('queued', 'running')
  `);

  return {
    /** An output file is valid only after its job reached the durable completed state. */
    completed(id) { return Boolean(completed.get(id)); },
    /** Sessions keep the selected model and Agent instructions stable over subsequent turns. */
    createSession(id, owner, model, agent, instructions) {
      insertSession.run(id, owner, model, agent, instructions, Date.now());
      return sessionById.get(id, owner);
    },
    /** Look up sessions in the caller's authorized data scope. */
    session(id, owner) { return sessionById.get(id, owner); },
    /** Load a bounded, ordered session history for display and inference. */
    history(id) {
      return turns.all(id).reverse().map((row) => ({ jobId: row.id, prompt: row.prompt, text: JSON.parse(row.result).text }));
    },
    /** Serialize turns per session so concurrent requests cannot use stale conversation history. */
    createJob(id, owner, kind, model, sessionId, prompt) {
      if (sessionId && active.get(sessionId)) throw new ApiError(409, 'session_busy', '该会话已有任务在等待或执行。');
      const now = Date.now();
      insertJob.run(id, owner, kind, model, sessionId, now, now, prompt);
      return jobById.get(id, owner);
    },
    /** A job is visible only within its data scope. */
    job(id, owner) { return jobById.get(id, owner); },
    /** Never overwrite a terminal status with a late provider response. */
    update(id, status, stage, { result, error, upstreamId } = {}) {
      return update.run(status, stage, Date.now(), result ? JSON.stringify(result) : null,
        error ? JSON.stringify(error) : null, upstreamId ?? null, id).changes > 0;
    },
    /** Release the process lock once requests and pending writes have ended. */
    close() { db.close(); lock.close(); },
  };
}
