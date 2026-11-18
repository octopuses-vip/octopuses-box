use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use super::types::*;

/// SQLite 库文件名（固定放在缓存目录根部）
pub(super) const DB_FILE: &str = "octopuses.db";

/// 建表语句（`CREATE TABLE IF NOT EXISTS`，每次打开连接都执行，保证幂等）
pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  context_entries TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at_label TEXT NOT NULL DEFAULT '',
  execution_context TEXT NOT NULL DEFAULT 'local',
  workspace_path TEXT,
  worktree_path TEXT,
  branch TEXT,
  review_comments TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  parent_thread_id TEXT,
  context_summary TEXT NOT NULL DEFAULT '',
  context_covered_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS video_job (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  attachments TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_conversation ON message(conversation_id, seq);
CREATE TABLE IF NOT EXISTS message_item (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_item_message ON message_item(message_id, seq);
CREATE TABLE IF NOT EXISTS run_usage (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_usage_conversation ON run_usage(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_usage_project ON run_usage(project_id, created_at);
";

/// 当前 Unix 时间戳（秒）
pub(super) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// 打开库文件并保证表结构就绪，返回连接与「本次调用前库文件是否已存在」
///
/// 会自动建好父目录；`PRAGMA foreign_keys` 逐连接生效，故每次打开都要开启，
/// 以便消息 / 片段删除时触发级联清理。
pub(super) fn ensure_conversation_columns(conn: &Connection) -> Result<(), String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(conversation)")
        .map_err(|error| format!("读取会话表结构失败: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取会话表字段失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析会话表字段失败: {error}"))?;
    let migrations = [
        (
            "context_entries",
            "ALTER TABLE conversation ADD COLUMN context_entries TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "sources",
            "ALTER TABLE conversation ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "execution_context",
            "ALTER TABLE conversation ADD COLUMN execution_context TEXT NOT NULL DEFAULT 'local'",
        ),
        (
            "workspace_path",
            "ALTER TABLE conversation ADD COLUMN workspace_path TEXT",
        ),
        (
            "worktree_path",
            "ALTER TABLE conversation ADD COLUMN worktree_path TEXT",
        ),
        ("branch", "ALTER TABLE conversation ADD COLUMN branch TEXT"),
        (
            "review_comments",
            "ALTER TABLE conversation ADD COLUMN review_comments TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "agent_id",
            "ALTER TABLE conversation ADD COLUMN agent_id TEXT",
        ),
        (
            "parent_thread_id",
            "ALTER TABLE conversation ADD COLUMN parent_thread_id TEXT",
        ),
        (
            "context_summary",
            "ALTER TABLE conversation ADD COLUMN context_summary TEXT NOT NULL DEFAULT ''",
        ),
        (
            "context_covered_count",
            "ALTER TABLE conversation ADD COLUMN context_covered_count INTEGER NOT NULL DEFAULT 0",
        ),
    ];
    for (column, sql) in migrations {
        if !columns.iter().any(|item| item == column) {
            conn.execute(sql, [])
                .map_err(|error| format!("迁移会话字段 {column} 失败: {error}"))?;
        }
    }
    Ok(())
}

/// 打开（必要时创建）会话数据库（开发者 Jan），返回连接与「是否已存在」标记。
///
/// 第二个返回值供调用方区分「首次建库」与「读回旧库」：
/// 首次建库时不该用空数据覆盖掉界面上的初始演示会话。
pub(super) fn open(root: &Path) -> Result<(Connection, bool), String> {
    let path = root.join(DB_FILE);
    let existed = path.is_file();
    fs::create_dir_all(root).map_err(|error| format!("创建缓存目录失败: {error}"))?;
    let conn = Connection::open(&path).map_err(|error| format!("打开数据库失败: {error}"))?;
    let pragmas_and_schema =
        format!("PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\n{SCHEMA}");
    conn.execute_batch(&pragmas_and_schema)
        .map_err(|error| format!("初始化数据库表失败: {error}"))?;
    ensure_conversation_columns(&conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    Ok((conn, existed))
}

/// 统计库中会话数量
pub(super) fn count_conversations(conn: &Connection) -> Result<usize, String> {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversation", [], |row| row.get(0))
        .map_err(|error| format!("统计会话数量失败: {error}"))?;
    Ok(total.max(0) as usize)
}

/// 确保缓存目录与库文件、表结构就绪（幂等）
///
/// 目录 / 库不存在则创建并建表；已存在也要建表，并返回 `created = false` 与当前会话数。
pub fn ensure(root: &Path) -> Result<SessionDbInfo, String> {
    let (conn, existed) = open(root)?;
    let conversations = count_conversations(&conn)?;
    Ok(SessionDbInfo {
        path: root.join(DB_FILE).to_string_lossy().into_owned(),
        created: !existed,
        conversations,
        legacy_migrated: conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session_metadata WHERE key='legacy_json_v1')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?,
    })
}
