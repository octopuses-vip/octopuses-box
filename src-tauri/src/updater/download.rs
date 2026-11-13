use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

use crate::client_api::{ApiError, CODE_NETWORK_ERROR};

/// 下载进度事件名，前端据此渲染进度条
pub const PROGRESS_EVENT: &str = "update-download-progress";

/// 安装包临时目录名（位于系统临时目录下），与用户数据目录分开存放，便于整体清理。
///
/// 客户端的启动／退出追踪日志也落在这里（见 [`crate::trace`]），排查时两组日志同目录可对照。
pub(crate) const TEMP_DIR_NAME: &str = "octopuses-update";

/// 响应头里给不出文件名时的兜底名：没有扩展名只会影响静默安装方式，不影响能否启动安装包
pub(super) const FALLBACK_FILE_NAME: &str = "octopuses-update-package";

/// 下载进度事件负载（字段名与前端约定的 camelCase 一致）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadProgress {
    /// 已下载字节数
    downloaded: u64,
    /// 安装包总字节数；服务端未给出时为 0，此时界面只显示已下载量
    total: u64,
    /// 下载百分比（0-100），总量未知时为 0
    percent: u8,
}

/// 构造下载相关的错误：与接口错误共用同一结构，前端只需处理一种错误形态
pub(super) fn download_error(message: String) -> ApiError {
    ApiError {
        code: CODE_NETWORK_ERROR,
        message,
    }
}

/// 把安装包流式下载到临时目录，边下边推送进度。
///
/// `expected_size` 取自「检查更新」的 `fileSize`：既作为进度总量的兜底，也用于下载完成后
/// 校验完整性，避免把截断的文件交给安装程序（安装到一半失败比直接报错更难排查）。
pub(super) async fn download_package(
    app: &AppHandle,
    url: &str,
    expected_size: i64,
) -> Result<PathBuf, ApiError> {
    // 地址来自服务端下发的更新信息，属于系统边界：只接受 http(s)，避免被伪造成本地路径执行
    let key = crate::update_signature::trusted_key().map_err(download_error)?;
    let signature = crate::update_signature::fetch_signature(url).await.map_err(download_error)?;
    let mut verifier = key.verify_stream(&signature)
        .map_err(|_| download_error("更新签名不支持或公钥不匹配".into()))?;

    let mut response = reqwest::Client::builder().https_only(true)
        .timeout(std::time::Duration::from_secs(1800)).build()
        .map_err(|_| download_error("无法创建更新下载连接".into()))?
        .get(url)
        .send()
        .await
        .map_err(|error| download_error(format!("下载安装包失败：{error}")))?;
    if !response.status().is_success() {
        return Err(ApiError {
            code: response.status().as_u16() as i32,
            message: format!("下载安装包失败（HTTP {}）", response.status().as_u16()),
        });
    }

    // 安装包类型决定静默安装方式，因此必须沿用服务端给出的原始文件名而不是自造名字
    let target = temp_dir().join(package_file_name(&response));
    let mut file = std::fs::File::create(&target)
        .map_err(|error| download_error(format!("创建安装包文件失败：{error}")))?;

    let total = response
        .content_length()
        .filter(|value| *value > 0)
        .or_else(|| u64::try_from(expected_size).ok().filter(|value| *value > 0))
        .unwrap_or(0);

    let mut written: u64 = 0;
    // 只在百分比变化时推送：安装包动辄上百 MB，逐块推送会把事件通道淹没
    let mut reported: Option<u8> = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| download_error(format!("下载安装包中断：{error}")))?
    {
        file.write_all(&chunk)
            .map_err(|error| download_error(format!("写入安装包失败：{error}")))?;
        written += chunk.len() as u64;
        verifier.update(&chunk);

        let percent = percent_of(written, total);
        if reported != Some(percent) {
            reported = Some(percent);
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    downloaded: written,
                    total,
                    percent,
                },
            );
        }
    }
    file.flush()
        .map_err(|error| download_error(format!("写入安装包失败：{error}")))?;
    drop(file);

    if expected_size > 0 && written != expected_size as u64 {
        // 残缺的安装包留在临时目录只会误导下一次更新，直接删掉
        let _ = std::fs::remove_file(&target);
        return Err(download_error(format!(
            "安装包下载不完整（应为 {expected_size} 字节，实际 {written} 字节），请重试。"
        )));
    }
    if verifier.finalize().is_err() {
        let _ = std::fs::remove_file(&target);
        return Err(download_error("更新包签名验证失败，已取消安装".into()));
    }
    Ok(target)
}

/// 把路径包成 PowerShell 单引号字符串：内部单引号按 PowerShell 规则翻倍转义，
/// 双引号与反斜杠在单引号串里无需处理，从而避免命令行引号嵌套出错。
pub(super) fn ps_quote_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// 安装包落盘的临时目录，不存在时创建
pub(crate) fn temp_dir() -> PathBuf {
    let directory = std::env::temp_dir().join(TEMP_DIR_NAME);
    let _ = std::fs::create_dir_all(&directory);
    directory
}

/// 从响应的 `Content-Disposition` 解出安装包文件名；解不出时用兜底名。
///
/// 服务端以 `send_file(download_name=...)` 下发原始文件名，中文名会走 RFC 5987 的
/// `filename*=UTF-8''%xx` 形式，因此两种写法都要认。
pub(super) fn package_file_name(response: &reqwest::Response) -> String {
    let header = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    extract_file_name(header).unwrap_or_else(|| FALLBACK_FILE_NAME.to_string())
}

/// 从 `Content-Disposition` 头部解析文件名。
///
/// 优先取 RFC 5987 的 `filename*`（带字符集与前缀，需要百分号解码），其次取普通 `filename`。
/// 结果只保留最后一段路径，避免服务端给出的名字里带上目录分隔符而写到临时目录之外。
pub(super) fn extract_file_name(header: &str) -> Option<String> {
    let mut plain: Option<String> = None;
    for part in header.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "filename*" => {
                // 形如 UTF-8''%E5%AE%89%E8%A3%85.exe：字符集与前缀之后才是文件名
                let encoded = value
                    .split_once("''")
                    .map(|(_, rest)| rest)
                    .unwrap_or(value);
                return sanitize_file_name(&percent_decode(encoded));
            }
            "filename" => plain = Some(unquote(value).to_string()),
            _ => {}
        }
    }
    plain.and_then(|name| sanitize_file_name(&name))
}

/// 去掉包裹文件名的引号
pub(super) fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value)
}

/// 只保留文件名本身并挡掉空名与目录穿越，保证落盘位置始终在临时目录内
pub(super) fn sanitize_file_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if base.is_empty() || base == "." || base == ".." {
        return None;
    }
    Some(base.to_string())
}

/// 解开 RFC 5987 的百分号编码：`%xx` 还原为字节后整体按 UTF-8 解码，其余字符原样保留
pub(super) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let is_escape = bytes[index] == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit();
        if is_escape {
            let high = (bytes[index + 1] as char).to_digit(16).unwrap_or(0) as u8;
            let low = (bytes[index + 2] as char).to_digit(16).unwrap_or(0) as u8;
            decoded.push(high * 16 + low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// 下载百分比：总量未知时返回 0，避免除零
pub(super) fn percent_of(written: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    ((written.saturating_mul(100) / total).min(100)) as u8
}
