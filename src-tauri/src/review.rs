//! GitHub review integration: argument arrays and stdin, never shell interpolation.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub action: String,
    pub number: Option<u64>,
    pub body: Option<String>,
    pub event: Option<String>,
    pub title: Option<String>,
    pub base: Option<String>,
    pub run_id: Option<u64>,
    pub repo: Option<String>,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub commit_id: Option<String>,
}
/// Map supported review actions to fixed GitHub CLI arguments and stdin bodies.
fn args(request: &ReviewRequest) -> Result<(Vec<String>, Option<String>), String> {
    let number = || {
        request
            .number
            .filter(|n| *n > 0)
            .map(|n| n.to_string())
            .ok_or("PR 编号无效".to_string())
    };
    let v = |items: &[&str]| items.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    Ok(match request.action.as_str() {
        "list" => (v(&["pr", "list", "--limit", "50", "--json", "number,title,url,state,headRefName,author"]), None),
        "view" => (v(&["pr", "view", &number()?, "--json", "number,title,url,body,files,comments,reviews,statusCheckRollup,headRefName,headRefOid,baseRefName"]), None),
        "inline-list" | "inline-post" => {
            let repo = request.repo.as_deref().ok_or("仓库标识缺失")?;
            if repo.split('/').count() != 2 || !repo.split('/').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))) { return Err("仓库标识无效".into()); }
            let endpoint = format!("repos/{repo}/pulls/{}/comments", number()?);
            if request.action == "inline-list" { (v(&["api", &endpoint, "--paginate", "--slurp"]), None) }
            else {
                let line = request.line.filter(|n| *n > 0).ok_or("行号无效")?;
                let commit = request.commit_id.as_deref().filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())).ok_or("请填写 PR 最新 Head commit SHA")?;
                let path = request.path.as_deref().filter(|s| !s.is_empty() && !s.starts_with('/') && !s.split('/').any(|p| p == ".." || p.is_empty())).ok_or("文件路径无效")?;
                let body = request.body.as_deref().filter(|s| !s.trim().is_empty()).ok_or("请填写行内评论")?;
                (v(&["api", "--method", "POST", &endpoint, "--input", "-"]), Some(json!({"body":body,"commit_id":commit,"path":path,"line":line,"side":"RIGHT"}).to_string()))
            }
        },
        "diff" => (v(&["pr", "diff", &number()?]), None),
        "logs" => (v(&["run", "view", &request.run_id.filter(|id| *id > 0).ok_or("CI Run ID 无效")?.to_string(), "--log-failed"]), None),
        "review" => {
            let flag = match request.event.as_deref() { Some("approve") => "--approve", Some("request-changes") => "--request-changes", Some("comment") => "--comment", _ => return Err("审查决定无效".into()) };
            let body = request.body.clone().filter(|s| !s.trim().is_empty()).ok_or("请填写审查意见")?;
            (v(&["pr", "review", &number()?, flag, "--body-file", "-"]), Some(body))
        },
        "create" => {
            let title = request.title.as_deref().filter(|s| !s.trim().is_empty()).ok_or("请填写 PR 标题")?;
            let base = request.base.as_deref().unwrap_or("main");
            (v(&["pr", "create", "--title", title, "--base", base, "--body-file", "-"]), Some(request.body.clone().unwrap_or_default()))
        },
        _ => return Err("未知审查操作".into()),
    })
}

/// Finder and desktop launchers need not inherit the terminal's PATH.
fn github_cli() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut directories = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    let home = crate::platform::home_dir();
    if cfg!(windows) {
        directories.extend(
            ["ProgramFiles", "ProgramFiles(x86)"]
                .into_iter()
                .filter_map(env::var_os)
                .map(|dir| PathBuf::from(dir).join("GitHub CLI")),
        );
        directories.push(home.join("AppData/Local/Microsoft/WinGet/Links"));
        directories.push(home.join("scoop/shims"));
    } else {
        directories.extend([
            home.join(".local/bin"),
            home.join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
        ]);
    }
    directories
        .into_iter()
        .filter(|path| path.is_absolute())
        .map(|path| path.join(executable))
        .find(|path| path.is_file())
}

fn gh_command(cli: &Path, workspace: Option<&Path>) -> Command {
    let mut command = Command::new(cli);
    if let Some(path) = workspace {
        command.current_dir(path);
    }
    command
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env_remove("GH_DEBUG");
    crate::platform::hide_console(&mut command);
    command
}

/// Prefer the CLI error stream, falling back to stdout for older versions of gh.
fn command_error(result: &Output) -> String {
    let message = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    let text = String::from_utf8_lossy(message);
    if text.trim().is_empty() {
        format!("GitHub CLI 退出：{}", result.status)
    } else {
        text.trim().chars().take(4000).collect()
    }
}

fn login_command(cli: &Path) -> String {
    let path = cli.to_string_lossy();
    if cfg!(windows) {
        format!("& '{}' auth login --web", path.replace('\'', "''"))
    } else {
        format!("'{}' auth login --web", path.replace('\'', "'\\''"))
    }
}

/// Account checks work independently of a repository and never display credential values.
fn connection_status(cli: Option<&Path>) -> Result<Value, String> {
    let Some(cli) = cli else {
        return Ok(
            json!({ "state": "missing", "text": "未找到 GitHub CLI。安装后可重新检查连接。" }),
        );
    };
    let login = login_command(cli);
    let result = gh_command(cli, None)
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| format!("无法启动 GitHub CLI：{e}"))?;
    let account = String::from_utf8_lossy(&result.stdout);
    if result.status.success() && !account.trim().is_empty() {
        return Ok(
            json!({ "state": "connected", "text": format!("已连接 GitHub · {}", account.trim()) }),
        );
    }
    let error = command_error(&result);
    if result.status.code() == Some(4)
        || error.contains("gh auth login")
        || error.contains("HTTP 401")
    {
        return Ok(
            json!({ "state": "login-required", "text": "GitHub 尚未登录或授权已失效。", "loginCommand": login }),
        );
    }
    Ok(
        json!({ "state": "error", "text": format!("无法检查 GitHub 连接：{error}"), "loginCommand": login }),
    )
}

#[tauri::command]
/// Run authenticated GitHub review operations in the selected workspace.
pub async fn review_github(
    workspace_path: String,
    mut request: ReviewRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli = github_cli();
        if request.action == "status" {
            return connection_status(cli.as_deref());
        }
        let cli = cli.ok_or("未找到 GitHub CLI，请先在「GitHub 连接」中检查安装和授权。")?;
        let workspace = Path::new(&workspace_path);
        if !workspace.is_dir() {
            return Err("请选择有效的 GitHub 仓库目录。".to_string());
        }
        if request.action.starts_with("inline-") {
            let mut lookup = gh_command(&cli, Some(workspace));
            lookup.args([
                "repo",
                "view",
                "--json",
                "nameWithOwner",
                "--jq",
                ".nameWithOwner",
            ]);
            let result = lookup.output().map_err(|e| e.to_string())?;
            if !result.status.success() {
                return Err(command_error(&result));
            }
            request.repo = Some(String::from_utf8_lossy(&result.stdout).trim().to_string());
        }
        let (args, body) = args(&request)?;
        let mut cmd = gh_command(&cli, Some(workspace));
        cmd.args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(if body.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 GitHub CLI：{e}"))?;
        if let Some(body) = body {
            child
                .stdin
                .take()
                .ok_or("stdin unavailable")?
                .write_all(body.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        let result = child.wait_with_output().map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err(command_error(&result));
        }
        let output = String::from_utf8_lossy(&result.stdout).to_string();
        Ok(serde_json::from_str(&output).unwrap_or(
            json!({ "text": output, "detail": String::from_utf8_lossy(&result.stderr) }),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_check_reports_a_missing_cli_without_a_workspace() {
        let status = connection_status(None).unwrap();
        assert_eq!(status["state"], "missing");
        assert!(status.get("loginCommand").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn account_check_reports_cli_login_required() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("gh");
        fs::write(&cli, "#!/bin/sh\nexit 4\n").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let status = connection_status(Some(&cli)).unwrap();
        assert_eq!(status["state"], "login-required");
        assert!(status["loginCommand"]
            .as_str()
            .unwrap()
            .ends_with(" auth login --web"));
    }
    #[test]
    fn review_body_stays_on_stdin() {
        let r = serde_json::from_value(
            json!({"action":"review","number":3,"event":"comment","body":"line1\n$(secret)`cmd`"}),
        )
        .unwrap();
        let (a, b) = args(&r).unwrap();
        assert_eq!(b.unwrap(), "line1\n$(secret)`cmd`");
        assert!(!a.iter().any(|s| s.contains("secret")));
    }
    #[test]
    fn reject_bad_action_and_event() {
        for r in [
            json!({"action":"shell"}),
            json!({"action":"review","number":1,"event":"--delete"}),
        ] {
            assert!(args(&serde_json::from_value(r).unwrap()).is_err());
        }
    }
}
