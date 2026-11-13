use std::path::PathBuf;

use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::config::*;
use super::connect::*;
use super::secret::*;
use super::types::*;

/// 打开一条 SFTP 子系统连接（开发者 Jan）
pub(super) async fn open_sftp(connection: &SshConnection) -> Result<SftpSession, String> {
    let channel = connection.open_session().await?;
    channel
        .request_subsystem(true, SFTP_SUBSYSTEM)
        .await
        .map_err(|error| format!("[{}] 启动 SFTP 子系统失败：{error}", connection.host_label))?;
    let session = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("[{}] 初始化 SFTP 会话失败：{error}", connection.host_label))?;
    session.set_timeout(SFTP_TIMEOUT_SECS);
    Ok(session)
}

/// 列出远端目录（开发者 Jan）
pub(super) async fn list_dir(session: &SftpSession, path: &str) -> Result<Vec<SshDirEntry>, String> {
    let mut entries: Vec<SshDirEntry> = session
        .read_dir(path)
        .await
        .map_err(|error| format!("读取远端目录失败（{path}）：{error}"))?
        .filter_map(|entry| {
            let name = entry.file_name();
            // 过滤 . 与 ..，避免模型把相对路径当成真实条目
            if name == "." || name == ".." {
                return None;
            }
            let metadata = entry.metadata();
            Some(SshDirEntry {
                name,
                path: entry.path(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            })
        })
        .collect();
    // 目录优先、同类按名称排序：与本地文件列表的观感一致
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

/// 读取远端文件内容（开发者 Jan）
///
/// 先用元数据判断大小以决定是否截断，再用带限长的读取避免大文件把内存打满。
pub(super) async fn read_file(session: &SftpSession, path: &str) -> Result<SshFileContent, String> {
    let mut file = session
        .open(path)
        .await
        .map_err(|error| format!("打开远端文件失败（{path}）：{error}"))?;
    let size = file
        .metadata()
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut buffer = Vec::new();
    (&mut file)
        .take(SFTP_READ_LIMIT)
        .read_to_end(&mut buffer)
        .await
        .map_err(|error| format!("读取远端文件失败（{path}）：{error}"))?;
    let _ = file.close().await;
    Ok(SshFileContent {
        path: path.to_string(),
        content: String::from_utf8_lossy(&buffer).into_owned(),
        truncated: size > SFTP_READ_LIMIT,
    })
}

/// 写入远端文件（开发者 Jan）
///
/// 使用 `create`（创建 + 截断 + 可写），与 SFTP 客户端自带的 `write` 不同——
/// 后者只带写标志，遇到新文件会失败、遇到旧文件不会截断。
pub(super) async fn write_file(session: &SftpSession, path: &str, content: &[u8]) -> Result<usize, String> {
    if content.len() > SFTP_WRITE_LIMIT {
        return Err(format!(
            "内容过大（{} 字节），超过单次写入上限 {} 字节。",
            content.len(),
            SFTP_WRITE_LIMIT
        ));
    }
    let mut file = session
        .create(path)
        .await
        .map_err(|error| format!("创建远端文件失败（{path}）：{error}"))?;
    file.write_all(content)
        .await
        .map_err(|error| format!("写入远端文件失败（{path}）：{error}"))?;
    file.close()
        .await
        .map_err(|error| format!("关闭远端文件失败（{path}）：{error}"))?;
    Ok(content.len())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// SFTP 调用模板：建连 → 打开 SFTP → 执行 → 关闭（开发者 Jan）
///
/// 三条 SFTP 命令共用同一套生命周期与错误前缀，抽在这里避免重复。
/// 由于 Rust 尚不支持对 `async` 闭包约束 `Send`，这里用泛型取代 `impl Future` 参数，
/// 保证返回的 Future 仍可满足 Tauri 命令的 `Send` 要求。
pub(super) async fn with_sftp<F, Fut, T>(cache_dir: String, host_id: String, action: F) -> Result<T, String>
where
    F: FnOnce(SftpSession) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let cache = PathBuf::from(&cache_dir);
    let host = find_enabled_host(&cache, &host_id)?;
    let secret = get_secret(&host.id)?;
    let connection = open_connection(&host, secret).await?;
    let result = match open_sftp(&connection).await {
        Ok(session) => action(session).await,
        Err(message) => Err(message),
    };
    connection.close().await?;
    result
}
