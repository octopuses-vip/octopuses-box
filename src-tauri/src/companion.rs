//! Local browser bridge with an upgrade path for legacy task hosts.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

const VERSION: u32 = 3;
const LEGACY_TASK_VERSION: u64 = 1;
static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CHILDREN: Mutex<Vec<Child>> = Mutex::new(Vec::new());

#[derive(Deserialize)]
struct HostIdentity {
    port: u16,
    pid: u32,
    token: String,
    #[serde(default)]
    version: u32,
}

/// Resolve bridge state inside the selected cache directory.
fn host_dir(cache_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(cache_path).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("缓存目录不可用".into());
    }
    Ok(root.join("host"))
}

/// Read the address and credentials of the app-owned loopback bridge.
fn local_identity(root: &Path) -> Result<HostIdentity, String> {
    let bytes = fs::read(root.join("state.json")).map_err(|_| "浏览器连接服务尚未启动")?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Skip proxies and redirects so local credentials never leave loopback.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Send a structured request to an explicitly chosen loopback route.
async fn request_at(
    host: &HostIdentity,
    route: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let client = http_client()?;
    let url = format!("http://127.0.0.1:{}{route}", host.port);
    let request = match body {
        Some(body) => client.post(url).json(&body),
        None => client.get(url),
    };
    let response = request
        .bearer_auth(&host.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("本地连接请求失败")
            .to_string());
    }
    Ok(value)
}

/// Identify the host before sending a shutdown request to a possibly reused local port.
async fn protocol(port: u16) -> Option<u64> {
    let response = http_client()
        .ok()?
        .get(format!("http://127.0.0.1:{port}/health"))
        .timeout(Duration::from_secs(1))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let value: Value = response.json().await.ok()?;
    if value["name"] != "octopuses-host" {
        return None;
    }
    value["version"].as_u64()
}

/// Retire the previous job host through its authenticated shutdown endpoint without deleting data.
async fn retire_legacy(root: &Path) -> Result<(), String> {
    let Ok(host) = local_identity(root) else {
        return Ok(());
    };
    if u64::from(host.version) > LEGACY_TASK_VERSION
        || protocol(host.port).await != Some(LEGACY_TASK_VERSION)
    {
        return Ok(());
    }
    request_at(&host, "/shutdown", Some(json!({}))).await?;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if protocol(host.port).await != Some(LEGACY_TASK_VERSION) {
            return Ok(());
        }
    }
    Err("旧版后台任务服务尚未退出。".into())
}

#[tauri::command]
/// Run legacy host retirement when the installed app opens a cache directory.
pub async fn companion_retire_legacy(cache_path: String) -> Result<(), String> {
    let _startup = START_LOCK.lock().await;
    retire_legacy(&host_dir(&cache_path)?).await
}

#[tauri::command]
/// Locate packaged integration resources, with source fallback only in development.
pub fn integration_paths(app: tauri::AppHandle) -> Result<Value, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let choose = |name: &str| {
        let bundled = resources.join(name);
        if bundled.exists() {
            bundled
        } else if cfg!(debug_assertions) {
            source.join(name)
        } else {
            bundled
        }
    };
    Ok(
        json!({ "browserExtension": choose("browser-extension").to_string_lossy(), "companion": choose("companion").to_string_lossy() }),
    )
}
#[tauri::command]
/// Build the packaged runner image on explicit user request.
pub async fn prepare_container(app: tauri::AppHandle) -> Result<String, String> {
    let resources = integration_paths(app)?;
    let directory = resources["companion"]
        .as_str()
        .ok_or("容器环境资源缺失")?
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("docker");
        command
            .args(["build", "--tag", "octopuses-runner:local", &directory])
            .stdin(Stdio::null());
        crate::platform::hide_console(&mut command);
        let output = command
            .output()
            .map_err(|e| format!("需要先安装并启动 Docker：{e}"))?;
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if output.status.success() {
            Ok("本地隔离环境已准备完成".to_string())
        } else {
            Err(text.chars().take(16000).collect())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
/// The WebView only needs browser pairing and the approved browser action relay.
pub async fn companion_request(
    cache_path: String,
    route: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !matches!(route.as_str(), "/pair-code" | "/revoke" | "/browser/action") {
        return Err("不支持的浏览器连接接口。".into());
    }
    let host = local_identity(&host_dir(&cache_path)?)?;
    if host.version != VERSION {
        return Err("请从浏览器面板启动新版连接服务。".into());
    }
    request_at(&host, &route, body).await
}

#[tauri::command]
/// Start or reuse the loopback integration bridge and retain the previous port when available.
pub async fn companion_start(app: tauri::AppHandle, cache_path: String) -> Result<Value, String> {
    let _startup = START_LOCK.lock().await;
    let root = host_dir(&cache_path)?;
    let previous = local_identity(&root).ok();
    if let Some(host) = &previous {
        if host.version == VERSION
            && protocol(host.port).await == Some(u64::from(VERSION))
            && request_at(host, "/status", None).await.is_ok()
        {
            return Ok(json!({ "url": format!("http://127.0.0.1:{}", host.port) }));
        }
    }
    retire_legacy(&root).await?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bundled = resources.join("companion/server.mjs");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../companion/server.mjs");
    let script = if bundled.is_file() {
        bundled
    } else if cfg!(debug_assertions) && source.is_file() {
        source
    } else {
        return Err("安装包缺少浏览器连接服务资源".into());
    };
    let runtime = resources.join(if cfg!(windows) {
        "runtime/node.exe"
    } else {
        "runtime/node"
    });
    let node = if runtime.is_file() {
        runtime.into_os_string()
    } else {
        "node".into()
    };
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("host.log"))
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command
        .arg(script)
        .arg("--directory")
        .arg(&root)
        .arg("--port")
        .arg(previous.map_or(0, |host| host.port).to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    crate::platform::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动浏览器连接服务失败：{e}"))?;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("连接服务已退出（{status}），请查看 host/host.log"));
        }
        let Ok(host) = local_identity(&root) else {
            continue;
        };
        if host.version != VERSION || host.pid != child.id() {
            continue;
        }
        if request_at(&host, "/status", None).await.is_ok() {
            CHILDREN
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(child);
            return Ok(json!({ "url": format!("http://127.0.0.1:{}", host.port) }));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("连接服务未就绪，请检查 host/host.log".into())
}

/// Stop integration processes owned by this app when it exits.
pub(crate) fn stop_children() {
    for mut child in CHILDREN.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
        let _ = child.kill();
        let _ = child.wait();
    }
}
