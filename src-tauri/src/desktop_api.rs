//! Manages the desktop-owned API process. The parent pipe also defines the child's lifetime.
use crate::client_api::Endpoint;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
    time::timeout,
};

static RUNNING: Mutex<Option<RunningApi>> = Mutex::const_new(None);

#[derive(Clone, Serialize)]
pub struct ApiAccess {
    url: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Startup {
    Ready { port: u16, token: String },
    Error { error: String },
}

struct RunningApi {
    child: Child,
    input: ChildStdin,
    access: ApiAccess,
}

/// Keep API history under the same cache and account directory used for writing it.
pub(crate) fn data_directory(
    cache: &Path,
    local: bool,
    endpoint: Option<&Endpoint>,
    username: Option<&str>,
) -> Result<PathBuf, String> {
    let scope = if local {
        "local".to_string()
    } else {
        let endpoint = endpoint.ok_or("请先设置管理端地址。")?;
        endpoint.validate().map_err(|error| error.message)?;
        let username = username.filter(|value| !value.trim().is_empty()).ok_or("请先登录管理端。")?;
        let url = endpoint.base_url();
        format!("{:x}", Sha256::digest(format!("{url}\0{username}")))
    };
    Ok(cache.join("api-service").join(scope))
}

/// Drop stale state when the API process exits on its own.
fn active(running: &mut Option<RunningApi>) -> Result<Option<ApiAccess>, String> {
    if let Some(api) = running.as_mut() {
        if api.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Ok(Some(api.access.clone()));
        }
        *running = None;
    }
    Ok(None)
}

/// Report only the process owned by this app instance, never a standalone server on another port.
#[tauri::command]
pub async fn desktop_api_status() -> Result<Option<ApiAccess>, String> {
    active(&mut *RUNNING.lock().await)
}

/// Start with the confirmed desktop cache and current model source. Send credentials only over stdin.
#[tauri::command]
pub async fn desktop_api_start(
    app: AppHandle,
    cache_path: String,
    local: bool,
    endpoint: Option<Endpoint>,
    auth_token: Option<String>,
    username: Option<String>,
) -> Result<ApiAccess, String> {
    let mut running = RUNNING.lock().await;
    if let Some(access) = active(&mut running)? {
        return Ok(access);
    }
    let cache = std::fs::canonicalize(Path::new(&cache_path)).map_err(|_| "缓存目录不可用。")?;
    if !cache.is_dir() {
        return Err("请先设置有效的缓存目录。".into());
    }
    let directory = data_directory(&cache, local, endpoint.as_ref(), username.as_deref())?;
    let (management_url, session) = if local {
        (None, None)
    } else {
        let endpoint = endpoint.ok_or("请先设置管理端地址。")?;
        let session = auth_token.filter(|value| !value.is_empty()).ok_or("请先登录管理端。")?;
        (Some(endpoint.base_url()), Some(session))
    };

    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    let script = resources.join("api-service/desktop.mjs");
    let script = if script.is_file() {
        script
    } else if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../api-service/desktop.mjs")
    } else {
        return Err("安装包缺少本地 API 资源。".into());
    };
    let runtime = resources.join("runtime").join(format!("node{}", std::env::consts::EXE_SUFFIX));
    let runtime = if runtime.is_file() {
        runtime
    } else if cfg!(debug_assertions) {
        "node".into()
    } else {
        return Err("安装包缺少本地 API 运行时。".into());
    };

    let config = json!({
        "cacheDirectory": cache,
        "dataDirectory": directory,
        "local": local,
        "managementUrl": management_url,
        "managementSessionToken": session,
    });
    let mut command = Command::new(runtime);
    command
        .arg(script)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_USE_ENV_PROXY")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::platform::hide_console(command.as_std_mut());
    let mut child = command.spawn().map_err(|error| format!("无法启动本地 API：{error}"))?;
    let mut input = child.stdin.take().ok_or("无法建立本地 API 配置通道。")?;
    let output = child.stdout.take().ok_or("无法建立本地 API 状态通道。")?;
    let ready = timeout(Duration::from_secs(10), async {
        input.write_all(format!("{config}\n").as_bytes()).await.map_err(|_| "无法发送本地 API 配置。")?;
        let mut line = String::new();
        BufReader::new(output).read_line(&mut line).await.map_err(|_| "无法读取本地 API 启动状态。")?;
        serde_json::from_str::<Startup>(&line).map_err(|_| "本地 API 提前退出或启动响应无效。")
    }).await.map_err(|_| "本地 API 启动超时。")??;
    let access = match ready {
        Startup::Ready { port, token }
            if port > 0 && token.len() == 43
                && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') =>
        {
            ApiAccess { url: format!("http://127.0.0.1:{port}"), token }
        }
        Startup::Error { error } => return Err(error),
        Startup::Ready { .. } => return Err("本地 API 返回了无效地址或令牌。".into()),
    };
    *running = Some(RunningApi { child, input, access: access.clone() });
    Ok(access)
}

/// Ask the child to close its queue and database; force-stop it only if it fails to exit.
#[tauri::command]
pub async fn desktop_api_stop() -> Result<(), String> {
    let mut running = RUNNING.lock().await;
    if let Some(RunningApi { mut child, input, .. }) = running.take() {
        drop(input);
        match timeout(Duration::from_secs(5), child.wait()).await {
            Ok(status) => { status.map_err(|error| format!("无法确认本地 API 已停止：{error}"))?; }
            Err(_) => child.kill().await.map_err(|error| format!("无法停止本地 API：{error}"))?,
        }
    }
    Ok(())
}
