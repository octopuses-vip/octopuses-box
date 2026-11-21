//! Read the API's SQLite history without starting or changing the API process.
use crate::{client_api::Endpoint, desktop_api::data_directory};
use rusqlite::{params, Connection, OpenFlags, Row};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

const OWNER: &str = "local-api";
const LIST_PAGE_SIZE: usize = 30;
const TURN_PAGE_SIZE: usize = 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryScope {
    cache_path: String,
    local: bool,
    endpoint: Option<Endpoint>,
    username: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryView {
    Sessions,
    Jobs,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage<T> {
    items: Vec<T>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    id: String,
    model: String,
    agent_id: Option<String>,
    kind: Option<String>,
    preview: Option<String>,
    status: Option<String>,
    updated_at: i64,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredResult {
    text: Option<String>,
    #[serde(default)]
    skill_ids: Vec<String>,
    artifact: Option<HistoryArtifact>,
}

#[derive(Deserialize)]
struct StoredError {
    message: String,
}

#[derive(Serialize, Deserialize)]
pub struct HistoryArtifact {
    name: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTurn {
    id: String,
    prompt: Option<String>,
    status: String,
    created_at: i64,
    text: Option<String>,
    error: Option<String>,
    skill_ids: Vec<String>,
    artifact: Option<HistoryArtifact>,
}

/// Find the same account-specific database as the managed API, without creating empty data.
fn open_history(scope: &HistoryScope) -> Result<Option<Connection>, String> {
    let cache = Path::new(&scope.cache_path);
    if !cache.is_absolute() {
        return Err("缓存目录必须是绝对路径。".to_string());
    }
    let file = data_directory(
        cache,
        scope.local,
        scope.endpoint.as_ref(),
        scope.username.as_deref(),
    )?
    .join("service.db");
    if !file.try_exists().map_err(history_error)? {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(history_error)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(history_error)?;
    Ok(Some(connection))
}

/// Keep internal file names and record contents out of read error messages.
fn history_error(error: impl std::fmt::Display) -> String {
    crate::trace::write(&format!("读取 API 会话失败：{error}"));
    "无法读取 API 会话，请稍后刷新。".to_string()
}

/// Read the extra row used to tell the client whether another page is available.
fn page_of<T>(mut items: Vec<T>, page_size: usize) -> HistoryPage<T> {
    let has_more = items.len() > page_size;
    items.truncate(page_size);
    HistoryPage { items, has_more }
}

/// Use the same summary shape for bound sessions and independent tasks.
fn item_from_row(row: &Row<'_>) -> rusqlite::Result<HistoryItem> {
    Ok(HistoryItem {
        id: row.get(0)?,
        model: row.get(1)?,
        agent_id: row.get(2)?,
        kind: row.get(3)?,
        preview: row.get(4)?,
        status: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// List recent API records in the active cache and account only.
fn list_history(
    scope: &HistoryScope,
    view: HistoryView,
    page: u32,
) -> Result<HistoryPage<HistoryItem>, String> {
    let Some(connection) = open_history(scope)? else {
        return Ok(page_of(Vec::new(), LIST_PAGE_SIZE));
    };
    let query = match view {
        HistoryView::Sessions => "
            SELECT s.id, s.model, s.agent, NULL,
              (SELECT substr(j.prompt, 1, 120) FROM jobs j WHERE j.session_id = s.id AND j.owner = s.owner
               ORDER BY j.created_at, j.rowid LIMIT 1),
              (SELECT j.status FROM jobs j WHERE j.session_id = s.id AND j.owner = s.owner
               ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1),
              COALESCE((SELECT MAX(j.updated_at) FROM jobs j WHERE j.session_id = s.id AND j.owner = s.owner),
                       s.created_at) AS recent
            FROM sessions s WHERE s.owner = ?1 ORDER BY recent DESC, s.id DESC LIMIT ?2 OFFSET ?3",
        HistoryView::Jobs => "
            SELECT id, model, NULL, kind, substr(prompt, 1, 120), status, updated_at
            FROM jobs WHERE owner = ?1 AND session_id IS NULL
            ORDER BY created_at DESC, rowid DESC LIMIT ?2 OFFSET ?3",
    };
    let mut statement = connection.prepare(query).map_err(history_error)?;
    let rows = statement
        .query_map(
            params![
                OWNER,
                LIST_PAGE_SIZE as i64 + 1,
                i64::from(page) * LIST_PAGE_SIZE as i64
            ],
            item_from_row,
        )
        .map_err(history_error)?;
    let records = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(history_error)?;
    Ok(page_of(records, LIST_PAGE_SIZE))
}

/// Extract displayable fields from previous results without returning their raw metadata.
fn turn_from_row(row: &Row<'_>) -> rusqlite::Result<HistoryTurn> {
    let result = row
        .get::<_, Option<String>>(4)?
        .and_then(|source| serde_json::from_str::<StoredResult>(&source).ok())
        .unwrap_or_default();
    let error = row
        .get::<_, Option<String>>(5)?
        .and_then(|source| serde_json::from_str::<StoredError>(&source).ok())
        .map(|value| value.message);
    Ok(HistoryTurn {
        id: row.get(0)?,
        prompt: row.get(1)?,
        status: row.get(2)?,
        created_at: row.get(3)?,
        text: result.text,
        error,
        skill_ids: result.skill_ids,
        artifact: result.artifact,
    })
}

/// Each session page is chronological, and includes failed or unfinished requests as well as replies.
fn read_history(
    scope: &HistoryScope,
    view: HistoryView,
    id: &str,
    page: u32,
) -> Result<HistoryPage<HistoryTurn>, String> {
    let Some(connection) = open_history(scope)? else {
        return Ok(page_of(Vec::new(), TURN_PAGE_SIZE));
    };
    let query = match view {
        HistoryView::Sessions => {
            "
            SELECT j.id, j.prompt, j.status, j.created_at, j.result, j.error
            FROM jobs j JOIN sessions s ON s.id = j.session_id AND s.owner = j.owner
            WHERE j.owner = ?1 AND s.id = ?2
            ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?3 OFFSET ?4"
        }
        HistoryView::Jobs => {
            "
            SELECT id, prompt, status, created_at, result, error FROM jobs
            WHERE owner = ?1 AND id = ?2 AND session_id IS NULL LIMIT ?3 OFFSET ?4"
        }
    };
    let mut statement = connection.prepare(query).map_err(history_error)?;
    let rows = statement
        .query_map(
            params![
                OWNER,
                id,
                TURN_PAGE_SIZE as i64 + 1,
                i64::from(page) * TURN_PAGE_SIZE as i64
            ],
            turn_from_row,
        )
        .map_err(history_error)?;
    let mut result = page_of(
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(history_error)?,
        TURN_PAGE_SIZE,
    );
    result.items.reverse();
    Ok(result)
}

/// Read the history index outside the UI thread.
#[tauri::command]
pub async fn desktop_api_history_list(
    scope: HistoryScope,
    view: HistoryView,
    page: u32,
) -> Result<HistoryPage<HistoryItem>, String> {
    tauri::async_runtime::spawn_blocking(move || list_history(&scope, view, page))
        .await
        .map_err(history_error)?
}

/// Load one page of the selected API session or task without a service token.
#[tauri::command]
pub async fn desktop_api_history_read(
    scope: HistoryScope,
    view: HistoryView,
    id: String,
    page: u32,
) -> Result<HistoryPage<HistoryTurn>, String> {
    tauri::async_runtime::spawn_blocking(move || read_history(&scope, view, &id, page))
        .await
        .map_err(history_error)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sessions_and_unbound_tasks_offline_without_crossing_account_scope() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = Endpoint {
            host: "127.0.0.1".into(),
            port: "8000".into(),
        };
        let mut scope = HistoryScope {
            cache_path: directory.path().to_string_lossy().into_owned(),
            local: false,
            endpoint: Some(endpoint.clone()),
            username: Some("reader-one".into()),
        };
        let path =
            data_directory(directory.path(), false, Some(&endpoint), Some("reader-one")).unwrap();
        assert!(list_history(&scope, HistoryView::Sessions, 0)
            .unwrap()
            .items
            .is_empty());
        assert!(
            !path.exists(),
            "history lookup must not create or start a service"
        );
        std::fs::create_dir_all(&path).unwrap();
        let connection = Connection::open(path.join("service.db")).unwrap();
        connection.execute_batch("
            CREATE TABLE sessions(id TEXT PRIMARY KEY, owner TEXT, model TEXT, agent TEXT, created_at INTEGER);
            CREATE TABLE jobs(id TEXT PRIMARY KEY, owner TEXT, kind TEXT, model TEXT, session_id TEXT,
                              status TEXT, created_at INTEGER, updated_at INTEGER, prompt TEXT, result TEXT, error TEXT);
            INSERT INTO sessions VALUES ('session-a', 'local-api', 'chat', 'editor', 100);
            INSERT INTO sessions VALUES ('hidden', 'another-owner', 'chat', NULL, 200);
            INSERT INTO jobs VALUES ('turn-one', 'local-api', 'chat', 'chat', 'session-a', 'completed',
                         110, 120, 'First request', '{\"text\":\"First reply\",\"skillIds\":[\"editing\"]}', NULL);
            INSERT INTO jobs VALUES ('turn-two', 'local-api', 'chat', 'chat', 'session-a', 'failed',
                         130, 140, 'Second request', NULL, '{\"message\":\"model unavailable\"}');
            INSERT INTO jobs VALUES ('video', 'local-api', 'video', 'video-model', NULL, 'completed', 150, 170,
                         'Create a clip', '{\"artifact\":{\"name\":\"video.mp4\",\"bytes\":42,\"url\":\"/v1/jobs/video/artifact\"}}', NULL);
        ").unwrap();
        drop(connection);

        let list = list_history(&scope, HistoryView::Sessions, 0).unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].preview.as_deref(), Some("First request"));
        assert_eq!(list.items[0].agent_id.as_deref(), Some("editor"));
        assert_eq!(list.items[0].updated_at, 140);
        let history = read_history(&scope, HistoryView::Sessions, "session-a", 0).unwrap();
        assert_eq!(history.items.len(), 2);
        assert_eq!(history.items[0].text.as_deref(), Some("First reply"));
        assert_eq!(history.items[0].skill_ids, ["editing"]);
        assert_eq!(history.items[1].error.as_deref(), Some("model unavailable"));
        let jobs = list_history(&scope, HistoryView::Jobs, 0).unwrap();
        assert_eq!(jobs.items.len(), 1);
        let task = read_history(&scope, HistoryView::Jobs, "video", 0).unwrap();
        assert_eq!(task.items[0].artifact.as_ref().unwrap().bytes, 42);
        assert!(read_history(&scope, HistoryView::Jobs, "turn-one", 0)
            .unwrap()
            .items
            .is_empty());

        scope.username = Some("reader-two".into());
        assert!(list_history(&scope, HistoryView::Sessions, 0)
            .unwrap()
            .items
            .is_empty());
        assert!(read_history(&scope, HistoryView::Sessions, "session-a", 0)
            .unwrap()
            .items
            .is_empty());
    }
}
