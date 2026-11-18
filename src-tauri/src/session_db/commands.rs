use std::path::Path;

use super::read::*;
use super::schema::*;
use super::types::*;
use super::usage::*;
use super::write::*;

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 session_db_list 的单一职责，并返回可供调用方继续处理的结果。
pub fn session_db_list(cache_dir: String) -> Result<Vec<StoredConversation>, String> {
    read_conversations(Path::new(&cache_dir), None, false)
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 session_db_get 的单一职责，并返回可供调用方继续处理的结果。
pub fn session_db_get(cache_dir: String, id: String) -> Result<Option<StoredConversation>, String> {
    Ok(read_conversations(Path::new(&cache_dir), Some(&id), true)?
        .into_iter()
        .next())
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 session_db_import_legacy 的单一职责，并返回可供调用方继续处理的结果。
pub fn session_db_import_legacy(
    cache_dir: String,
    conversations: Vec<StoredConversation>,
) -> Result<(), String> {
    import_legacy(Path::new(&cache_dir), &conversations)
}

/// 确保会话库就绪（目录 / 库不存在则创建并建表）
#[tauri::command]
pub fn session_db_ensure(cache_dir: String) -> Result<SessionDbInfo, String> {
    ensure(Path::new(&cache_dir))
}

/// 全量读取会话库
#[tauri::command]
pub fn session_db_load(cache_dir: String) -> Result<Vec<StoredConversation>, String> {
    load(Path::new(&cache_dir))
}

/// 保存单个会话到会话库
#[tauri::command]
pub fn session_db_save(cache_dir: String, conversation: StoredConversation) -> Result<(), String> {
    save(Path::new(&cache_dir), &conversation)
}

/// 从会话库删除单个会话（会话 + 消息 + 片段 + 用量）
#[tauri::command]
pub fn session_db_delete(cache_dir: String, id: String) -> Result<(), String> {
    delete(Path::new(&cache_dir), &id)
}

/// 记录一次运行的 token 用量
#[tauri::command]
pub fn usage_record(cache_dir: String, record: UsageRecord) -> Result<(), String> {
    save_usage(Path::new(&cache_dir), &record)
}

/// 汇总 token 用量；会话与项目过滤条件可省略（省略即不按该维度过滤）
#[tauri::command]
pub fn usage_summary(
    cache_dir: String,
    conversation_id: Option<String>,
    project_id: Option<String>,
) -> Result<UsageSummary, String> {
    summarize_usage(
        Path::new(&cache_dir),
        conversation_id.as_deref(),
        project_id.as_deref(),
    )
}

/// Restore jobs independently of the lazy-loaded conversation and selected answer version.
#[tauri::command]
pub fn video_jobs(cache_dir: String) -> Result<Vec<String>, String> {
    let (db, _) = open(Path::new(&cache_dir))?;
    let mut query = db.prepare("SELECT payload FROM video_job").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Reserve a submission before contacting the provider. Updates cannot recreate a deleted job.
#[tauri::command]
pub fn video_save_job(cache_dir: String, thread_id: String, id: String, payload: String, create: bool) -> Result<(), String> {
    let (db, _) = open(Path::new(&cache_dir))?;
    let sql = if create {
        "INSERT INTO video_job (payload, id, conversation_id) VALUES (?1, ?2, ?3)"
    } else {
        "UPDATE video_job SET payload = ?1 WHERE id = ?2 AND conversation_id = ?3"
    };
    let count = db.execute(sql, rusqlite::params![payload, id, thread_id]).map_err(|e| e.to_string())?;
    if count == 0 { return Err("视频任务已移除".into()); }
    Ok(())
}
