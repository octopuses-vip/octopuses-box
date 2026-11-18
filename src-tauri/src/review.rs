//! GitHub review integration: argument arrays and stdin, never shell interpolation.
use std::{io::Write, process::{Command, Stdio}, path::Path};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub action: String, pub number: Option<u64>, pub body: Option<String>,
    pub event: Option<String>, pub title: Option<String>, pub base: Option<String>, pub run_id: Option<u64>,
    pub repo: Option<String>, pub path: Option<String>, pub line: Option<u64>, pub commit_id: Option<String>,
}
/// Map supported review actions to fixed GitHub CLI arguments and stdin bodies.
fn args(request: &ReviewRequest) -> Result<(Vec<String>, Option<String>), String> {
    let number = || request.number.filter(|n| *n > 0).map(|n| n.to_string()).ok_or("PR 编号无效".to_string());
    let v = |items: &[&str]| items.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    Ok(match request.action.as_str() {
        "status" => (v(&["auth", "status"]), None),
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
#[tauri::command]
/// Run authenticated GitHub review operations in the selected workspace.
pub async fn review_github(workspace_path: String, mut request: ReviewRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&workspace_path).is_dir() { return Err("工作目录不存在".to_string()); }
        if request.action.starts_with("inline-") {
            let mut lookup = Command::new("gh"); lookup.current_dir(&workspace_path).args(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).env("GH_PROMPT_DISABLED", "1"); crate::platform::hide_console(&mut lookup);
            let result = lookup.output().map_err(|e| e.to_string())?;
            if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).into()); }
            request.repo = Some(String::from_utf8_lossy(&result.stdout).trim().to_string());
        }
        let (args, body) = args(&request)?;
        let mut cmd = Command::new("gh");
        cmd.current_dir(workspace_path).args(args).env("GH_PROMPT_DISABLED", "1")
            .stdin(if body.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::platform::hide_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("请安装 GitHub CLI 并运行 gh auth login：{e}"))?;
        if let Some(body) = body { child.stdin.take().ok_or("stdin unavailable")?.write_all(body.as_bytes()).map_err(|e| e.to_string())?; }
        let result = child.wait_with_output().map_err(|e| e.to_string())?;
        if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).into()); }
        let output = String::from_utf8_lossy(&result.stdout).to_string();
        Ok(serde_json::from_str(&output).unwrap_or(json!({ "text": output, "detail": String::from_utf8_lossy(&result.stderr) })))
    }).await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_body_stays_on_stdin() {
        let r = serde_json::from_value(json!({"action":"review","number":3,"event":"comment","body":"line1\n$(secret)`cmd`"})).unwrap();
        let (a,b) = args(&r).unwrap();
        assert_eq!(b.unwrap(), "line1\n$(secret)`cmd`"); assert!(!a.iter().any(|s| s.contains("secret")));
    }
    #[test]
    fn reject_bad_action_and_event() {
        for r in [json!({"action":"shell"}), json!({"action":"review","number":1,"event":"--delete"})] { assert!(args(&serde_json::from_value(r).unwrap()).is_err()); }
    }
}
