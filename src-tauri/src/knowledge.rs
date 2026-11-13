//! 可选知识库模型资源：只有显式下载才联网，固定版本、逐文件校验后安装。
//! 这里只管理资源与启用偏好；不把「资源就绪」当作「历史索引已建好」。

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, Manager};
use tokio::{
    io::AsyncWriteExt,
    sync::{watch, Mutex},
};

const CANCELLED: &str = "模型下载已取消";
const MODEL_DOWNLOAD_BASE_URL: &str = "https://modelscope.cn/models";
// ModelScope's LFS CDN rejects requests without a User-Agent, including after redirects.
const MODEL_DOWNLOAD_USER_AGENT: &str = concat!(
    "octopuses/",
    env!("CARGO_PKG_VERSION"),
    " knowledge-model-downloader"
);

pub struct KnowledgeState {
    operation: Mutex<()>,
    cancel: watch::Sender<bool>,
}

impl Default for KnowledgeState {
/// 函数级说明（开发者 Jan）：执行 default 的单一职责，并返回可供调用方继续处理的结果。
    fn default() -> Self {
        Self {
            operation: Mutex::new(()),
            cancel: watch::channel(false).0,
        }
    }
}

#[derive(Deserialize)]
struct ModelManifest {
    id: String,
    repository: String,
    revision: String,
    // 镜像仓库的提交与本地资源版本分开，换源不影响已安装模型和向量索引。
    #[serde(rename = "downloadRevision")]
    download_revision: String,
    files: Vec<ModelFile>,
}

#[derive(Deserialize)]
struct ModelFile {
    path: String,
    bytes: u64,
    sha256: String,
}

/// 函数级说明（开发者 Jan）：执行 manifest 的单一职责，并返回可供调用方继续处理的结果。
fn manifest() -> ModelManifest {
    serde_json::from_str(include_str!("../../src/knowledge/model-manifest.json"))
        .expect("内置模型清单无效")
}

#[derive(Default, Deserialize, Serialize)]
struct Preferences {
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    enabled: bool,
    ready: bool,
    installed: bool,
    model_dir: String,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: u64,
    total: u64,
    file: String,
}

/// 函数级说明（开发者 Jan）：执行 root 的单一职责，并返回可供调用方继续处理的结果。
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("knowledge"))
        .map_err(|error| format!("获取模型目录失败：{error}"))
}

/// 仅暴露清单内已校验的模型资源，以二进制 IPC 传输，避免模型走 JSON/base64 膨胀。
#[tauri::command]
pub async fn knowledge_model_asset(
    app: tauri::AppHandle,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let model = manifest();
        let prefs = crate::json_store::read_json::<Preferences>(&root.join("settings.json"))?
            .unwrap_or_default();
        if !prefs.enabled {
            return Err("向量模型未启用".to_string());
        }
        let file = model
            .files
            .iter()
            .find(|file| file.path == name)
            .ok_or("未知模型资源")?;
        let path = model_dir(&root, &model).join(&file.path);
        if !verify_file(&path, file) {
            return Err("模型文件缺失或校验失败，请重新下载".into());
        }
        fs::read(path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 函数级说明（开发者 Jan）：执行 model_dir 的单一职责，并返回可供调用方继续处理的结果。
fn model_dir(root: &Path, model: &ModelManifest) -> PathBuf {
    root.join(&model.id).join(&model.revision)
}

/// 函数级说明（开发者 Jan）：执行 total_bytes 的单一职责，并返回可供调用方继续处理的结果。
fn total_bytes(model: &ModelManifest) -> u64 {
    model.files.iter().map(|file| file.bytes).sum()
}

/// 函数级说明（开发者 Jan）：执行 verify_file 的单一职责，并返回可供调用方继续处理的结果。
fn verify_file(path: &Path, expected: &ModelFile) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if !file
        .metadata()
        .is_ok_and(|meta| meta.is_file() && meta.len() == expected.bytes)
    {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let Ok(count) = file.read(&mut buffer) else {
            return false;
        };
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    format!("{:x}", hash.finalize()) == expected.sha256
}

/// 函数级说明（开发者 Jan）：执行 status 的单一职责，并返回可供调用方继续处理的结果。
fn status(root: &Path, model: &ModelManifest) -> Result<ModelStatus, String> {
    let prefs = crate::json_store::read_json::<Preferences>(&root.join("settings.json"))?
        .unwrap_or_default();
    let directory = model_dir(root, model);
    let ready = model
        .files
        .iter()
        .all(|file| verify_file(&directory.join(&file.path), file));
    Ok(ModelStatus {
        enabled: prefs.enabled && ready,
        ready,
        installed: directory.exists(),
        model_dir: directory.to_string_lossy().into_owned(),
        total_bytes: total_bytes(model),
    })
}

/// 函数级说明（开发者 Jan）：执行 save_enabled 的单一职责，并返回可供调用方继续处理的结果。
fn save_enabled(root: &Path, enabled: bool) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("创建模型目录失败：{error}"))?;
    crate::json_store::write_json(&root.join("settings.json"), &Preferences { enabled })
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 knowledge_model_status 的单一职责，并返回可供调用方继续处理的结果。
pub async fn knowledge_model_status(app: tauri::AppHandle) -> Result<ModelStatus, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || status(&root, &manifest()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 knowledge_model_set_enabled 的单一职责，并返回可供调用方继续处理的结果。
pub async fn knowledge_model_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, KnowledgeState>,
    enabled: bool,
) -> Result<ModelStatus, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "模型正在下载，请先取消下载")?;
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let model = manifest();
        if enabled && !status(&root, &model)?.ready {
            return Err("请先下载完整的向量模型".into());
        }
        save_enabled(&root, enabled)?;
        status(&root, &model)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 knowledge_model_cancel 的单一职责，并返回可供调用方继续处理的结果。
pub fn knowledge_model_cancel(state: tauri::State<'_, KnowledgeState>) {
    state.cancel.send_replace(true);
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 knowledge_model_remove 的单一职责，并返回可供调用方继续处理的结果。
pub async fn knowledge_model_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, KnowledgeState>,
) -> Result<ModelStatus, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "模型正在下载，请先取消下载")?;
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let model = manifest();
        save_enabled(&root, false)?;
        let directory = root.join(&model.id);
        if directory.exists() {
            fs::remove_dir_all(directory).map_err(|error| format!("删除模型失败：{error}"))?;
        }
        status(&root, &model)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 函数级说明（开发者 Jan）：执行 fetch_model 的单一职责，并返回可供调用方继续处理的结果。
async fn fetch_model(
    model: &ModelManifest,
    staging: &Path,
    progress: &Channel<DownloadProgress>,
    base_url: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(MODEL_DOWNLOAD_USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?;
    let total = total_bytes(model);
    let mut downloaded = 0;
    let mut last_emit = Instant::now();
    for file in &model.files {
        let path = staging.join(&file.path);
        tokio::fs::create_dir_all(path.parent().ok_or("无效模型路径")?)
            .await
            .map_err(|error| error.to_string())?;
        let _ = progress.send(DownloadProgress {
            downloaded,
            total,
            file: file.path.clone(),
        });
        let url = format!(
            "{}/{}/resolve/{}/{}",
            base_url, model.repository, model.download_revision, file.path
        );
        let mut response = client
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| {
                format!("下载 {} 失败：{}。请重试。", file.path, error.without_url())
            })?;
        let mut output = tokio::fs::File::create(&path)
            .await
            .map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        let mut received = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取模型下载失败：{error}"))?
        {
            received += chunk.len() as u64;
            if received > file.bytes {
                return Err(format!("{} 超出预期大小", file.path));
            }
            hash.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|error| format!("写入模型失败：{error}"))?;
            downloaded += chunk.len() as u64;
            if last_emit.elapsed() >= Duration::from_millis(100) {
                let _ = progress.send(DownloadProgress {
                    downloaded,
                    total,
                    file: file.path.clone(),
                });
                last_emit = Instant::now();
            }
        }
        output.flush().await.map_err(|error| error.to_string())?;
        if received != file.bytes || format!("{:x}", hash.finalize()) != file.sha256 {
            return Err(format!("{} 完整性校验失败，请重新下载", file.path));
        }
    }
    Ok(())
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 knowledge_model_download 的单一职责，并返回可供调用方继续处理的结果。
pub async fn knowledge_model_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, KnowledgeState>,
    progress: Channel<DownloadProgress>,
) -> Result<ModelStatus, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有模型操作正在进行")?;
    state.cancel.send_replace(false);
    let cancel = state.cancel.subscribe();
    let root = root(&app)?;
    download_into(root, manifest(), progress, cancel, MODEL_DOWNLOAD_BASE_URL).await
}

/// 函数级说明（开发者 Jan）：执行 download_into 的单一职责，并返回可供调用方继续处理的结果。
async fn download_into(
    root: PathBuf,
    model: ModelManifest,
    progress: Channel<DownloadProgress>,
    mut cancel: watch::Receiver<bool>,
    base_url: &str,
) -> Result<ModelStatus, String> {
    let directory = model_dir(&root, &model);
    // 重启遗留的临时文件永远不被当作已安装资源；重试从干净目录开始。
    let staging = root.join(format!(".download-{}", model.id));
    if staging.exists() {
        tokio::fs::remove_dir_all(&staging)
            .await
            .map_err(|error| error.to_string())?;
    }
    let result = tokio::select! {
        biased;
        _ = cancel.changed() => Err(CANCELLED.to_string()),
        result = fetch_model(&model, &staging, &progress, base_url) => result,
    };
    if let Err(error) = result {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }
    // 下载到临时目录，全部校验成功后才发布到正式版本目录。
    let install = tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(directory.parent().ok_or("无效模型目录")?)
            .map_err(|error| error.to_string())?;
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
        }
        fs::rename(&staging, &directory).map_err(|error| format!("安装模型失败：{error}"))?;
        save_enabled(&root, true)?;
        status(&root, &model)
    })
    .await
    .map_err(|error| error.to_string())??;
    let _ = progress.send(DownloadProgress {
        downloaded: install.total_bytes,
        total: install.total_bytes,
        file: String::new(),
    });
    Ok(install)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    #[ignore = "explicit live-network download into a disposable test directory"]
    async fn live_modelscope_download_verifies_all_manifest_resources() {
        let root = scratch("live-download");
        let (_cancel, receiver) = watch::channel(false);
        let result = download_into(
            root.clone(),
            manifest(),
            Channel::new(|_| Ok(())),
            receiver,
            MODEL_DOWNLOAD_BASE_URL,
        )
        .await;
        let _ = fs::remove_dir_all(&root);
        let status = result.expect("真实 ModelScope 下载失败");
        assert!(status.ready && status.enabled);
        assert_eq!(status.total_bytes, total_bytes(&manifest()));
    }

    fn test_model() -> ModelManifest {
        ModelManifest {
            id: "test".into(),
            repository: "test/test".into(),
            revision: "revision".into(),
            download_revision: "download-revision".into(),
            files: vec![ModelFile {
                path: "onnx/model.onnx".into(),
                bytes: 3,
                sha256: format!("{:x}", Sha256::digest(b"abc")),
            }],
        }
    }

    async fn serve(body: &'static [u8]) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).await.unwrap();
            let request = std::str::from_utf8(&request[..count]).unwrap();
            assert!(request.to_ascii_lowercase().contains(&format!(
                "\r\nuser-agent: {}\r\n",
                MODEL_DOWNLOAD_USER_AGENT
            )));
            assert!(request.starts_with(
                "GET /test/test/resolve/download-revision/onnx/model.onnx HTTP/1.1\r\n"
            ));
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        (url, handle)
    }

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("octopuses-knowledge-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn download_identifies_application_on_origin_and_redirected_cdn() {
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cdn = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", origin.local_addr().unwrap());
        let location = format!(
            "http://{}/model?auth_key=test-signature",
            cdn.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            for (listener, redirect) in [(origin, true), (cdn, false)] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let count = socket.read(&mut request).await.unwrap();
                let request = std::str::from_utf8(&request[..count])
                    .unwrap()
                    .to_ascii_lowercase();
                assert!(request.contains(&format!(
                    "\r\nuser-agent: {}\r\n",
                    MODEL_DOWNLOAD_USER_AGENT
                )));
                let response = if redirect {
                    format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
                        .to_string()
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let root = scratch("cdn-redirect");
        let (_cancel, receiver) = watch::channel(false);
        let installed = download_into(
            root.clone(),
            test_model(),
            Channel::new(|_| Ok(())),
            receiver,
            &base,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(installed.ready && installed.enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn download_error_omits_cdn_signed_query_and_cleans_staging() {
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", origin.local_addr().unwrap());
        let location = format!("{base}/model?auth_key=private-signature");
        let server = tokio::spawn(async move {
            for redirect in [true, false] {
                let (mut socket, _) = origin.accept().await.unwrap();
                let mut request = [0; 4096];
                socket.read(&mut request).await.unwrap();
                let response = if redirect {
                    format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                } else {
                    "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let root = scratch("cdn-forbidden");
        let (_cancel, receiver) = watch::channel(false);
        let error = download_into(
            root.clone(),
            test_model(),
            Channel::new(|_| Ok(())),
            receiver,
            &base,
        )
        .await
        .err()
        .unwrap();
        server.await.unwrap();
        assert!(error.contains("403"));
        assert!(error.contains("onnx/model.onnx"));
        assert!(!error.contains("private-signature"));
        assert!(!error.contains("auth_key"));
        assert!(!root.join(".download-test").exists());
        assert!(!status(&root, &test_model()).unwrap().enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_model_is_disabled_even_with_enabled_preference() {
        let root = scratch("missing");
        let model = manifest();
        assert!(!status(&root, &model).unwrap().enabled);
        save_enabled(&root, true).unwrap();
        assert!(!status(&root, &model).unwrap().enabled);
        assert!(!status(&root, &model).unwrap().ready);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checks_content_not_just_size_and_preserves_disabled_model() {
        let root = scratch("integrity");
        let model = ModelManifest {
            id: "test".into(),
            repository: "test/test".into(),
            revision: "revision".into(),
            download_revision: "download-revision".into(),
            files: vec![ModelFile {
                path: "model.onnx".into(),
                bytes: 3,
                sha256: format!("{:x}", Sha256::digest(b"abc")),
            }],
        };
        let directory = model_dir(&root, &model);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("model.onnx"), b"abc").unwrap();
        save_enabled(&root, true).unwrap();
        assert!(status(&root, &model).unwrap().enabled);
        save_enabled(&root, false).unwrap();
        let disabled = status(&root, &model).unwrap();
        assert!(disabled.ready);
        assert!(!disabled.enabled);
        fs::write(directory.join("model.onnx"), b"xyz").unwrap();
        assert!(!status(&root, &model).unwrap().ready);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_has_expected_complete_resources() {
        let model = manifest();
        assert_eq!(model.files.len(), 6);
        assert_eq!(total_bytes(&model), 24_560_715);
        for file in model.files {
            assert!(!file.path.starts_with('/'));
            assert!(!file.path.contains(".."));
            assert_eq!(file.sha256.len(), 64);
        }
    }

    #[tokio::test]
    async fn download_rejects_corruption_cleans_staging_and_can_retry() {
        let root = scratch("download");
        let (_cancel, receiver) = watch::channel(false);
        for body in [b"xyz".as_slice(), b"a".as_slice(), b"abcd".as_slice()] {
            let (url, server) = serve(body).await;
            let result = download_into(
                root.clone(),
                test_model(),
                Channel::new(|_| Ok(())),
                receiver.clone(),
                &url,
            )
            .await;
            assert!(result.is_err());
            server.await.unwrap();
            assert!(!root.join(".download-test").exists());
            assert!(!status(&root, &test_model()).unwrap().ready);
            assert!(!root.join("settings.json").exists());
        }
        let (url, server) = serve(b"abc").await;
        let installed = download_into(
            root.clone(),
            test_model(),
            Channel::new(|_| Ok(())),
            receiver,
            &url,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(installed.ready && installed.enabled);
        // 模拟重启后重读磁盘；就绪状态不能依赖内存里的下载成功标志。
        assert!(status(&root, &test_model()).unwrap().enabled);
        assert!(!root.join(".download-test").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_waiting_network_and_removes_partial_files() {
        let root = scratch("cancel");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (connected, connection) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na")
                .await
                .unwrap();
            connected.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let (cancel, receiver) = watch::channel(false);
        let download_root = root.clone();
        let download = tokio::spawn(async move {
            download_into(
                download_root,
                test_model(),
                Channel::new(|_| Ok(())),
                receiver,
                &url,
            )
            .await
        });
        connection.await.unwrap();
        cancel.send_replace(true);
        let error = tokio::time::timeout(Duration::from_secs(2), download)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(error, CANCELLED);
        assert!(!root.join(".download-test").exists());
        assert!(!status(&root, &test_model()).unwrap().enabled);
        server.abort();
        fs::remove_dir_all(root).unwrap();
    }
}
