//! Copy a session's work to a clean checkout, preserving the source and both index states.
use serde::Serialize;
use std::{fs, io::Write, path::Path, process::{Command, Stdio}};

/// Execute Git in an explicit repository with argument boundaries preserved.
fn git(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::platform::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Some(bytes) = input {
        child.stdin.take().ok_or("Git stdin unavailable")?.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).into_owned()); }
    Ok(out.stdout)
}
/// Decode a successful Git result and retain useful failure diagnostics.
fn text(dir: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&git(dir, args, None)?).trim().into())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffResult { pub path: String, pub branch: String, pub copied_files: usize }

/// Copy source commits and pending changes onto a clean target branch, preserving the source.
fn transfer(source: &Path, target: &Path) -> Result<HandoffResult, String> {
    let source = fs::canonicalize(source).map_err(|e| e.to_string())?;
    let target = fs::canonicalize(target).map_err(|e| e.to_string())?;
    if source == target { return Err("源目录与目标目录相同".into()); }
    let common = |dir: &Path| -> Result<std::path::PathBuf, String> {
        let p = text(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        fs::canonicalize(p).map_err(|e| e.to_string())
    };
    if common(&source)? != common(&target)? { return Err("只能在同一仓库的目录间交接".into()); }
    if !git(&target, &["status", "--porcelain", "--untracked-files=all"], None)?.is_empty() {
        return Err("目标目录有未提交改动，请先提交或另建干净的 Worktree".into());
    }
    let staged = git(&source, &["diff", "--cached", "--binary", "--full-index"], None)?;
    let unstaged = git(&source, &["diff", "--binary", "--full-index"], None)?;
    let names = git(&source, &["ls-files", "--others", "--exclude-standard", "-z"], None)?;
    let names = std::str::from_utf8(&names).map_err(|_| "暂不支持非 UTF-8 文件名")?
        .split('\0').filter(|n| !n.is_empty()).collect::<Vec<_>>();
    let mut files = Vec::new();
    for name in names {
        let src = source.join(name);
        let canonical = fs::canonicalize(&src).map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        if !canonical.starts_with(&source) || !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!("不能交接链接或特殊文件：{name}"));
        }
        if target.join(name).exists() { return Err(format!("目标已有同名文件：{name}")); }
        files.push((name.to_string(), src));
    }
    let original = text(&target, &["rev-parse", "HEAD"])?;
    let original_branch = text(&target, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let head = text(&source, &["rev-parse", "HEAD"])?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let branch = format!("octopuses/handoff-{stamp}");
    git(&target, &["switch", "-c", &branch, &head], None)?;
    let mut copied = Vec::new();
    let apply = (|| -> Result<(), String> {
        if !staged.is_empty() { git(&target, &["apply", "--index", "--binary", "-"], Some(&staged))?; }
        if !unstaged.is_empty() { git(&target, &["apply", "--binary", "-"], Some(&unstaged))?; }
        for (name, src) in &files {
            let dst = target.join(name);
            let parent = dst.parent().ok_or("目标路径无效")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            if !fs::canonicalize(parent).map_err(|e| e.to_string())?.starts_with(&target) { return Err("目标路径越界".into()); }
            let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&dst).map_err(|e| e.to_string())?;
            copied.push(dst.clone());
            let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut out).map_err(|e| e.to_string())?;
            fs::set_permissions(&dst, fs::metadata(src).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = apply {
        for file in copied { let _ = fs::remove_file(file); }
        let rollback = git(&target, &["reset", "--hard", &original], None).and_then(|_| match &original_branch {
            Some(b) => git(&target, &["switch", b], None),
            None => git(&target, &["switch", "--detach", &original], None),
        });
        if let Err(rollback) = rollback { return Err(format!("交接失败：{error}；目标恢复失败：{rollback}。源目录完整保留，请检查目标。")); }
        let _ = git(&target, &["branch", "-D", &branch], None);
        return Err(format!("交接失败，已恢复目标；源目录保留：{error}"));
    }
    Ok(HandoffResult { path: target.to_string_lossy().into(), branch, copied_files: files.len() })
}
#[tauri::command]
/// Run worktree handoff without blocking the desktop event loop.
pub async fn git_handoff(source_path: String, target_path: String) -> Result<HandoffResult, String> {
    tauri::async_runtime::spawn_blocking(move || transfer(Path::new(&source_path), Path::new(&target_path))).await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for args in [vec!["init"], vec!["config", "user.email", "test@example.invalid"], vec!["config", "user.name", "Test"]] { git(tmp.path(), &args, None).unwrap(); }
        fs::write(tmp.path().join("a.txt"), "original\n").unwrap();
        git(tmp.path(), &["add", "."], None).unwrap(); git(tmp.path(), &["commit", "-m", "initial"], None).unwrap(); tmp
    }
    #[test]
    fn preserves_source_and_transfers_both_index_states_and_untracked() {
        let root = repo(); let dest = tempfile::tempdir().unwrap(); let target = dest.path().join("work");
        git(root.path(), &["worktree", "add", "--detach", target.to_str().unwrap()], None).unwrap();
        fs::write(root.path().join("a.txt"), "staged\n").unwrap(); git(root.path(), &["add", "a.txt"], None).unwrap();
        fs::write(root.path().join("a.txt"), "unstaged\n").unwrap(); fs::write(root.path().join("new.txt"), "new").unwrap();
        transfer(root.path(), &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "unstaged\n");
        assert_eq!(fs::read_to_string(root.path().join("a.txt")).unwrap(), "unstaged\n");
        assert_eq!(text(&target, &["show", ":a.txt"]).unwrap(), "staged");
        assert_eq!(fs::read_to_string(target.join("new.txt")).unwrap(), "new");
        assert!(transfer(root.path(), &target).unwrap_err().contains("未提交"));
    }
    #[test]
    fn rejects_different_repositories() { let a = repo(); let b = repo(); assert!(transfer(a.path(), b.path()).unwrap_err().contains("同一仓库")); }
}
