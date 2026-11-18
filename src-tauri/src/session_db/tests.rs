use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use super::*;
use super::commands::*;
use super::read::*;
use super::schema::*;
use super::types::*;
use super::usage::*;
use super::write::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octopuses-session-db-test-{}-{}",
        std::process::id(),
        name
    ));
    if dir.exists() {
        fs::remove_dir_all(&dir).expect("清理测试目录失败");
    }
    dir
}

fn item(id: &str, seq: i64, kind: &str, payload: &str) -> StoredItem {
    StoredItem {
        id: id.to_string(),
        seq,
        kind: kind.to_string(),
        payload: payload.to_string(),
    }
}

fn message(
    id: &str,
    role: &str,
    seq: i64,
    attachments: Option<&str>,
    items: Vec<StoredItem>,
) -> StoredMessage {
    StoredMessage {
        id: id.to_string(),
        role: role.to_string(),
        seq,
        attachments: attachments.map(|value| value.to_string()),
        items,
    }
}

fn conversation(id: &str, created_at: i64, updated_at: i64) -> StoredConversation {
    StoredConversation {
        id: id.to_string(),
        title: format!("会话-{id}"),
        project_id: "project-1".to_string(),
        context_entries: "[]".to_string(),
        sources: "[]".to_string(),
        archived: false,
        updated_at_label: "刚刚".to_string(),
        execution_context: "local".to_string(),
        workspace_path: None,
        worktree_path: None,
        branch: None,
        review_comments: "[]".to_string(),
        agent_id: None,
        parent_thread_id: None,
        context_summary: String::new(),
        context_covered_count: 0,
        created_at,
        updated_at,
        messages: Vec::new(),
    }
}

fn message_created_at(root: &Path, message_id: &str) -> i64 {
    let (conn, _created) = open(root).expect("打开数据库失败");
    conn.query_row(
        "SELECT created_at FROM message WHERE id = ?1",
        params![message_id],
        |row| row.get(0),
    )
    .expect("查询消息创建时间失败")
}

#[test]
fn ensure_creates_database_once() {
    let root = scratch("ensure");
    let first = ensure(&root).expect("创建数据库失败");
    assert!(first.created);
    assert!(root.join(DB_FILE).is_file());
    assert_eq!(first.conversations, 0);
    assert!(first.path.ends_with(DB_FILE));

    let mut record = conversation("c1", 100, 100);
    record
        .messages
        .push(message("m1", "user", 0, None, Vec::new()));
    save(&root, &record).expect("保存会话失败");

    let second = ensure(&root).expect("再次打开数据库失败");
    assert!(!second.created);
    assert_eq!(second.conversations, 1);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn legacy_import_commits_once_and_deleted_history_stays_deleted() {
    let root = scratch("legacy-once");
    let record = conversation("legacy", 100, 100);
    assert!(!ensure(&root).unwrap().legacy_migrated);
    import_legacy(&root, std::slice::from_ref(&record)).unwrap();
    assert!(ensure(&root).unwrap().legacy_migrated);
    assert_eq!(load(&root).unwrap().len(), 1);
    delete(&root, "legacy").unwrap();
    import_legacy(&root, &[record]).unwrap();
    assert!(load(&root).unwrap().is_empty());
    fs::remove_dir_all(root).ok();
}

#[test]
fn failed_legacy_import_rolls_back_data_and_marker_for_retry() {
    let root = scratch("legacy-rollback");
    let (conn, _) = open(&root).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_bad BEFORE INSERT ON conversation WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(import_legacy(
        &root,
        &[conversation("good", 1, 1), conversation("bad", 2, 2)]
    )
    .is_err());
    assert!(load(&root).unwrap().is_empty());
    assert!(!ensure(&root).unwrap().legacy_migrated);
    conn.execute_batch("DROP TRIGGER reject_bad;").unwrap();
    import_legacy(&root, &[conversation("good", 1, 1)]).unwrap();
    assert_eq!(load(&root).unwrap().len(), 1);
    assert!(ensure(&root).unwrap().legacy_migrated);
    fs::remove_dir_all(root).ok();
}

#[test]
fn load_empty_database_returns_empty() {
    let root = scratch("empty");
    assert!(load(&root).expect("读取空数据库失败").is_empty());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn list_is_metadata_only_and_get_returns_only_selected_conversation() {
    let root = scratch("lazy-load");
    for id in ["one", "two"] {
        let mut record = conversation(id, 1, 2);
        record.messages.push(message(&format!("{id}-m"), "assistant", 0, None, vec![item(&format!("{id}-i"), 0, "text", r#"{"text":"完整历史"}"#)]));
        save(&root, &record).unwrap();
    }
    let summaries = session_db_list(root.to_string_lossy().into()).unwrap();
    assert_eq!(summaries.len(), 2);
    assert!(summaries.iter().all(|c| c.messages.is_empty()));
    let selected = session_db_get(root.to_string_lossy().into(), "one".into()).unwrap().unwrap();
    assert_eq!(selected.id, "one");
    assert_eq!(selected.messages.len(), 1);
    assert!(selected.messages[0].items[0].payload.contains("完整历史"));
    assert!(session_db_get(root.to_string_lossy().into(), "missing".into()).unwrap().is_none());
    assert_eq!(load(&root).unwrap().iter().map(|c| c.messages.len()).sum::<usize>(), 2);
    fs::remove_dir_all(root).ok();
}

#[test]
#[ignore = "manual history-loading benchmark with 10,000 fixture messages"]
fn benchmark_metadata_versus_full_history() {
    let root = scratch("history-benchmark");
    for conversation_index in 0..100 {
        let mut record = conversation(&format!("c{conversation_index}"), conversation_index, conversation_index);
        for index in 0..100 {
            let id = format!("c{conversation_index}-m{index}");
            record.messages.push(message(&id, "assistant", index, None, vec![item(&format!("{id}-i"), 0, "text", &serde_json::json!({"text":"历史正文".repeat(100)}).to_string())]));
        }
        save(&root, &record).unwrap();
    }
    let begin = std::time::Instant::now();
    let all = load(&root).unwrap();
    let full_ms = begin.elapsed().as_secs_f64() * 1000.0;
    let full_bytes = serde_json::to_vec(&all).unwrap().len();
    let begin = std::time::Instant::now();
    let summaries = session_db_list(root.to_string_lossy().into()).unwrap();
    let summary_ms = begin.elapsed().as_secs_f64() * 1000.0;
    let summary_bytes = serde_json::to_vec(&summaries).unwrap().len();
    assert_eq!(all.iter().map(|c| c.messages.len()).sum::<usize>(), 10_000);
    assert!(summaries.iter().all(|c| c.messages.is_empty()));
    eprintln!("history fixture: 100 conversations / 10000 messages; full={full_ms:.2}ms {full_bytes} bytes; summaries={summary_ms:.2}ms {summary_bytes} bytes");
    fs::remove_dir_all(root).ok();
}

#[test]
fn save_and_load_round_trip() {
    let root = scratch("round-trip");
    let mut record = conversation("c1", 1000, 2000);
    record.title = "帮我写个函数".to_string();
    record.archived = true;
    record.updated_at_label = "1 分钟前".to_string();
    // 附加上下文是 JSON 原文，Rust 侧不解析其内部结构，验证原样往返
    record.context_entries =
        r#"[{"id":"ctx1","label":"src/app/store.ts","kind":"file"}]"#.to_string();
    // 会话自带的工作目录：独立会话靠它才有工程工具可用，验证与其他字段一样原样往返
    record.workspace_path = Some("L:\\WorkSpaces\\AiProjects\\octopuses".to_string());
    // 上下文压缩状态：摘要与覆盖条数随会话落库，重启后压缩不能失效（开发者 Jan）
    record.context_summary = "用户要求写一个排序函数，已给出快排实现".to_string();
    record.context_covered_count = 6;
    // 片段 seq 故意乱序，验证读回按 seq 排序
    record.messages.push(message(
        "m1",
        "user",
        0,
        Some(r#"[{"name":"a.txt","size":12}]"#),
        vec![
            item("i2", 1, "reasoning", r#"{"text":"先想"}"#),
            item("i1", 0, "text", r#"{"text":"你好"}"#),
        ],
    ));
    record.messages.push(message(
        "m2",
        "assistant",
        1,
        None,
        vec![
            item("i3", 0, "tool_call", r#"{"name":"read"}"#),
            item("i4", 1, "sources", r#"{"items":[]}"#),
        ],
    ));
    save(&root, &record).expect("保存会话失败");

    let loaded = load(&root).expect("读取会话失败");
    assert_eq!(loaded.len(), 1);
    let stored = &loaded[0];
    assert_eq!(stored.id, "c1");
    assert_eq!(stored.title, "帮我写个函数");
    assert_eq!(stored.project_id, "project-1");
    assert_eq!(
        stored.context_entries,
        r#"[{"id":"ctx1","label":"src/app/store.ts","kind":"file"}]"#
    );
    assert!(stored.archived);
    assert_eq!(stored.updated_at_label, "1 分钟前");
    assert_eq!(
        stored.workspace_path.as_deref(),
        Some("L:\\WorkSpaces\\AiProjects\\octopuses")
    );
    assert_eq!(
        stored.context_summary,
        "用户要求写一个排序函数，已给出快排实现"
    );
    assert_eq!(stored.context_covered_count, 6);
    assert_eq!(stored.created_at, 1000);
    assert_eq!(stored.updated_at, 2000);

    assert_eq!(stored.messages.len(), 2);
    assert_eq!(stored.messages[0].id, "m1");
    assert_eq!(stored.messages[0].role, "user");
    assert_eq!(stored.messages[0].seq, 0);
    assert_eq!(
        stored.messages[0].attachments.as_deref(),
        Some(r#"[{"name":"a.txt","size":12}]"#)
    );
    assert_eq!(stored.messages[1].id, "m2");
    assert_eq!(stored.messages[1].attachments, None);

    // 片段读回按 seq 升序，kind / payload 原样保留
    assert_eq!(stored.messages[0].items.len(), 2);
    assert_eq!(stored.messages[0].items[0].id, "i1");
    assert_eq!(stored.messages[0].items[0].kind, "text");
    assert_eq!(stored.messages[0].items[0].payload, r#"{"text":"你好"}"#);
    assert_eq!(stored.messages[0].items[1].id, "i2");
    assert_eq!(stored.messages[0].items[1].kind, "reasoning");
    assert_eq!(stored.messages[1].items[1].kind, "sources");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_removes_conversation_with_children_and_usage() {
    let root = scratch("delete");
    for id in ["c1", "c2"] {
        let mut record = conversation(id, 100, 100);
        record.messages.push(message(
            &format!("{id}-m1"),
            "user",
            0,
            None,
            vec![item(&format!("{id}-i1"), 0, "text", r#"{"text":"你好"}"#)],
        ));
        save(&root, &record).expect("保存会话失败");
        save_usage(
            &root,
            &UsageRecord {
                id: format!("{id}-u1"),
                conversation_id: id.to_string(),
                project_id: "project-1".to_string(),
                model: "gpt-4o".to_string(),
                prompt_tokens: 1,
                completion_tokens: 2,
                reasoning_tokens: 0,
                total_tokens: 3,
                created_at: 100,
            },
        )
        .expect("写入用量失败");
    }

    delete(&root, "c1").expect("删除会话失败");

    // 只剩另一个会话
    let remaining = load(&root).expect("读取会话失败");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "c2");

    // 被删会话的消息 / 片段级联清掉，用量记录也一并删除；另一个会话的数据不受影响
    let (conn, _created) = open(&root).expect("打开数据库失败");
    let count =
        |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).expect("统计失败") };
    assert_eq!(
        count("SELECT COUNT(*) FROM message WHERE conversation_id = 'c1'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM message_item WHERE id = 'c1-i1'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM run_usage WHERE conversation_id = 'c1'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM message WHERE conversation_id = 'c2'"),
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM run_usage WHERE conversation_id = 'c2'"),
        1
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn migrates_legacy_conversation_schema() {
    let root = scratch("legacy-schema");
    fs::create_dir_all(&root).expect("创建测试目录失败");
    let path = root.join(DB_FILE);
    let conn = Connection::open(&path).expect("创建旧版数据库失败");
    conn.execute_batch(
        "CREATE TABLE conversation (\
           id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT NOT NULL, \
           scenario_id TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, \
           updated_at_label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, \
           updated_at INTEGER NOT NULL\
         );\
         INSERT INTO conversation \
           (id, title, project_id, scenario_id, archived, updated_at_label, created_at, updated_at) \
         VALUES ('legacy', '旧会话', 'project-1', 'scenario-1', 0, '昨天', 10, 20);",
    )
    .expect("写入旧版数据库失败");
    drop(conn);

    let loaded = load(&root).expect("迁移并读取旧版数据库失败");
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].execution_context, "local");
    assert_eq!(loaded[0].worktree_path, None);
    assert_eq!(loaded[0].branch, None);
    assert_eq!(loaded[0].review_comments, "[]");

    let (conn, _created) = open(&root).expect("重新打开数据库失败");
    let columns = conn
        .prepare("PRAGMA table_info(conversation)")
        .expect("读取表结构失败")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("读取字段失败")
        .collect::<Result<Vec<_>, _>>()
        .expect("解析字段失败");
    for column in [
        "context_entries",
        "execution_context",
        "worktree_path",
        "branch",
        "review_comments",
        "context_summary",
        "context_covered_count",
    ] {
        assert!(columns.iter().any(|item| item == column));
    }
    fs::remove_dir_all(&root).ok();
}

#[test]
fn execution_context_and_review_comments_round_trip() {
    let root = scratch("execution-context");
    let mut record = conversation("c1", 100, 200);
    record.execution_context = "worktree".to_string();
    record.worktree_path = Some("/tmp/octopuses/worktrees/thread-1".to_string());
    record.branch = Some("octopuses/thread-1-review".to_string());
    record.review_comments = r#"[{"id":"r1","threadId":"c1","path":"src/main.ts","line":12,"side":"new","context":"const value = 1;","text":"请补充校验","resolved":false,"createdAt":123}]"#.to_string();

    save(&root, &record).expect("保存执行上下文失败");
    let loaded = load(&root).expect("读取执行上下文失败");
    assert_eq!(loaded.len(), 1);
    let stored = &loaded[0];
    assert_eq!(stored.execution_context, "worktree");
    assert_eq!(
        stored.worktree_path.as_deref(),
        Some("/tmp/octopuses/worktrees/thread-1")
    );
    assert_eq!(stored.branch.as_deref(), Some("octopuses/thread-1-review"));
    assert_eq!(stored.review_comments, record.review_comments);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn resaving_message_does_not_duplicate_and_keeps_created_at() {
    let root = scratch("resave");
    let mut first = conversation("c1", 100, 100);
    first.messages.push(message(
        "m1",
        "user",
        0,
        None,
        vec![item("i1", 0, "text", r#"{"text":"旧"}"#)],
    ));
    first
        .messages
        .push(message("m2", "assistant", 1, None, Vec::new()));
    save(&root, &first).expect("首次保存失败");

    // 人为写入哨兵值，验证第二次保存不会重置 created_at
    {
        let (conn, _created) = open(&root).expect("打开数据库失败");
        conn.execute("UPDATE message SET created_at = 111 WHERE id = 'm1'", [])
            .expect("写入哨兵值失败");
    }

    // 第二次：m1 内容变化、m2 被删除、新增 m3
    let mut second = conversation("c1", 999, 999);
    second.messages.push(message(
        "m1",
        "user",
        0,
        None,
        vec![item("i1", 0, "text", r#"{"text":"新"}"#)],
    ));
    second
        .messages
        .push(message("m3", "assistant", 1, None, Vec::new()));
    save(&root, &second).expect("二次保存失败");

    let loaded = load(&root).expect("读取会话失败");
    assert_eq!(loaded.len(), 1);
    let stored = &loaded[0];
    // 会话 created_at 保留首次值
    assert_eq!(stored.created_at, 100);
    assert_eq!(stored.updated_at, 999);
    // 消息不重复、顺序正确、被删的 m2 消失
    assert_eq!(stored.messages.len(), 2);
    assert_eq!(stored.messages[0].id, "m1");
    assert_eq!(stored.messages[1].id, "m3");
    // m1 片段不重复且内容已更新
    assert_eq!(stored.messages[0].items.len(), 1);
    assert_eq!(stored.messages[0].items[0].payload, r#"{"text":"新"}"#);
    // 存活的 m1 时间戳保持不变（用哨兵值验证，未随保存重置）
    assert_eq!(message_created_at(&root, "m1"), 111);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn conversations_are_isolated_and_ordered() {
    let root = scratch("isolated");
    let mut later = conversation("c-later", 200, 200);
    later
        .messages
        .push(message("m-late", "user", 0, None, Vec::new()));
    let mut earlier = conversation("c-earlier", 100, 100);
    earlier
        .messages
        .push(message("m-early", "user", 0, None, Vec::new()));
    save(&root, &later).expect("保存会话失败");
    save(&root, &earlier).expect("保存会话失败");

    // 只更新 earlier，不触碰 later
    earlier.title = "更新后的标题".to_string();
    earlier.updated_at = 300;
    save(&root, &earlier).expect("更新会话失败");

    let loaded = load(&root).expect("读取会话失败");
    assert_eq!(loaded.len(), 2);
    // 按 created_at 升序
    assert_eq!(loaded[0].id, "c-earlier");
    assert_eq!(loaded[1].id, "c-later");
    assert_eq!(loaded[0].title, "更新后的标题");
    assert_eq!(loaded[1].title, "会话-c-later");
    assert_eq!(loaded[1].messages.len(), 1);
    assert_eq!(loaded[1].messages[0].id, "m-late");
    assert_eq!(ensure(&root).expect("打开数据库失败").conversations, 2);
    fs::remove_dir_all(&root).ok();
}

fn usage(
    id: &str,
    conversation_id: &str,
    project_id: &str,
    prompt: i64,
    completion: i64,
) -> UsageRecord {
    UsageRecord {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        project_id: project_id.to_string(),
        model: "qwen_max".to_string(),
        prompt_tokens: prompt,
        completion_tokens: completion,
        reasoning_tokens: completion / 2,
        total_tokens: prompt + completion,
        created_at: 1_700_000_000,
    }
}

#[test]
fn usage_summary_aggregates_and_filters() {
    let root = scratch("usage-summary");
    save_usage(&root, &usage("u1", "c1", "p1", 10, 20)).expect("写入用量失败");
    save_usage(&root, &usage("u2", "c1", "p1", 30, 40)).expect("写入用量失败");
    save_usage(&root, &usage("u3", "c2", "p2", 50, 60)).expect("写入用量失败");

    // 全库汇总
    let all = summarize_usage(&root, None, None).expect("汇总全部用量失败");
    assert_eq!(all.runs, 3);
    assert_eq!(all.prompt_tokens, 90);
    assert_eq!(all.completion_tokens, 120);
    assert_eq!(all.reasoning_tokens, 60);
    assert_eq!(all.total_tokens, 210);
    assert_eq!(all.last_at, Some(1_700_000_000));

    // 按会话过滤
    let by_conversation = summarize_usage(&root, Some("c1"), None).expect("按会话汇总失败");
    assert_eq!(by_conversation.runs, 2);
    assert_eq!(by_conversation.total_tokens, 100);

    // 按项目过滤
    let by_project = summarize_usage(&root, None, Some("p2")).expect("按项目汇总失败");
    assert_eq!(by_project.runs, 1);
    assert_eq!(by_project.prompt_tokens, 50);

    // 两个维度同时过滤：命中为空时全零且无最近时间
    let empty = summarize_usage(&root, Some("c2"), Some("p1")).expect("空汇总失败");
    assert_eq!(empty.runs, 0);
    assert_eq!(empty.total_tokens, 0);
    assert_eq!(empty.last_at, None);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn recording_same_usage_twice_overwrites_instead_of_accumulating() {
    let root = scratch("usage-idempotent");
    save_usage(&root, &usage("u1", "c1", "p1", 10, 20)).expect("写入用量失败");
    // 同一次运行重试：token 数变了但 id 不变，应当覆盖而非新增
    save_usage(&root, &usage("u1", "c1", "p1", 15, 25)).expect("覆盖用量失败");

    let summary = summarize_usage(&root, Some("c1"), None).expect("汇总失败");
    assert_eq!(summary.runs, 1);
    assert_eq!(summary.prompt_tokens, 15);
    assert_eq!(summary.total_tokens, 40);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn usage_survives_reopening_database() {
    let root = scratch("usage-persist");
    save_usage(&root, &usage("u1", "c1", "p1", 10, 20)).expect("写入用量失败");
    // 重新打开：表由 SCHEMA 幂等建立，旧库（无 run_usage 表）也会自动补建
    let summary = summarize_usage(&root, None, None).expect("重开后汇总失败");
    assert_eq!(summary.runs, 1);
    assert_eq!(summary.total_tokens, 30);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn video_reservations_are_unique_and_removed_with_their_thread() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().to_string_lossy().into_owned();
    save(root.path(), &conversation("thread", 1, 1)).unwrap();
    let write = |create, value: &str| video_save_job(dir.clone(), "thread".into(), "turn".into(), value.into(), create);
    write(true, "submitting").unwrap();
    assert!(write(true, "submitting").is_err());
    write(false, "queued").unwrap();
    assert_eq!(video_jobs(dir.clone()).unwrap(), ["queued"]);
    session_db_delete(dir.clone(), "thread".into()).unwrap();
    assert!(video_jobs(dir).unwrap().is_empty());
}
