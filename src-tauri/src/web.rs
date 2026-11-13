//! 网页抓取：为「联网检索 / 网页正文读取 / 附加上下文」提供统一的原生抓取能力。
//!
//! 放在 Rust 侧而不是前端 `fetch`，是为了绕开 WebView 的同源策略：WebView 里直接请求
//! 第三方站点会被 CORS 拦下（与 [`crate::model_proxy`] 的动机一致）。也正因如此，
//! 抓取不再经过 `run_shell` 拼接命令，从根上避免了各平台 shell 引号规则不一致的问题。
//!
//! 本模块只做**传输层**：取回字节、按响应字符集解码、限制体积。HTML 解析与正文抽取
//! 留在前端纯函数里（`src/tools/htmlText.ts`），便于单测与复用。
//!
//! 边界：只允许 `http` / `https`；响应体按 [`MAX_BODY_BYTES`] 流式截断；跟随重定向沿用
//! 共享客户端 reqwest 的默认上限（10 次）。非 2xx 不视为错误，状态码原样回传由调用方判断。

use std::time::Duration;

use encoding_rs::{Encoding, UTF_8};
use serde::Serialize;

use crate::client_api::http_client;

/// 抓取使用的浏览器 UA：部分站点对无 UA 的请求会返回精简页或直接拒绝
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/// 语言偏好：让搜索引擎与内容站点优先返回中文
const ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9";
/// 默认抓取超时（秒）；与改造前 curl 的 `--max-time` 保持一致
const DEFAULT_TIMEOUT_SECONDS: u64 = 25;
/// 调用方传入超时的下限与上限（秒）
const MIN_TIMEOUT_SECONDS: u64 = 1;
const MAX_TIMEOUT_SECONDS: u64 = 120;
/// 响应体字节上限（2 MiB）：搜索结果页远小于此值，正文页通常也够用
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// 嗅探 `<meta charset>` 时查看的头部字节窗口
const META_SNIFF_BYTES: usize = 2 * 1024;

/// 一次抓取的结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    /// 跟随重定向后的最终地址
    pub url: String,
    /// HTTP 状态码；非 2xx 同样按 [`Ok`] 返回
    pub status: u16,
    /// 已按响应字符集解码的响应体文本
    pub body: String,
    /// 原始 `Content-Type`，供调用方判断内容类型
    pub content_type: String,
    /// 是否因触达 [`MAX_BODY_BYTES`] 而被截断
    pub truncated: bool,
}

/// 校验并规整待抓取地址（开发者 Jan）。
///
/// 只放行 `http` / `https`，其余 scheme（`file:`、`javascript:` 等）一律拒绝并给出可读原因，
/// 避免把本地文件读取等非网页能力顺带暴露给模型。不做私网地址拦截——「读一下本地起的
/// 服务」是开发工具的正常用法。
fn validate_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("网页地址不能为空。".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("只支持 http:// 或 https:// 开头的网址。".to_string());
    }
    Ok(url.to_string())
}

/// 把可选超时收敛到合法区间（开发者 Jan）：缺省用默认值，越界时夹到上下限
fn resolve_timeout(timeout_secs: Option<u64>) -> Duration {
    let seconds = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
        .clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    Duration::from_secs(seconds)
}

/// 从 `Content-Type` 里取 `charset=` 参数（开发者 Jan）；没有则返回 [`None`]
fn charset_from_content_type(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    let index = lower.find("charset=")?;
    let rest = &content_type[index + "charset=".len()..];
    let value: String = rest
        .trim_start()
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// 在响应体头部嗅探 `<meta charset=...>`（开发者 Jan）。
///
/// 中文老站常只靠 meta 声明编码、响应头不带 charset，因此这是必要的一级回退。
/// 采用「找 charset 关键字 → 取等号后的取值」的宽松扫描，不做完整 HTML 解析。
fn sniff_meta_charset(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let index = text.find("charset")?;
    let rest = text[index + "charset".len()..].trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let value: String = rest
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// 判定响应体编码（开发者 Jan）：`Content-Type` → 头部 meta 嗅探 → UTF-8 兜底
fn resolve_encoding(content_type: &str, head: &[u8]) -> &'static Encoding {
    if let Some(label) = charset_from_content_type(content_type) {
        if let Some(encoding) = Encoding::for_label(label.as_bytes()) {
            return encoding;
        }
    }
    if let Some(label) = sniff_meta_charset(head) {
        if let Some(encoding) = Encoding::for_label(label.as_bytes()) {
            return encoding;
        }
    }
    UTF_8
}

/// 按编码解码响应体（开发者 Jan）；非法字节替换为替换字符，不 panic
fn decode_body(bytes: &[u8], encoding: &'static Encoding) -> String {
    encoding.decode(bytes).0.into_owned()
}

/// 把新到达的分片追加到缓冲，触达上限即截断（开发者 Jan）。
///
/// 返回 `true` 表示缓冲已满，调用方应停止读取。之所以逐片判断而不是先整体读回再截断，
/// 是为了让超大页面在下载途中就停下，不把内存撑爆。
fn append_within_limit(buffer: &mut Vec<u8>, chunk: &[u8], limit: usize) -> bool {
    let remaining = limit.saturating_sub(buffer.len());
    if chunk.len() >= remaining {
        buffer.extend_from_slice(&chunk[..remaining]);
        return true;
    }
    buffer.extend_from_slice(chunk);
    false
}

/// 把 reqwest 错误收敛成可直接展示的中文原因（开发者 Jan）
fn describe_fetch_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "抓取超时，目标站点没有在限定时间内响应。".to_string()
    } else if error.is_connect() {
        "无法连接到目标站点，请检查网络或网址是否正确。".to_string()
    } else if error.is_redirect() {
        "目标站点的重定向次数过多，已停止跟随。".to_string()
    } else if error.is_decode() || error.is_body() {
        "读取目标站点响应内容失败。".to_string()
    } else {
        format!("抓取失败：{error}")
    }
}

/// 抓取一个 http/https 网页并返回解码后的响应体（开发者 Jan）。
#[tauri::command]
pub async fn web_fetch(url: String, timeout_secs: Option<u64>) -> Result<WebFetchResult, String> {
    let target = validate_url(&url)?;
    let response = http_client()
        .get(&target)
        // UA 与语言只作用于本次请求：共享客户端还被登录、检查更新等接口复用，不能改全局默认
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(reqwest::header::ACCEPT_LANGUAGE, ACCEPT_LANGUAGE)
        .timeout(resolve_timeout(timeout_secs))
        .send()
        .await
        .map_err(|error| describe_fetch_error(&error))?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let mut buffer: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| describe_fetch_error(&error))?
    {
        if append_within_limit(&mut buffer, &chunk, MAX_BODY_BYTES) {
            truncated = true;
            break;
        }
    }

    // 编码判定要看原始头部字节，因此必须在解码之前完成
    let head = &buffer[..buffer.len().min(META_SNIFF_BYTES)];
    let body = decode_body(&buffer, resolve_encoding(&content_type, head));

    Ok(WebFetchResult {
        url: final_url,
        status,
        body,
        content_type,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert_eq!(validate_url(" https://example.com/a ").unwrap(), "https://example.com/a");
        assert_eq!(validate_url("http://example.com").unwrap(), "http://example.com");
        // scheme 大小写不敏感
        assert!(validate_url("HTTPS://example.com").is_ok());
    }

    #[test]
    fn rejects_non_http_scheme() {
        assert!(validate_url("").is_err());
        assert!(validate_url("   ").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("example.com").is_err());
    }

    #[test]
    fn timeout_is_clamped() {
        assert_eq!(resolve_timeout(None), Duration::from_secs(DEFAULT_TIMEOUT_SECONDS));
        assert_eq!(resolve_timeout(Some(0)), Duration::from_secs(MIN_TIMEOUT_SECONDS));
        assert_eq!(resolve_timeout(Some(9_999)), Duration::from_secs(MAX_TIMEOUT_SECONDS));
        assert_eq!(resolve_timeout(Some(10)), Duration::from_secs(10));
    }

    #[test]
    fn reads_charset_from_content_type() {
        assert_eq!(
            charset_from_content_type("text/html; charset=gbk"),
            Some("gbk".to_string())
        );
        assert_eq!(
            charset_from_content_type("text/html; charset=\"UTF-8\""),
            Some("UTF-8".to_string())
        );
        assert_eq!(charset_from_content_type("text/html"), None);
    }

    #[test]
    fn sniffs_meta_charset_case_insensitively() {
        let head = br#"<html><head><meta Charset="GB2312"></head>"#;
        assert_eq!(sniff_meta_charset(head), Some("gb2312".to_string()));
        let http_equiv = br#"<meta http-equiv="Content-Type" content="text/html; charset=gbk">"#;
        assert_eq!(sniff_meta_charset(http_equiv), Some("gbk".to_string()));
        assert_eq!(sniff_meta_charset(b"<html><body>hi</body></html>"), None);
    }

    #[test]
    fn resolves_encoding_with_fallback_chain() {
        // 1) Content-Type 优先
        assert_eq!(
            resolve_encoding("text/html; charset=gbk", b"<meta charset=\"utf-8\">"),
            encoding_rs::GBK
        );
        // 2) 头部没有 charset 时看 meta
        assert_eq!(
            resolve_encoding("text/html", b"<meta charset=\"gb2312\">"),
            encoding_rs::GBK
        );
        // 3) 都没有则 UTF-8
        assert_eq!(resolve_encoding("text/html", b"<html></html>"), UTF_8);
        // 4) 无法识别的 label 同样回退 UTF-8
        assert_eq!(resolve_encoding("text/html; charset=bogus-label", b""), UTF_8);
    }

    #[test]
    fn decodes_gbk_body() {
        // GBK 下的「中文」：D6 D0 CE C4
        let bytes = [0xD6u8, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode_body(&bytes, encoding_rs::GBK), "中文");
    }

    #[test]
    fn truncated_multibyte_tail_does_not_panic() {
        // 只截到三字节字符的前一个字节：应解出替换字符而不是 panic
        let text = decode_body(&[0xE4], UTF_8);
        assert!(!text.is_empty());
    }

    #[test]
    fn append_stops_at_limit() {
        let mut buffer = Vec::new();
        assert!(!append_within_limit(&mut buffer, b"abcd", 10));
        assert!(!append_within_limit(&mut buffer, b"ef", 10));
        // 剩余 4 字节空间，本次分片 6 字节 → 截断
        assert!(append_within_limit(&mut buffer, b"ghijkl", 10));
        assert_eq!(buffer, b"abcdefghij");
        assert_eq!(buffer.len(), 10);
    }
}
