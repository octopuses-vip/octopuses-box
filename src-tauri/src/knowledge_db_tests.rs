use super::*;
fn scratch(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("octopuses-kb-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}
fn seed(root: &Path, id: &str, kind: &str, text: &str, hash: &str) {
    dispatch(root,json!({"op":"put","source":{"id":id,"kind":kind,"title":format!("资料-{id}"),"threadId":if kind=="conversation" {Some(id)} else {None},"body":text,"messages":[],"updatedAt":1,"hash":hash},
        "chunks":[{"id":format!("{id}:0"),"sourceId":id,"messageId":null,"ordinal":0,"text":text,"hash":hash}]})).unwrap();
}
fn search_for(root: &Path, q: &str) -> Value {
    dispatch(
        root,
        json!({"op":"search","query":q,"kind":"","model":"v1","vector":null}),
    )
    .unwrap()
}
fn embedding() -> Vec<f32> {
    let mut v = vec![0.0; 512];
    v[0] = 1.0;
    v
}

#[test]
fn search_groups_sources_before_limit_and_keeps_best_message() {
    let root = scratch("search-grouping");
    for (id, kind, count) in [
        ("chat", "conversation", 130),
        ("other-chat", "conversation", 1),
        ("doc", "document", 3),
    ] {
        let chunks: Vec<_> = (0..count).map(|i| json!({"id":format!("{id}:{i}"),"sourceId":id,"messageId":format!("message:{i}"),"ordinal":i,"text":format!("防火墙片段 {i}"),"hash":format!("{id}:{i}")})).collect();
        dispatch(&root, json!({"op":"put","source":{"id":id,"kind":kind,"title":"防火墙","threadId":if kind == "conversation" {Some(id)} else {None},"body":"防火墙","messages":[],"updatedAt":1,"hash":id},"chunks":chunks})).unwrap();
    }
    let conn = open(&root).unwrap();
    let raw = |score: f32| {
        let mut values = vec![0.0_f32; 512];
        values[0] = score;
        values[1] = (1.0 - score * score).sqrt();
        values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>()
    };
    for (id, score) in [("chat", 0.9), ("other-chat", 0.7), ("doc", 0.6)] {
        conn.execute(
            "UPDATE kb_chunk SET vector=?1,model='v1' WHERE source_id=?2",
            params![raw(score), id],
        )
        .unwrap();
    }
    conn.execute(
        "UPDATE kb_chunk SET vector=?1 WHERE id='chat:129'",
        params![raw(1.0)],
    )
    .unwrap();
    let action =
        json!({"op":"search","query":"防火墙","kind":"","model":"v1","vector":embedding()});
    let hits = search(&conn, &action).unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 3);
    assert_eq!(hits[0]["sourceId"], "chat");
    assert_eq!(hits[0]["messageId"], "message:129");
    assert_eq!(hits[0]["text"], "防火墙片段 129");
    assert_eq!(hits[1]["sourceId"], "other-chat");
    assert_eq!(hits[2]["sourceId"], "doc");
    assert_eq!(search_for(&root, "防火墙").as_array().unwrap().len(), 3);
    let mut documents = action;
    documents["kind"] = json!("document");
    assert_eq!(
        search(&conn, &documents).unwrap().as_array().unwrap().len(),
        1
    );
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn pending_prefers_recent_sources_so_new_documents_index_first() {
    let root = scratch("pending-order");
    for (id, updated) in [("old", 1_i64), ("fresh", 2_i64)] {
        dispatch(&root, json!({"op":"put","source":{"id":id,"kind":"document","title":id,"threadId":null,"body":id,"messages":[],"updatedAt":updated,"hash":id},"chunks":[{"id":format!("{id}:0"),"sourceId":id,"messageId":null,"ordinal":0,"text":format!("内容 {id}"),"hash":id}]})).unwrap();
    }
    let pending = dispatch(&root, json!({"op":"pending","model":"v1"})).unwrap();
    assert_eq!(pending[0]["sourceId"], "fresh");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn hybrid_search_supplements_sources_missing_from_vector_index() {
    let root = scratch("hybrid");
    seed(&root, "indexed", "document", "数据库连接失败排查", "h1");
    seed(
        &root,
        "pending",
        "document",
        "PLM 启动步骤：进入 windchill shell 后执行 start",
        "h2",
    );
    let conn = open(&root).unwrap();
    conn.execute(
        "UPDATE kb_chunk SET vector=?1,model='v1' WHERE source_id='indexed'",
        params![{
            let mut values = vec![0.0_f32; 512];
            values[0] = 0.9;
            values[1] = (1.0_f32 - 0.9 * 0.9).sqrt();
            values
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>()
        }],
    )
    .unwrap();
    let hits = search(
        &conn,
        &json!({"op":"search","query":"PLM 启动步骤","kind":"","model":"v1","vector":embedding()}),
    )
    .unwrap();
    let pending = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["sourceId"] == "pending")
        .expect("未建索引的文档应通过关键词补齐");
    assert_eq!(pending["match"], "keyword");
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prepared_exports_are_selected_transient_and_empty_never_means_all() {
    let root = scratch("selected-export");
    seed(&root, "original", "conversation", "原始正文", "h");
    let source = json!({"id":"selected","kind":"conversation","title":"选中会话","threadId":"selected","body":"清洗正文","messages":[{"id":"1","role":"user","content":"问题"},{"id":"2","role":"assistant","content":"[已脱敏]"}],"updatedAt":1,"hash":"h"});
    let path = root.join("selected.jsonl");
    let result = dispatch(&root, json!({"op":"export","path":path.to_string_lossy(),"format":"messages","sources":[source.clone()]})).unwrap();
    assert_eq!(result["count"], 1);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("[已脱敏]"));
    assert!(!text.contains("原始正文"));
    let md = dispatch(
        &root,
        json!({"op":"export_markdown","path":root.to_string_lossy(),"sources":[source]}),
    )
    .unwrap();
    assert_eq!(md["count"], 1);
    assert_eq!(
        dispatch(&root, json!({"op":"list"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for op in ["export", "export_markdown"] {
        assert!(dispatch(&root, json!({"op":op,"path":if op=="export" {path.to_string_lossy()} else {root.to_string_lossy()},"format":"messages","sources":[]})).is_err());
    }
    fs::remove_dir_all(root).ok();
}

#[test]
fn chinese_fts_short_terms_literal_punctuation_and_cascade_deletion() {
    let root = scratch("fts");
    seed(
        &root,
        "doc",
        "document",
        "中文知识库支持附件检索，版本 A_B% 与 \"引号\"。",
        "h1",
    );
    assert_eq!(search_for(&root, "知识库").as_array().unwrap().len(), 1);
    assert_eq!(search_for(&root, "中文").as_array().unwrap().len(), 1);
    assert_eq!(search_for(&root, "A_B%").as_array().unwrap().len(), 1);
    assert_eq!(search_for(&root, "\"引号\"").as_array().unwrap().len(), 1);
    assert!(dispatch(
        &root,
        json!({"op":"search","query":"OR *","kind":"","model":"v1","vector":null})
    )
    .is_ok());
    dispatch(&root, json!({"op":"remove","id":"doc"})).unwrap();
    assert_eq!(search_for(&root, "知识库"), json!([]));
    assert_eq!(
        dispatch(&root, json!({"op":"stats","model":"v1"})).unwrap()["chunks"],
        0
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn vectors_preserved_when_unchanged_invalidated_when_edited_and_stale_writes_ignored() {
    let root = scratch("incremental");
    seed(&root, "doc", "document", "旧的内容", "h1");
    let embed = |hash: &str| {
        dispatch(
            &root,
            json!({"op":"embed","id":"doc:0","hash":hash,"model":"v1","vector":embedding()}),
        )
    };
    assert_eq!(embed("h1").unwrap(), true);
    seed(&root, "doc", "document", "旧的内容", "h1");
    assert_eq!(
        dispatch(&root, json!({"op":"pending","model":"v1"})).unwrap(),
        json!([])
    );
    let hits = dispatch(
        &root,
        json!({"op":"search","query":"完全不同的问题","kind":"","model":"v1","vector":embedding()}),
    )
    .unwrap();
    assert_eq!(hits[0]["match"], "semantic");
    let semantic = dispatch(
        &root,
        json!({"op":"search","query":"旧的内容","kind":"","model":"v1","vector":embedding()}),
    )
    .unwrap();
    assert_eq!(semantic[0]["match"], "semantic");
    seed(&root, "doc", "document", "修改后的资料", "h2");
    assert_eq!(embed("h1").unwrap(), false);
    assert_eq!(search_for(&root, "旧的内容"), json!([]));
    assert_eq!(
        dispatch(&root, json!({"op":"pending","model":"v1"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(dispatch(
        &root,
        json!({"op":"embed","id":"doc:0","hash":"h2","model":"v1","vector":[1.0]})
    )
    .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prune_only_conversations_keeps_documents_and_other_cache_is_isolated() {
    let root = scratch("prune");
    let other = scratch("isolated");
    seed(&root, "chat", "conversation", "历史消息", "h");
    seed(&root, "doc", "document", "本地文档", "h");
    assert_eq!(search_for(&other, "历史消息"), json!([]));
    dispatch(&root, json!({"op":"prune","ids":[]})).unwrap();
    let stats = dispatch(&root, json!({"op":"stats","model":"v1"})).unwrap();
    assert_eq!(stats["conversations"], 0);
    assert_eq!(stats["documents"], 1);
    assert_eq!(stats["chunks"], 1);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(other).unwrap();
}

#[test]
fn exports_three_training_formats_with_history_and_documents_separately() {
    let root = scratch("export");
    let source = Source {
        id: "chat".into(),
        kind: "conversation".into(),
        title: "对话".into(),
        thread_id: Some("chat".into()),
        body: "正文".into(),
        updated_at: 1,
        hash: "h".into(),
        messages: vec![
            Message {
                id: "1".into(),
                role: "user".into(),
                content: "第一问".into(),
            },
            Message {
                id: "2".into(),
                role: "assistant".into(),
                content: "第一答".into(),
            },
            Message {
                id: "3".into(),
                role: "user".into(),
                content: "第二问".into(),
            },
            Message {
                id: "4".into(),
                role: "assistant".into(),
                content: "第二答\n含换行".into(),
            },
            Message {
                id: "5".into(),
                role: "user".into(),
                content: "未回答".into(),
            },
        ],
    };
    put(&mut open(&root).unwrap(), source, vec![]).unwrap();
    seed(&root, "doc", "document", "文档不是问答", "h");
    for format in ["messages", "alpaca", "sharegpt", "documents"] {
        let path = root.join(format!("{format}.jsonl"));
        let result = dispatch(
            &root,
            json!({"op":"export","format":format,"path":path.to_string_lossy()}),
        )
        .unwrap();
        assert_eq!(result["count"], 1);
        let text = fs::read_to_string(path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let line: Value = serde_json::from_str(text.trim()).unwrap();
        match format {
            "messages" => {
                assert_eq!(line["messages"].as_array().unwrap().len(), 4);
                assert_eq!(line["messages"][3]["content"], "第二答\n含换行");
            }
            "alpaca" => {
                assert_eq!(line["instruction"], "第二问");
                assert!(line["input"].as_str().unwrap().contains("第一答"));
            }
            "sharegpt" => {
                assert_eq!(line["conversations"][0]["from"], "human");
                assert_eq!(line["conversations"][3]["from"], "gpt");
            }
            _ => {
                assert_eq!(line["text"], "文档不是问答");
                assert!(line.get("messages").is_none());
            }
        }
        assert!(!text.contains("未回答"));
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn markdown_exports_every_conversation_into_fresh_directory_without_overwriting() {
    let root = scratch("markdown");
    let destination = root.join("exports");
    fs::create_dir(&destination).unwrap();
    let action = json!({"op":"export_markdown","path":destination.to_string_lossy()});
    assert!(dispatch(&root, action.clone()).is_err());
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    for (index, id) in ["a", "b", "empty"].iter().enumerate() {
        let source = Source {
            id: id.to_string(),
            kind: "conversation".into(),
            title: "../CON:同名?/\\".into(),
            thread_id: Some(id.to_string()),
            body: String::new(),
            updated_at: index as i64,
            hash: "h".into(),
            messages: if *id == "empty" {
                vec![]
            } else {
                vec![
                    Message {
                        id: "u".into(),
                        role: "user".into(),
                        content: "问题\n[附件：资料.txt]\n附件全文".into(),
                    },
                    Message {
                        id: "a".into(),
                        role: "assistant".into(),
                        content: "```rs\nlet a = 1;\n```".into(),
                    },
                    Message {
                        id: "last".into(),
                        role: "user".into(),
                        content: "尚未回答的问题".into(),
                    },
                ]
            },
        };
        put(&mut open(&root).unwrap(), source, vec![]).unwrap();
    }
    seed(&root, "doc", "document", "上传文档不属于会话导出", "hash");
    let first = dispatch(&root, action.clone()).unwrap();
    assert_eq!(first["count"], 3);
    let directory = Path::new(first["directory"].as_str().unwrap());
    let mut names: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names.len(), 3);
    for name in &names {
        assert!(name.ends_with(".md"));
        assert!(!name.contains(['/', '\\', ':', '?']));
    }
    let content = fs::read_to_string(directory.join(&names[0])).unwrap();
    assert!(content.contains("## 1. 用户"));
    assert!(content.contains("附件全文"));
    assert!(content.contains("```rs\nlet a = 1;\n```"));
    assert!(content.contains("尚未回答的问题"));
    assert!(fs::read_to_string(directory.join(&names[2]))
        .unwrap()
        .contains("此会话暂无可导出的正文"));
    let second = dispatch(&root, action).unwrap();
    assert_ne!(first["directory"], second["directory"]);
    assert_eq!(
        fs::read_to_string(directory.join(&names[0])).unwrap(),
        content
    );
    assert!(fs::read_dir(&destination).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with('.')));
    assert!(markdown_filename(&"🙂".repeat(100), 0).len() < 255);
    fs::remove_dir_all(root).unwrap();
}
