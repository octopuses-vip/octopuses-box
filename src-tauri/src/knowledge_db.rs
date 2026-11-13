//! 用户文档与历史对话的独立知识库。正文不依赖向量模型，向量可随时补建与重建。
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufWriter, Write},
    path::Path,
    time::Duration,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    kind: String,
    title: String,
    thread_id: Option<String>,
    body: String,
    messages: Vec<Message>,
    updated_at: i64,
    hash: String,
}
#[derive(Serialize, Deserialize)]
struct Message {
    id: String,
    role: String,
    content: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    id: String,
    source_id: String,
    message_id: Option<String>,
    ordinal: i64,
    text: String,
    hash: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    id: String,
    source_id: String,
    title: String,
    kind: String,
    thread_id: Option<String>,
    message_id: Option<String>,
    text: String,
    score: f64,
    r#match: String,
}

/// 函数级说明（开发者 Jan）：执行 open 的单一职责，并返回可供调用方继续处理的结果。
fn open(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let conn = Connection::open(root.join("knowledge.db")).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS kb_source (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, thread_id TEXT,
          body TEXT NOT NULL, messages TEXT NOT NULL, updated_at INTEGER NOT NULL, hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kb_chunk (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES kb_source(id) ON DELETE CASCADE,
          message_id TEXT, ordinal INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
          vector BLOB, model TEXT);
        CREATE INDEX IF NOT EXISTS kb_chunk_source ON kb_chunk(source_id, ordinal);
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(text, content='kb_chunk', content_rowid='rowid', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS kb_insert AFTER INSERT ON kb_chunk BEGIN
          INSERT INTO kb_fts(rowid,text) VALUES(new.rowid,new.text); END;
        CREATE TRIGGER IF NOT EXISTS kb_delete AFTER DELETE ON kb_chunk BEGIN
          INSERT INTO kb_fts(kb_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
        CREATE TRIGGER IF NOT EXISTS kb_update AFTER UPDATE OF text ON kb_chunk BEGIN
          INSERT INTO kb_fts(kb_fts,rowid,text) VALUES('delete',old.rowid,old.text);
          INSERT INTO kb_fts(rowid,text) VALUES(new.rowid,new.text); END;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 函数级说明（开发者 Jan）：执行 field 的单一职责，并返回可供调用方继续处理的结果。
fn field<'a>(action: &'a Value, key: &str) -> Result<&'a str, String> {
    action
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少字段 {key}"))
}

/// 函数级说明（开发者 Jan）：执行 source_row 的单一职责，并返回可供调用方继续处理的结果。
fn source_row(row: &Row<'_>) -> rusqlite::Result<Source> {
    let messages: String = row.get(5)?;
    Ok(Source {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        thread_id: row.get(3)?,
        body: row.get(4)?,
        messages: serde_json::from_str(&messages).unwrap_or_default(),
        updated_at: row.get(6)?,
        hash: row.get(7)?,
    })
}

/// 函数级说明（开发者 Jan）：执行 hit_row 的单一职责，并返回可供调用方继续处理的结果。
fn hit_row(row: &Row<'_>) -> rusqlite::Result<Hit> {
    Ok(Hit {
        id: row.get(0)?,
        source_id: row.get(1)?,
        title: row.get(2)?,
        kind: row.get(3)?,
        thread_id: row.get(4)?,
        message_id: row.get(5)?,
        text: row.get(6)?,
        score: 0.0,
        r#match: "keyword".into(),
    })
}
const HIT_SELECT: &str = "SELECT c.id,c.source_id,s.title,s.kind,s.thread_id,c.message_id,c.text FROM kb_chunk c JOIN kb_source s ON s.id=c.source_id";

/// 函数级说明（开发者 Jan）：执行 put 的单一职责，并返回可供调用方继续处理的结果。
fn put(conn: &mut Connection, source: Source, chunks: Vec<Chunk>) -> Result<Value, String> {
    if !["conversation", "document"].contains(&source.kind.as_str())
        || source.body.len() > 32 * 1024 * 1024
        || chunks.len() > 150_000
        || source
            .messages
            .iter()
            .any(|m| !["user", "assistant"].contains(&m.role.as_str()))
    {
        return Err("知识库资料格式无效或内容过大".into());
    }
    if chunks.iter().any(|c| {
        c.source_id != source.id
            || !c.id.starts_with(&format!("{}:", source.id))
            || c.text.len() > 8192
            || c.ordinal < 0
    }) {
        return Err("知识库分块格式无效".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO kb_source VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,title=excluded.title,thread_id=excluded.thread_id,body=excluded.body,
        messages=excluded.messages,updated_at=excluded.updated_at,hash=excluded.hash",
        params![
            source.id,
            source.kind,
            source.title,
            source.thread_id,
            source.body,
            serde_json::to_string(&source.messages).map_err(|e| e.to_string())?,
            source.updated_at,
            source.hash
        ],
    )
    .map_err(|e| e.to_string())?;
    let existing: Vec<String> = tx
        .prepare("SELECT id FROM kb_chunk WHERE source_id=?1")
        .map_err(|e| e.to_string())?
        .query_map([&source.id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let ids: HashSet<_> = chunks.iter().map(|c| c.id.as_str()).collect();
    for id in existing {
        if !ids.contains(id.as_str()) {
            tx.execute("DELETE FROM kb_chunk WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        }
    }
    for c in &chunks {
        tx.execute("INSERT INTO kb_chunk(id,source_id,message_id,ordinal,text,hash) VALUES(?1,?2,?3,?4,?5,?6)
            ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id,ordinal=excluded.ordinal,text=excluded.text,
            vector=CASE WHEN kb_chunk.hash=excluded.hash THEN kb_chunk.vector ELSE NULL END,
            model=CASE WHEN kb_chunk.hash=excluded.hash THEN kb_chunk.model ELSE NULL END,hash=excluded.hash",
            params![c.id,c.source_id,c.message_id,c.ordinal,c.text,c.hash]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!(true))
}

/// 函数级说明（开发者 Jan）：执行 vector 的单一职责，并返回可供调用方继续处理的结果。
fn vector(action: &Value) -> Result<Vec<f32>, String> {
    let values: Vec<f32> =
        serde_json::from_value(action["vector"].clone()).map_err(|e| e.to_string())?;
    if values.len() != 512
        || values.iter().any(|v| !v.is_finite())
        || values.iter().all(|v| *v == 0.0)
    {
        return Err("向量必须为 512 维有限数值，且不能全为零".into());
    }
    Ok(values)
}

/// 提取用于 trigram FTS 的关键词：ASCII 连续词（≥3 字符）与中文三字窗口。
///
/// trigram 分词器不支持小于 3 字符的检索词，所以中文按三字滑窗切分；上限 24 个，
/// 避免长问题拼出过长的 MATCH 表达式。
fn match_terms(query: &str) -> Vec<String> {
    fn push(terms: &mut Vec<String>, term: &str) {
        if terms.len() < 24 && term.chars().count() >= 3 && !terms.iter().any(|t| t == term) {
            terms.push(term.to_string());
        }
    }
    fn flush(terms: &mut Vec<String>, ascii: &mut String, cjk: &mut Vec<char>) {
        push(terms, ascii);
        ascii.clear();
        for window in cjk.windows(3) {
            push(terms, &window.iter().collect::<String>());
        }
        cjk.clear();
    }
    let mut terms = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();
    for ch in query.chars() {
        let code = ch as u32;
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
            for window in cjk.windows(3) {
                push(&mut terms, &window.iter().collect::<String>());
            }
            cjk.clear();
            ascii.push(ch);
        } else if (0x3400..=0x4DBF).contains(&code) || (0x4E00..=0x9FFF).contains(&code) {
            push(&mut terms, &ascii);
            ascii.clear();
            cjk.push(ch);
        } else {
            flush(&mut terms, &mut ascii, &mut cjk);
        }
    }
    flush(&mut terms, &mut ascii, &mut cjk);
    terms
}

/// 函数级说明（开发者 Jan）：执行 search 的单一职责，并返回可供调用方继续处理的结果。
fn search(conn: &Connection, action: &Value) -> Result<Value, String> {
    let query = field(action, "query")?.trim();
    if query.is_empty() {
        return Ok(json!([]));
    }
    if query.chars().count() > 512 {
        return Err("搜索内容请控制在 512 字以内".into());
    }
    let kind = field(action, "kind")?;
    let mut hits: HashMap<String, Hit> = HashMap::new();
    let mut keyword = Vec::new();
    // 关键词与语义并行召回：向量只覆盖「已索引」分块，FTS 能补上刚导入、尚未 embedding 的内容。
    if !action["vector"].is_null() {
        let terms = match_terms(query);
        if !terms.is_empty() {
            let expression = terms
                .iter()
                .map(|term| format!("\"{term}\""))
                .collect::<Vec<_>>()
                .join(" OR ");
            let sql = format!("{HIT_SELECT} JOIN kb_fts f ON f.rowid=c.rowid WHERE kb_fts MATCH ?1 AND (?2='' OR s.kind=?2) ORDER BY bm25(kb_fts),c.id LIMIT 60");
            keyword.extend(
                conn.prepare(&sql)
                    .map_err(|e| e.to_string())?
                    .query_map(params![expression, kind], hit_row)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            );
        }
    } else if query.chars().count() >= 3 {
        let sql = format!("{HIT_SELECT} JOIN kb_fts f ON f.rowid=c.rowid WHERE kb_fts MATCH ?1 AND (?2='' OR s.kind=?2) ORDER BY bm25(kb_fts),c.id LIMIT 60");
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        keyword.extend(
            conn.prepare(&sql)
                .map_err(|e| e.to_string())?
                .query_map(params![phrase, kind], hit_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        );
    }
    if action["vector"].is_null() {
        let sql = format!("{HIT_SELECT} WHERE (instr(lower(s.title),lower(?1))>0 OR (?3 AND instr(lower(c.text),lower(?1))>0)) AND (?2='' OR s.kind=?2) ORDER BY s.updated_at DESC,c.ordinal,c.id LIMIT 60");
        keyword.extend(
            conn.prepare(&sql)
                .map_err(|e| e.to_string())?
                .query_map(params![query, kind, query.chars().count() < 3], hit_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        );
    }
    if !action["vector"].is_null() {
        let query_vector = vector(action)?;
        let qnorm = query_vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        // 单独列出向量列，避免对历史消息文本进行全量反序列化。
        let mut stmt = conn.prepare("SELECT c.id,c.source_id,s.title,s.kind,s.thread_id,c.message_id,c.text,c.vector FROM kb_chunk c JOIN kb_source s ON s.id=c.source_id WHERE c.model=?1 AND c.vector IS NOT NULL AND (?2='' OR s.kind=?2)").map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![field(action, "model")?, kind])
            .map_err(|e| e.to_string())?;
        let mut semantic = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let raw: Vec<u8> = row.get(7).map_err(|e| e.to_string())?;
            if raw.len() != 512 * 4 {
                continue;
            }
            let values: Vec<f32> = raw
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
            if norm == 0.0 {
                continue;
            }
            let score = values
                .iter()
                .zip(&query_vector)
                .map(|(a, b)| a * b)
                .sum::<f32>()
                / (norm * qnorm);
            if score.is_finite() && score >= 0.4 {
                semantic.push((score, hit_row(row).map_err(|e| e.to_string())?));
            }
        }
        semantic.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
        for (rank, (_, mut hit)) in semantic.into_iter().enumerate() {
            hit.score = 1.0 / (60.0 + rank as f64);
            hit.r#match = "semantic".into();
            hits.insert(hit.id.clone(), hit);
        }
    }
    // 关键词结果在语义之后合并：带向量时只补「语义完全没覆盖的来源」，
    // 这样未建索引、向量失效的文档仍能被召回，同时不会打乱已命中来源的排序。
    let covered: HashSet<String> = hits.values().map(|hit| hit.source_id.clone()).collect();
    let supplement_only = !action["vector"].is_null();
    for (rank, mut hit) in keyword.into_iter().enumerate() {
        if supplement_only && covered.contains(&hit.source_id) {
            continue;
        }
        hit.score = 1.0 / (60.0 + rank as f64);
        hits.entry(hit.id.clone()).or_insert(hit);
    }
    let mut result: Vec<_> = hits.into_values().collect();
    result.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    // 每个会话/文档保留最佳片段及其跳转位置；来源聚合必须发生在结果限额之前。
    let mut seen = HashSet::new();
    result.retain(|hit| {
        let source = if hit.kind == "conversation" {
            hit.thread_id.as_ref().unwrap_or(&hit.source_id)
        } else {
            &hit.source_id
        };
        seen.insert((hit.kind.clone(), source.clone()))
    });
    result.truncate(60);
    serde_json::to_value(result).map_err(|e| e.to_string())
}

// Prepared export snapshots are transient: never insert reviewed content into the knowledge index.
fn export_sources(conn: &Connection, action: &Value) -> Result<Vec<Source>, String> {
    if let Some(sources) = action.get("sources") {
        let sources: Vec<Source> =
            serde_json::from_value(sources.clone()).map_err(|e| e.to_string())?;
        let mut ids = HashSet::new();
        if sources.iter().any(|s| {
            !ids.insert(s.id.clone())
                || !["conversation", "document"].contains(&s.kind.as_str())
                || s.messages
                    .iter()
                    .any(|m| !["user", "assistant"].contains(&m.role.as_str()))
        }) {
            return Err("无效的导出数据".into());
        }
        return Ok(sources);
    }
    let mut stmt = conn
        .prepare("SELECT * FROM kb_source ORDER BY updated_at,id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], source_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// 函数级说明（开发者 Jan）：执行 export 的单一职责，并返回可供调用方继续处理的结果。
fn export(conn: &Connection, action: &Value) -> Result<Value, String> {
    let format = field(action, "format")?;
    if !["messages", "alpaca", "sharegpt", "documents"].contains(&format) {
        return Err("未知导出格式".into());
    }
    let path = Path::new(field(action, "path")?);
    let name = path.file_name().ok_or("无效导出路径")?.to_string_lossy();
    let staging = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    let result = (|| {
        let mut writer = BufWriter::new(fs::File::create(&staging).map_err(|e| e.to_string())?);
        let sources = export_sources(conn, action)?;
        let mut count = 0;
        let mut skipped = 0;
        for source in sources {
            let line = if format != "documents" {
                if source.kind != "conversation" {
                    continue;
                }
                let messages = training_messages(&source.messages);
                if messages.is_empty() {
                    skipped += 1;
                    continue;
                }
                match format {
                    "sharegpt" => {
                        json!({"conversations":messages.iter().map(|m| json!({"from":if m["role"]=="user" {"human"} else {"gpt"},"value":m["content"]})).collect::<Vec<_>>()})
                    }
                    "alpaca" => json!({"instruction":messages[messages.len()-2]["content"],
                        "input":messages[..messages.len()-2].iter().map(|m|format!("{}：{}",if m["role"]=="user" {"用户"} else {"助手"},m["content"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n\n"),
                        "output":messages[messages.len()-1]["content"]}),
                    _ => json!({"messages":messages}),
                }
            } else {
                if source.kind != "document" {
                    continue;
                }
                json!({"id":source.id,"title":source.title,"text":source.body})
            };
            serde_json::to_writer(&mut writer, &line).map_err(|e| e.to_string())?;
            writer.write_all(b"\n").map_err(|e| e.to_string())?;
            count += 1;
        }
        writer.flush().map_err(|e| e.to_string())?;
        writer.get_ref().sync_all().map_err(|e| e.to_string())?;
        drop(writer);
        if count == 0 {
            return Err("没有可导出的有效数据".into());
        }
        fs::rename(&staging, path).map_err(|e| e.to_string())?;
        Ok(json!({"count":count,"skipped":skipped}))
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

/// 函数级说明（开发者 Jan）：执行 training_messages 的单一职责，并返回可供调用方继续处理的结果。
fn training_messages(messages: &[Message]) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for message in messages {
        if message.content.trim().is_empty() || (result.is_empty() && message.role != "user") {
            continue;
        }
        if let Some(last) = result.last_mut().filter(|v| v["role"] == message.role) {
            last["content"] = json!(format!(
                "{}\n\n{}",
                last["content"].as_str().unwrap_or(""),
                message.content
            ));
        } else {
            result.push(json!({"role":message.role,"content":message.content}));
        }
    }
    if result.last().is_some_and(|v| v["role"] == "user") {
        result.pop();
    }
    result
}

/// 函数级说明（开发者 Jan）：执行 markdown_inline 的单一职责，并返回可供调用方继续处理的结果。
fn markdown_inline(text: &str) -> String {
    let mut result = String::new();
    for mut ch in text.chars() {
        if matches!(ch, '\n' | '\r' | '\t') {
            ch = ' ';
        }
        if "\\`*_{}[]()#+.!<>|".contains(ch) {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}

/// 函数级说明（开发者 Jan）：执行 markdown_filename 的单一职责，并返回可供调用方继续处理的结果。
fn markdown_filename(title: &str, index: usize) -> String {
    let cleaned: String = title
        .chars()
        .map(|ch| {
            if ch <= '\u{1f}' || ch == '\u{7f}' || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let shortened: String = cleaned.trim().chars().take(50).collect();
    let safe = shortened.trim_end_matches(['.', ' ']);
    format!(
        "{:04}-{}.md",
        index + 1,
        if safe.is_empty() {
            "未命名会话"
        } else {
            safe
        }
    )
}

/// 函数级说明（开发者 Jan）：执行 source_markdown 的单一职责，并返回可供调用方继续处理的结果。
fn source_markdown(source: &Source) -> String {
    let messages: Vec<_> = source
        .messages
        .iter()
        .filter(|message| !message.content.trim().is_empty())
        .collect();
    let title = if source.title.trim().is_empty() {
        "未命名会话"
    } else {
        source.title.trim()
    };
    let mut blocks = vec![
        format!("# {}", markdown_inline(title)),
        format!(
            "- 会话 ID：{}\n- 消息数：{}",
            markdown_inline(source.thread_id.as_deref().unwrap_or(&source.id)),
            messages.len()
        ),
        "---".to_string(),
    ];
    for (index, message) in messages.iter().enumerate() {
        blocks.push(format!(
            "## {}. {}\n\n{}",
            index + 1,
            if message.role == "user" {
                "用户"
            } else {
                "助手"
            },
            message.content
        ));
    }
    if messages.is_empty() {
        blocks.push(if source.body.trim().is_empty() {
            "此会话暂无可导出的正文。".into()
        } else {
            source.body.trim().to_string()
        });
    }
    format!("{}\n", blocks.join("\n\n"))
}

/// 每次导出创建独立子目录，整批成功后发布，避免覆盖旧文件或留下看似完整的半批结果。
fn export_markdown(conn: &Connection, action: &Value) -> Result<Value, String> {
    let parent = Path::new(field(action, "path")?);
    if !parent.is_dir() {
        return Err("请选择已存在的导出文件夹".into());
    }
    let sources: Vec<_> = export_sources(conn, action)?
        .into_iter()
        .filter(|s| s.kind == "conversation")
        .collect();
    if sources.is_empty() {
        return Err("没有可导出的会话".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let directory = parent.join(format!("octopuses-knowledge-{stamp}"));
    let staging = parent.join(format!(
        ".octopuses-knowledge-{stamp}-{}",
        std::process::id()
    ));
    fs::create_dir(&staging).map_err(|e| format!("创建导出目录失败：{e}"))?;
    let result = (|| {
        let mut count = 0;
        for source in sources {
            let path = staging.join(markdown_filename(&source.title, count));
            fs::write(&path, source_markdown(&source))
                .map_err(|e| format!("写入知识文档失败：{e}"))?;
            count += 1;
        }
        if count == 0 {
            return Err("没有可导出的会话".into());
        }
        if directory.exists() {
            return Err("导出目录已存在，请重试".into());
        }
        fs::rename(&staging, &directory).map_err(|e| format!("完成文档导出失败：{e}"))?;
        Ok(json!({"count":count,"directory":directory.to_string_lossy()}))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// 函数级说明（开发者 Jan）：执行 dispatch 的单一职责，并返回可供调用方继续处理的结果。
fn dispatch(root: &Path, action: Value) -> Result<Value, String> {
    let mut conn = open(root)?;
    match field(&action, "op")? {
        "put" => put(
            &mut conn,
            serde_json::from_value(action["source"].clone()).map_err(|e| e.to_string())?,
            serde_json::from_value(action["chunks"].clone()).map_err(|e| e.to_string())?,
        ),
        "list" => {
            let mut stmt=conn.prepare("SELECT id,kind,title,thread_id,updated_at,hash FROM kb_source ORDER BY updated_at DESC,id").map_err(|e|e.to_string())?;
            let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"threadId":r.get::<_,Option<String>>(3)?,"updatedAt":r.get::<_,i64>(4)?,"hash":r.get::<_,String>(5)?}))).map_err(|e|e.to_string())?;
            Ok(Value::Array(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            ))
        }
        "get" => conn
            .query_row(
                "SELECT * FROM kb_source WHERE id=?1",
                [field(&action, "id")?],
                source_row,
            )
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "remove" => {
            conn.execute(
                "DELETE FROM kb_source WHERE id=?1 AND kind='document'",
                [field(&action, "id")?],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "prune" => {
            let ids: HashSet<String> =
                serde_json::from_value(action["ids"].clone()).map_err(|e| e.to_string())?;
            let existing: Vec<String> = conn
                .prepare("SELECT id FROM kb_source WHERE kind='conversation'")
                .map_err(|e| e.to_string())?
                .query_map([], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for id in existing {
                if !ids.contains(&id) {
                    tx.execute("DELETE FROM kb_source WHERE id=?1", [id])
                        .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "stats" => {
            let count = |sql: &str| {
                conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                    .map_err(|e| e.to_string())
            };
            let indexed = conn
                .query_row(
                    "SELECT count(*) FROM kb_chunk WHERE vector IS NOT NULL AND model=?1",
                    [field(&action, "model")?],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())?;
            Ok(
                json!({"conversations":count("SELECT count(*) FROM kb_source WHERE kind='conversation'")?,"documents":count("SELECT count(*) FROM kb_source WHERE kind='document'")?,"chunks":count("SELECT count(*) FROM kb_chunk")?,"indexed":indexed}),
            )
        }
        "pending" => {
            // 按来源更新时间倒序：刚导入/刚修改的文档优先进队。
            // 若按 source_id 排序，新文档会排在数万分块之后，索引要跑几小时才轮得到。
            let mut stmt=conn.prepare("SELECT c.id,c.source_id,c.message_id,c.ordinal,c.text,c.hash FROM kb_chunk c JOIN kb_source s ON s.id=c.source_id WHERE c.vector IS NULL OR c.model<>?1 ORDER BY s.updated_at DESC,c.source_id,c.ordinal LIMIT 8").map_err(|e|e.to_string())?;
            let chunks = stmt
                .query_map([field(&action, "model")?], |r| {
                    Ok(Chunk {
                        id: r.get(0)?,
                        source_id: r.get(1)?,
                        message_id: r.get(2)?,
                        ordinal: r.get(3)?,
                        text: r.get(4)?,
                        hash: r.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            serde_json::to_value(chunks).map_err(|e| e.to_string())
        }
        "embed" => {
            let raw: Vec<u8> = vector(&action)?
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            let changed = conn
                .execute(
                    "UPDATE kb_chunk SET vector=?1,model=?2 WHERE id=?3 AND hash=?4",
                    params![
                        raw,
                        field(&action, "model")?,
                        field(&action, "id")?,
                        field(&action, "hash")?
                    ],
                )
                .map_err(|e| e.to_string())?;
            Ok(json!(changed > 0))
        }
        "search" => search(&conn, &action),
        "export" => export(&conn, &action),
        "export_markdown" => export_markdown(&conn, &action),
        _ => Err("未知知识库操作".into()),
    }
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 knowledge_request 的单一职责，并返回可供调用方继续处理的结果。
pub async fn knowledge_request(cache_dir: String, action: Value) -> Result<Value, String> {
    if cache_dir.trim().is_empty() {
        return Err("请先配置缓存目录".into());
    }
    tauri::async_runtime::spawn_blocking(move || dispatch(Path::new(&cache_dir), action))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "knowledge_db_tests.rs"]
mod tests;
