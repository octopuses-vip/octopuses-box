//! 工作区边界、补丁、命令策略与回滚的行为测试。
use super::{
    checkpoint::{ensure_checkpoint, rollback_checkpoint, WorkspaceState},
    patch::{apply_hunks, parse_patch, Hunk, PatchLine},
    paths::resolve_path,
    policy::{classify_command, CommandDecision},
    rules::{load_rules, render_rules, RULES_FILE},
};
use std::{fs, path::PathBuf};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octopuses-workspace-test-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("创建测试目录");
    dir
}

#[test]
fn rejects_parent_traversal() {
    let dir = scratch("traversal");
    assert!(resolve_path(dir.to_string_lossy().as_ref(), "../outside.txt", true).is_err());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn applies_modify_create_delete_patch() {
    let changed = apply_hunks(
        "one\ntwo\n",
        &[Hunk {
            old_start: 1,
            lines: vec![
                PatchLine {
                    kind: ' ',
                    text: "one".into(),
                },
                PatchLine {
                    kind: '-',
                    text: "two".into(),
                },
                PatchLine {
                    kind: '+',
                    text: "TWO".into(),
                },
            ],
        }],
        "a.txt",
    )
    .expect("应用补丁");
    assert_eq!(changed, "one\nTWO\n");
}

#[test]
fn parses_multiple_file_blocks() {
    let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+x\n";
    let parsed = parse_patch(patch).expect("解析补丁");
    assert_eq!(parsed.len(), 2);
}

#[test]
fn classifies_allow_ask_and_deny_commands() {
    assert_eq!(
        classify_command("cargo test --lib", true).decision,
        CommandDecision::Allow
    );
    assert_eq!(
        classify_command("python scripts/check.py", true).decision,
        CommandDecision::Ask
    );
    assert_eq!(
        classify_command("rm -rf target", true).decision,
        CommandDecision::Deny
    );
    assert_eq!(
        classify_command("rm --recursive --force target", true).decision,
        CommandDecision::Deny
    );
    assert_eq!(
        classify_command("env sudo true", true).decision,
        CommandDecision::Deny
    );
    assert_eq!(
        classify_command("git -C repo reset --hard HEAD", true).decision,
        CommandDecision::Deny
    );
    assert_eq!(
        classify_command("echo $(rm -rf target)", true).decision,
        CommandDecision::Deny
    );
}

#[test]
fn rejects_dangerous_chained_commands() {
    assert_eq!(
        classify_command("cargo check && git reset --hard HEAD", true).decision,
        CommandDecision::Deny
    );
    assert_eq!(
        classify_command("git status || git clean -fd", true).decision,
        CommandDecision::Deny
    );
}

#[test]
fn restores_modified_created_and_deleted_files() {
    let project = scratch("rollback-project");
    let cache = scratch("rollback-cache");
    let modified = project.join("modified.txt");
    let deleted = project.join("deleted.txt");
    let created = project.join("created.txt");
    fs::write(&modified, b"before").expect("写入修改文件");
    fs::write(&deleted, b"deleted-before").expect("写入删除文件");

    let state = WorkspaceState::default();
    let id = ensure_checkpoint(
        &state,
        cache.to_string_lossy().as_ref(),
        project.to_string_lossy().as_ref(),
        "thread",
        "run",
        &[modified.clone(), deleted.clone(), created.clone()],
    )
    .expect("创建检查点");

    fs::write(&modified, b"after").expect("修改文件");
    fs::remove_file(&deleted).expect("删除文件");
    fs::write(&created, b"created-after").expect("新建文件");
    let result = rollback_checkpoint(
        cache.to_string_lossy().as_ref(),
        project.to_string_lossy().as_ref(),
        &id,
    )
    .expect("回滚检查点");

    assert_eq!(result.files.len(), 3);
    assert_eq!(fs::read(&modified).expect("读取修改文件"), b"before");
    assert_eq!(fs::read(&deleted).expect("读取删除文件"), b"deleted-before");
    assert!(!created.exists());
    let _ = fs::remove_dir_all(project);
    let _ = fs::remove_dir_all(cache);
}

#[test]
fn rejects_checkpoint_from_another_project() {
    let project = scratch("rollback-owner");
    let other = scratch("rollback-other");
    let cache = scratch("rollback-owner-cache");
    let target = project.join("file.txt");
    fs::write(&target, b"before").expect("写入文件");
    let state = WorkspaceState::default();
    let id = ensure_checkpoint(
        &state,
        cache.to_string_lossy().as_ref(),
        project.to_string_lossy().as_ref(),
        "thread",
        "run",
        &[target],
    )
    .expect("创建检查点");
    assert!(rollback_checkpoint(
        cache.to_string_lossy().as_ref(),
        other.to_string_lossy().as_ref(),
        &id,
    )
    .is_err());
    let _ = fs::remove_dir_all(project);
    let _ = fs::remove_dir_all(other);
    let _ = fs::remove_dir_all(cache);
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let project = scratch("symlink-project");
    let outside = scratch("symlink-outside");
    symlink(&outside, project.join("escape")).expect("创建符号链接");
    assert!(resolve_path(project.to_string_lossy().as_ref(), "escape/file.txt", true,).is_err());
    let _ = fs::remove_dir_all(project);
    let _ = fs::remove_dir_all(outside);
}

#[test]
fn loads_root_and_nested_rules_in_order() {
    let project = scratch("rules-order");
    fs::create_dir_all(project.join("src/main")).expect("创建目录");
    fs::write(project.join(RULES_FILE), "根规则").expect("写入根规则");
    fs::write(project.join("src").join(RULES_FILE), "src 规则").expect("写入子规则");
    fs::write(project.join("src/main").join(RULES_FILE), "main 规则").expect("写入深层规则");

    let files = load_rules(&project, Some("src/main/foo.rs")).expect("加载规则");
    assert_eq!(files.len(), 3);
    assert_eq!(files[0].path, "AGENTS.md");
    assert_eq!(files[1].path, "src/AGENTS.md");
    assert_eq!(files[2].path, "src/main/AGENTS.md");

    let content = render_rules(&files);
    assert!(content.contains("优先级更高"));
    assert!(content.find("根规则").unwrap() < content.find("main 规则").unwrap());

    let only_root = load_rules(&project, None).expect("仅根规则");
    assert_eq!(only_root.len(), 1);
    let _ = fs::remove_dir_all(project);
}

#[test]
fn rejects_rule_target_outside_workspace() {
    let project = scratch("rules-traversal");
    assert!(load_rules(&project, Some("../outside")).is_err());
    assert!(load_rules(&project, Some("/etc")).is_err());
    let _ = fs::remove_dir_all(project);
}

#[test]
fn skips_empty_rules_and_escaped_symlink() {
    let project = scratch("rules-empty");
    let outside = scratch("rules-outside");
    fs::write(project.join(RULES_FILE), "   \n").expect("写入空规则");
    fs::write(outside.join(RULES_FILE), "外部规则").expect("写入外部规则");
    assert!(load_rules(&project, None).expect("加载规则").is_empty());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        fs::create_dir_all(project.join("sub")).expect("创建子目录");
        symlink(
            outside.join(RULES_FILE),
            project.join("sub").join(RULES_FILE),
        )
        .expect("创建符号链接");
        let files = load_rules(&project, Some("sub")).expect("加载规则");
        assert!(files.is_empty(), "符号链接逃逸的规则不应被读取");
    }

    let _ = fs::remove_dir_all(project);
    let _ = fs::remove_dir_all(outside);
}
