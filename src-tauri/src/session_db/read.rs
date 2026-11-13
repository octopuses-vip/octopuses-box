use std::path::Path;

use rusqlite::{Connection, params};

use super::schema::*;
use super::types::*;

/// 读取某个会话下的全部消息（按 `seq` 升序）
pub(super) fn load_messages(conn: &Connection, conversation_id: &str) -> Result<Vec<StoredMessage>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, role, seq, attachments FROM message \
             WHERE conversation_id = ?1 ORDER BY seq ASC, rowid ASC",
        )
        .map_err(|error| format!("查询消息失败: {error}"))?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                seq: row.get(2)?,
                attachments: row.get(3)?,
                items: Vec::new(),
            })
        })
        .map_err(|error| format!("读取消息失败: {error}"))?;
    let mut messages = Vec::new();
    for row in rows {
        let mut message = row.map_err(|error| format!("读取消息行失败: {error}"))?;
        message.items = load_items(conn, &message.id)?;
        messages.push(message);
    }
    Ok(messages)
}

/// 读取某条消息下的全部片段（按 `seq` 升序）
pub(super) fn load_items(conn: &Connection, message_id: &str) -> Result<Vec<StoredItem>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, seq, kind, payload FROM message_item \
             WHERE message_id = ?1 ORDER BY seq ASC, rowid ASC",
        )
        .map_err(|error| format!("查询消息片段失败: {error}"))?;
    let rows = statement
        .query_map(params![message_id], |row| {
            Ok(StoredItem {
                id: row.get(0)?,
                seq: row.get(1)?,
                kind: row.get(2)?,
                payload: row.get(3)?,
            })
        })
        .map_err(|error| format!("读取消息片段失败: {error}"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| format!("读取消息片段行失败: {error}"))?);
    }
    Ok(items)
}

/// 全量读回会话：会话按 `created_at` 升序（同一时间按 rowid 稳定），
/// 消息按 `seq` 升序，片段按 `seq` 升序
pub(super) fn read_conversations(
    root: &Path,
    id: Option<&str>,
    include_messages: bool,
) -> Result<Vec<StoredConversation>, String> {
    let (conn, _created) = open(root)?;
    let mut statement = conn
        .prepare(
            "SELECT id, title, project_id, context_entries, archived, updated_at_label, \
             execution_context, workspace_path, worktree_path, branch, review_comments, \
             created_at, updated_at, sources, agent_id, parent_thread_id, \
             context_summary, context_covered_count \
            FROM conversation WHERE (?1 IS NULL OR id = ?1) ORDER BY created_at ASC, rowid ASC",
        )
        .map_err(|error| format!("查询会话失败: {error}"))?;
    let rows = statement
        .query_map(params![id], |row| {
            Ok(StoredConversation {
                id: row.get(0)?,
                title: row.get(1)?,
                project_id: row.get(2)?,
                context_entries: row.get(3)?,
                archived: row.get(4)?,
                updated_at_label: row.get(5)?,
                execution_context: row.get(6)?,
                workspace_path: row.get(7)?,
                worktree_path: row.get(8)?,
                branch: row.get(9)?,
                review_comments: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                sources: row.get(13)?,
                agent_id: row.get(14)?,
                parent_thread_id: row.get(15)?,
                context_summary: row.get(16)?,
                context_covered_count: row.get(17)?,
                messages: Vec::new(),
            })
        })
        .map_err(|error| format!("读取会话失败: {error}"))?;
    let mut conversations = Vec::new();
    for row in rows {
        let mut conversation = row.map_err(|error| format!("读取会话行失败: {error}"))?;
        if include_messages {
            conversation.messages = load_messages(&conn, &conversation.id)?;
        }
        conversations.push(conversation);
    }
    Ok(conversations)
}

/// 函数级说明（开发者 Jan）：执行 load 的单一职责，并返回可供调用方继续处理的结果。
pub fn load(root: &Path) -> Result<Vec<StoredConversation>, String> {
    read_conversations(root, None, true)
}
