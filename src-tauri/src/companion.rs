//! Start the local companion independently of the WebView; proxy authenticated host requests.
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, time::Duration};
use tauri::Manager;
// OAuth setup and the task inspector can request startup at the same time.
static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Resolve companion state inside the selected cache directory.
fn host_dir(cache_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(cache_path).map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("缓存目录不可用".into()); }
    Ok(root.join("host"))
}
/// Bound host requests and reject redirects carrying host credentials.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())
}
/// Proxy an authenticated JSON request to a validated host route.
async fn request_at(url: &str, token: &str, route: &str, body: Option<Value>) -> Result<Value, String> {
    if !route.starts_with('/') || route.contains("..") || route.starts_with("//") || route.contains('?') || route.contains('#') { return Err("服务路径无效".into()); }
    let client = http_client()?;
    let request = if let Some(body) = body { client.post(format!("{}{route}", url.trim_end_matches('/'))).json(&body) } else { client.get(format!("{}{route}", url.trim_end_matches('/'))) };
    let response = request.bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let status = response.status(); let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(value["error"].as_str().unwrap_or("主机请求失败").to_string()); }
    Ok(value)
}
/// Read the running local host address and its app-owned token.
fn local_identity(root: &Path) -> Result<(String, String), String> {
    let state: Value = serde_json::from_slice(&fs::read(root.join("state.json")).map_err(|_| "本地后台服务尚未启动")?).map_err(|e| e.to_string())?;
    let port = state["port"].as_u64().filter(|v| (1..=65535).contains(v)).ok_or("服务端口无效")?;
    let token = state["token"].as_str().ok_or("主机令牌缺失")?.to_string();
    Ok((format!("http://127.0.0.1:{port}"), token))
}
#[tauri::command]
/// Locate packaged integration resources, with source fallback only in development.
pub fn integration_paths(app: tauri::AppHandle) -> Result<Value, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let choose = |name: &str| { let bundled = resources.join(name); if bundled.exists() { bundled } else if cfg!(debug_assertions) { source.join(name) } else { bundled } };
    Ok(json!({ "browserExtension": choose("browser-extension").to_string_lossy(), "companion": choose("companion").to_string_lossy() }))
}
#[tauri::command]
/// Build the packaged runner image on explicit user request.
pub async fn prepare_container(app: tauri::AppHandle) -> Result<String, String> {
    let resources = integration_paths(app)?;
    let directory = resources["companion"].as_str().ok_or("容器环境资源缺失")?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("docker");
        command.args(["build", "--tag", "octopuses-runner:local", &directory]).stdin(Stdio::null()); crate::platform::hide_console(&mut command);
        let output = command.output().map_err(|e| format!("需要先安装并启动 Docker：{e}"))?;
        let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        if output.status.success() { Ok("本地隔离环境已准备完成".to_string()) } else { Err(text.chars().take(16000).collect()) }
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
/// Select local or keyring-backed remote credentials for a host request.
pub async fn companion_request(cache_path: String, route: String, body: Option<Value>, remote: Option<bool>) -> Result<Value, String> {
    let root = host_dir(&cache_path)?;
    let (url, token) = if remote.unwrap_or(false) {
        let state: Value = serde_json::from_slice(&fs::read(root.join("remote.json")).map_err(|_| "尚未连接远程主机")?).map_err(|e| e.to_string())?;
        let url = state["url"].as_str().ok_or("远程主机地址无效")?.to_string();
        let token = keyring::Entry::new("vip.octopuses.host", &url).map_err(|e| e.to_string())?.get_password().map_err(|e| e.to_string())?;
        (url, token)
    } else { local_identity(&root)? };
    request_at(&url, &token, &route, body).await
}
#[tauri::command]
/// Exchange a one-time pairing code and store its token in the OS credential store.
pub async fn companion_connect(cache_path: String, url: String, code: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) { return Err("远程主机须使用 HTTPS；SSH 转发到本机端口时可用 HTTP".into()); }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "/" { return Err("请输入主机根地址，不含路径、账号或查询参数".into()); }
    let value = request_at(url.trim_end_matches('/'), "", "/pair", Some(json!({ "code": code.trim().to_uppercase(), "kind": "mobile" }))).await?;
    let token = value["token"].as_str().ok_or("主机没有返回配对令牌")?;
    keyring::Entry::new("vip.octopuses.host", &url).map_err(|e| e.to_string())?.set_password(token).map_err(|e| e.to_string())?;
    let root = host_dir(&cache_path)?; fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::write(root.join("remote.json"), json!({ "url": url }).to_string()).map_err(|e| e.to_string())
}
#[tauri::command]
/// Serialize startup so concurrent OAuth and inspector requests share one host.
pub async fn companion_start(app: tauri::AppHandle, cache_path: String, lan: bool) -> Result<Value, String> {
    let _startup = START_LOCK.lock().await;
    let root = host_dir(&cache_path)?;
    if let Ok((url, token)) = local_identity(&root) {
        if request_at(&url, &token, "/status", None).await.is_ok() { return Ok(json!({ "url": url, "alreadyRunning": true })); }
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let bundled = app.path().resource_dir().map_err(|e| e.to_string())?.join("companion/server.mjs");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../companion/server.mjs");
    let script = if bundled.is_file() { bundled } else if cfg!(debug_assertions) && source.is_file() { source } else { return Err("安装包缺少后台服务资源".into()); };
    let runtime = app.path().resource_dir().map_err(|e| e.to_string())?.join(if cfg!(windows) { "runtime/node.exe" } else { "runtime/node" });
    let node = if runtime.is_file() { runtime.to_string_lossy().into_owned() } else if cfg!(unix) {
        Command::new("/bin/sh").args(["-lc", "command -v node"]).output().ok().and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None }).unwrap_or_else(|| "node".into())
    } else { "node".into() };
    let log = fs::OpenOptions::new().create(true).append(true).open(root.join("host.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command.arg(script).arg("--directory").arg(&root).arg("--bind").arg(if lan { "0.0.0.0" } else { "127.0.0.1" })
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log));
    crate::platform::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| format!("启动后台服务失败，需要 Node.js 22 或更新版本：{e}"))?;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Err(format!("后台服务已退出（{status}），请查看 host/host.log")); }
        if let Ok((url, token)) = local_identity(&root) { if request_at(&url, &token, "/status", None).await.is_ok() { return Ok(json!({ "url": url, "lan": lan })); } }
    }
    Err("后台服务未就绪，请检查 host/host.log".into())
}
