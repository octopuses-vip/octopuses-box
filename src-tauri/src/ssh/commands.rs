use std::path::{Path, PathBuf};

use super::config::*;
use super::connect::*;
use super::exec::*;
use super::secret::*;
use super::sftp::*;
use super::types::*;

/// 列出全部远程主机（脱敏）（开发者 Jan）
#[tauri::command]
pub fn ssh_list_hosts(cache_dir: String) -> Result<Vec<SshHostView>, String> {
    Ok(redact_all(&load_hosts(Path::new(&cache_dir))?))
}

/// 查询凭据状态：本机凭据管理器是否可用 + 该主机是否已保存凭据（开发者 Jan）
#[tauri::command]
pub fn ssh_host_secret_status(host_id: String) -> SshSecretStatus {
    SshSecretStatus {
        available: keyring::Entry::store_status().is_ok(),
        has_secret: has_secret(&host_id),
    }
}

/// 新增或更新一条远程主机（开发者 Jan）
#[tauri::command]
pub fn ssh_save_host(cache_dir: String, input: SaveSshHostInput) -> Result<Vec<SshHostView>, String> {
    let hosts = save_host(Path::new(&cache_dir), input)?;
    Ok(redact_all(&hosts))
}

/// 删除一条远程主机（开发者 Jan）
#[tauri::command]
pub fn ssh_delete_host(
    cache_dir: String,
    input: DeleteSshHostInput,
) -> Result<Vec<SshHostView>, String> {
    let hosts = delete_host(Path::new(&cache_dir), input)?;
    Ok(redact_all(&hosts))
}

/// 测试连接：建连 + 认证，成功后回填 TOFU 指纹（开发者 Jan）
///
/// 连接层失败以 `ok: false` 返回而不是抛错，让界面把原因直接展示给用户。
#[tauri::command]
pub async fn ssh_test_connection(cache_dir: String, host_id: String) -> Result<SshTestResult, String> {
    let cache = PathBuf::from(&cache_dir);
    let host = find_host(&cache, &host_id)?;
    let secret = get_secret(&host.id)?;
    let connection = match open_connection(&host, secret).await {
        Ok(connection) => connection,
        Err(message) => {
            return Ok(SshTestResult {
                ok: false,
                message,
                fingerprint: None,
            })
        }
    };
    let fingerprint = connection.observed_fingerprint();
    // 首次连接在此确立信任；已有记录时该调用是空操作
    remember_fingerprint(&cache, &host.id, &fingerprint)?;
    connection.close().await?;
    Ok(SshTestResult {
        ok: true,
        message: format!(
            "连接成功：{}@{}:{}（{}）",
            host.username,
            host.host,
            host.port,
            describe_auth(host.auth)
        ),
        fingerprint,
    })
}

/// 认证方式的中文说明（开发者 Jan）
pub(super) fn describe_auth(auth: SshAuthKind) -> &'static str {
    match auth {
        SshAuthKind::Key => "私钥认证",
        SshAuthKind::Password => "密码认证",
    }
}

/// 在远端执行命令（开发者 Jan）
#[tauri::command]
pub async fn ssh_exec(
    cache_dir: String,
    host_id: String,
    command: String,
    timeout_secs: u64,
) -> Result<SshExecResult, String> {
    let cache = PathBuf::from(&cache_dir);
    let host = find_enabled_host(&cache, &host_id)?;
    if command.trim().is_empty() {
        return Err("远程命令不能为空。".to_string());
    }
    let secret = get_secret(&host.id)?;
    let connection = open_connection(&host, secret).await?;
    let result = run_command(&connection, &command, timeout_secs).await;
    connection.close().await?;
    result
}

/// 列出远端目录（开发者 Jan）
#[tauri::command]
pub async fn ssh_list_dir(
    cache_dir: String,
    host_id: String,
    path: String,
) -> Result<Vec<SshDirEntry>, String> {
    with_sftp(cache_dir, host_id, move |session| async move {
        list_dir(&session, &path).await
    })
    .await
}

/// 读取远端文件（开发者 Jan）
#[tauri::command]
pub async fn ssh_read_file(
    cache_dir: String,
    host_id: String,
    path: String,
) -> Result<SshFileContent, String> {
    with_sftp(cache_dir, host_id, move |session| async move {
        read_file(&session, &path).await
    })
    .await
}

/// 写入远端文件（开发者 Jan）
#[tauri::command]
pub async fn ssh_write_file(
    cache_dir: String,
    host_id: String,
    path: String,
    content: String,
) -> Result<String, String> {
    let path_label = path.clone();
    let written = with_sftp(cache_dir, host_id, move |session| async move {
        write_file(&session, &path, content.as_bytes()).await
    })
    .await?;
    Ok(format!("已写入 {path_label}（{written} 字节）"))
}
