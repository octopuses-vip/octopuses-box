use std::path::Path;

use rusqlite::{params, ToSql, Transaction};

use super::schema::*;
use super::types::*;

/// 删除指定作用域下本次未出现的旧行（`id NOT IN` 用参数绑定，不拼字符串）
pub(super) fn delete_missing(
    tx: &Transaction,
    table: &str,
    scope_column: &str,
    scope: &str,
    ids: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        let sql = format!("DELETE FROM {table} WHERE {scope_column} = ?1");
        tx.execute(&sql, params![scope])
            .map_err(|error| format!("清理旧数据失败: {error}"))?;
        return Ok(());
    }
    let placeholders = (0..ids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql =
        format!("DELETE FROM {table} WHERE {scope_column} = ?1 AND id NOT IN ({placeholders})");
    let mut values: Vec<&dyn ToSql> = Vec::with_capacity(ids.len() + 1);
    values.push(&scope);
    for id in ids {
        values.push(id);
    }
    tx.execute(&sql, values.as_slice())
        .map_err(|error| format!("清理旧数据失败: {error}"))?;
    Ok(())
}

/// 写入会话行：upsert 并保留首次写入的 `created_at`
pub(super) fn upsert_conversation(tx: &Transaction, conversation: &StoredConversation) -> Result<(), String> {
    tx.execute(
        "INSERT INTO conversation \
         (id, title, project_id, context_entries, archived, updated_at_label, execution_context, \
          workspace_path, worktree_path, branch, review_comments, created_at, updated_at, sources, \
          agent_id, parent_thread_id, context_summary, context_covered_count) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18) \
         ON CONFLICT(id) DO UPDATE SET \
         title = excluded.title, project_id = excluded.project_id, \
         context_entries = excluded.context_entries, archived = excluded.archived, \
         updated_at_label = excluded.updated_at_label, execution_context = excluded.execution_context, \
         workspace_path = excluded.workspace_path, worktree_path = excluded.worktree_path, \
         branch = excluded.branch, \
         review_comments = excluded.review_comments, updated_at = excluded.updated_at, \
         sources = excluded.sources, agent_id = excluded.agent_id, \
         parent_thread_id = excluded.parent_thread_id, \
         context_summary = excluded.context_summary, \
         context_covered_count = excluded.context_covered_count",
        params![
            &conversation.id,
            &conversation.title,
            &conversation.project_id,
            &conversation.context_entries,
            &conversation.archived,
            &conversation.updated_at_label,
            &conversation.execution_context,
            &conversation.workspace_path,
            &conversation.worktree_path,
            &conversation.branch,
            &conversation.review_comments,
            &conversation.created_at,
            &conversation.updated_at,
            &conversation.sources,
            &conversation.agent_id,
            &conversation.parent_thread_id,
            &conversation.context_summary,
            &conversation.context_covered_count,
        ],
    )
    .map_err(|error| format!("写入会话失败: {error}"))?;
    Ok(())
}

/// 同步某个消息的片段：按 id upsert，并删除该消息下本次未出现的旧片段
pub(super) fn sync_items(tx: &Transaction, message: &StoredMessage) -> Result<(), String> {
    let mut ids = Vec::with_capacity(message.items.len());
    for item in &message.items {
        ids.push(item.id.clone());
        tx.execute(
            "INSERT INTO message_item (id, message_id, seq, kind, payload) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, kind = excluded.kind, \
             payload = excluded.payload",
            params![&item.id, &message.id, &item.seq, &item.kind, &item.payload],
        )
        .map_err(|error| format!("写入消息片段失败: {error}"))?;
    }
    delete_missing(tx, "message_item", "message_id", &message.id, &ids)
}

/// 同步会话的消息：按 id upsert（保留 `created_at`），删除对话中本次未出现的旧消息，
/// 再逐条同步消息片段（被删消息的片段由外键级联清理）
pub(super) fn sync_messages(tx: &Transaction, conversation: &StoredConversation) -> Result<(), String> {
    let created_at = now_unix();
    let mut ids = Vec::with_capacity(conversation.messages.len());
    for message in &conversation.messages {
        ids.push(message.id.clone());
        tx.execute(
            "INSERT INTO message (id, conversation_id, seq, role, attachments, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, role = excluded.role, \
             attachments = excluded.attachments",
            params![
                &message.id,
                &conversation.id,
                &message.seq,
                &message.role,
                &message.attachments,
                &created_at,
            ],
        )
        .map_err(|error| format!("写入消息失败: {error}"))?;
    }
    delete_missing(tx, "message", "conversation_id", &conversation.id, &ids)?;
    for message in &conversation.messages {
        sync_items(tx, message)?;
    }
    Ok(())
}

/// 保存单个会话（会话 + 消息 + 片段），全部在一个事务里完成，不影响其它会话
pub fn save(root: &Path, conversation: &StoredConversation) -> Result<(), String> {
    let (mut conn, _created) = open(root)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("开启事务失败: {error}"))?;
    upsert_conversation(&tx, conversation)?;
    sync_messages(&tx, conversation)?;
    tx.commit()
        .map_err(|error| format!("提交事务失败: {error}"))?;
    Ok(())
}

/// Legacy import and completion marker commit together; clearing history can never reimport old JSON.
pub fn import_legacy(root: &Path, conversations: &[StoredConversation]) -> Result<(), String> {
    let (mut conn, _) = open(root)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let done: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_metadata WHERE key='legacy_json_v1')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !done {
        if count_conversations(&tx)? == 0 {
            for conversation in conversations {
                upsert_conversation(&tx, conversation)?;
                sync_messages(&tx, conversation)?;
            }
        }
        tx.execute(
            "INSERT INTO session_metadata(key,value) VALUES('legacy_json_v1','done')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 删除一个会话及其全部痕迹（开发者 Jan）
///
/// 界面上删除任务、或删除项目时连带删除其下任务，都必须落到库里：否则重启后
/// 会话会从 `octopuses.db` 读回「复活」。消息与片段由外键级联清理，用量记录没有外键，
/// 需要在这里显式删除，避免留下统计到不存在会话的孤儿行。
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let (mut conn, _created) = open(root)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("开启事务失败: {error}"))?;
    tx.execute("DELETE FROM conversation WHERE id = ?1", params![id])
        .map_err(|error| format!("删除会话失败: {error}"))?;
    tx.execute(
        "DELETE FROM run_usage WHERE conversation_id = ?1",
        params![id],
    )
    .map_err(|error| format!("删除会话用量失败: {error}"))?;
    tx.commit()
        .map_err(|error| format!("提交事务失败: {error}"))?;
    Ok(())
}
