use std::path::Path;

use rusqlite::params;

use super::schema::*;
use super::types::*;

/// 写入一次运行的 token 用量（同 id 覆盖，保证重试不重复累计）
pub fn save_usage(root: &Path, record: &UsageRecord) -> Result<(), String> {
    let (conn, _created) = open(root)?;
    conn.execute(
        "INSERT INTO run_usage \
         (id, conversation_id, project_id, model, prompt_tokens, completion_tokens, \
          reasoning_tokens, total_tokens, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(id) DO UPDATE SET \
         conversation_id = excluded.conversation_id, project_id = excluded.project_id, \
         model = excluded.model, prompt_tokens = excluded.prompt_tokens, \
         completion_tokens = excluded.completion_tokens, \
         reasoning_tokens = excluded.reasoning_tokens, total_tokens = excluded.total_tokens",
        params![
            &record.id,
            &record.conversation_id,
            &record.project_id,
            &record.model,
            &record.prompt_tokens,
            &record.completion_tokens,
            &record.reasoning_tokens,
            &record.total_tokens,
            &record.created_at,
        ],
    )
    .map_err(|error| format!("写入用量记录失败: {error}"))?;
    Ok(())
}

/// 汇总用量：两个过滤条件都为 `None` 时统计全库
///
/// 过滤条件写在 SQL 的 `IS NULL OR` 判断里，不做字符串拼接，空值即「不过滤」。
pub fn summarize_usage(
    root: &Path,
    conversation_id: Option<&str>,
    project_id: Option<&str>,
) -> Result<UsageSummary, String> {
    let (conn, _created) = open(root)?;
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0), \
         COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(total_tokens), 0), MAX(created_at) \
         FROM run_usage \
         WHERE (?1 IS NULL OR conversation_id = ?1) AND (?2 IS NULL OR project_id = ?2)",
        params![conversation_id, project_id],
        |row| {
            Ok(UsageSummary {
                runs: row.get(0)?,
                prompt_tokens: row.get(1)?,
                completion_tokens: row.get(2)?,
                reasoning_tokens: row.get(3)?,
                total_tokens: row.get(4)?,
                last_at: row.get(5)?,
            })
        },
    )
    .map_err(|error| format!("汇总用量失败: {error}"))
}
