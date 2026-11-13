//! 模型服务请求代理。
//!
//! 桌面窗口（WKWebView）里直接 `fetch` 模型网关会被跨域校验拦下：管理端下发的网关在**成功响应**
//! 中回了两条 `Access-Control-Allow-Origin`，而该响应头不是列表型头，按 Fetch 规范出现多个取值
//! 即判定为跨域失败，前端只能拿到 `TypeError: Load failed`（失败响应只回一条，所以 401 反而「正常」）。
//! 第三方网关的行为客户端改不了，因此把模型请求整体挪到 Rust 侧发起，前端只消费回传结果。
//!
//! 这里刻意**不解析 OpenAI 协议**：请求体仍由前端构造，Rust 只负责「注入 Bearer、发出去、
//! 把原始 SSE 文本按块回传」。协议实现只在前端存在一份，避免两处各写一遍再各自维护。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use futures::channel::oneshot;
use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::client_api::client_for;

/// 流式分片的事件名；前端按事件里的 `requestId` 区分并行会话
const STREAM_EVENT: &str = "model-stream";

/// 进行中请求的取消句柄表。
///
/// 停止按钮与请求超时都要能**即时**掐断上游连接：`reqwest` 的响应流只有被丢弃时才关闭，
/// 单靠前端不再消费并不会让上游停下来，因此把取消信号的发送端托管在这里，
/// 由 [`model_abort`] 取出并触发。
#[derive(Default)]
pub struct ModelProxyState {
    /// requestId → 取消信号
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ModelProxyState {
    /// 取句柄表；锁中毒说明别的请求在持锁时 panic 过，此时数据仍可用，继续复用而不是再 panic
    fn inflight(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<()>>> {
        self.inflight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 登记一次请求，返回取消信号的接收端供请求任务 `select!` 监听
    fn begin(&self, request_id: &str) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        self.inflight().insert(request_id.to_string(), sender);
        receiver
    }

    /// 注销一次请求；正常结束与主动中断都要调用，否则句柄表会一直增长
    fn finish(&self, request_id: &str) {
        self.inflight().remove(request_id);
    }

    /// 触发一次取消；句柄不存在说明请求已结束，忽略即可
    fn cancel(&self, request_id: &str) {
        if let Some(sender) = self.inflight().remove(request_id) {
            let _ = sender.send(());
        }
    }
}

/// 回传给前端的流式事件。
///
/// 各类字段一次性备好并跳过 `None`：前端按 `kind` 分发即可，不必为每种事件准备不同形状的类型。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEvent<'a> {
    /// 事件种类：`chunk` / `done` / `httpError` / `error` / `aborted`
    kind: &'a str,
    /// 关联的请求 id
    request_id: &'a str,
    /// `chunk` 携带的原始 SSE 文本
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    /// `httpError` 携带的上游状态码
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    /// `httpError` 携带的上游响应体原文
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    /// `error` 携带的传输层失败原因
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// 构造一个只填了必填字段的事件，其余字段由调用处按需补齐
fn event<'a>(kind: &'a str, request_id: &'a str) -> StreamEvent<'a> {
    StreamEvent {
        kind,
        request_id,
        text: None,
        status: None,
        body: None,
        message: None,
    }
}

/// 发送一个流式事件；窗口已销毁等情况下发送失败不影响请求本身
fn emit(app: &AppHandle, event: StreamEvent<'_>) {
    let _ = app.emit(STREAM_EVENT, event);
}

/// 发送一个传输层错误事件
fn emit_error(app: &AppHandle, request_id: &str, message: String) {
    let mut failed = event("error", request_id);
    failed.message = Some(message);
    emit(app, failed);
}

/// 从缓冲中取出可安全解码的文本：完整部分立即回传，末尾不完整的多字节字符留待下一块。
///
/// SSE 是 UTF-8 文本，而网络分块不保证落在字符边界上；若直接按块 `from_utf8_lossy`，
/// 被劈开的多字节字符会变成替换字符，正文与思维链里就会出现乱码。
fn take_text(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let text = text.to_string();
            pending.clear();
            Some(text)
        }
        // 末尾是不完整的多字节序列：先回传它前面的完整部分，剩余字节等下一块补齐
        Err(error) if error.error_len().is_none() => {
            let valid = error.valid_up_to();
            if valid == 0 {
                return None;
            }
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            Some(text)
        }
        // 真正的非法字节（上游编码就不是 UTF-8）：按替换字符处理，避免缓冲无限增长
        Err(_) => {
            let text = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            Some(text)
        }
    }
}

/// 经 Rust 侧发起一次**流式**模型请求，把原始 SSE 文本按块通过 [`STREAM_EVENT`] 回传。
///
/// 请求体由前端构造（OpenAI 协议只在前端实现一份），这里只做传输与鉴权注入。
/// 上游的非 2xx、传输层错误、主动中断一律以事件回传、命令本身返回 `Ok`——
/// 让前端只需处理一种「流式结果」，不必再区分「命令被拒」和「事件报错」两条路径。
#[tauri::command]
pub async fn model_stream(
    app: AppHandle,
    request_id: String,
    url: String,
    key: String,
    payload: Value,
) -> Result<(), String> {
    let cancel = app.state::<ModelProxyState>().begin(&request_id);
    forward_stream(&app, &request_id, &url, &key, payload, cancel).await;
    app.state::<ModelProxyState>().finish(&request_id);
    Ok(())
}

/// 流式转发本体：与 [`model_stream`] 拆开，便于「登记 → 转发 → 注销」的时序在命令里一目了然
async fn forward_stream(
    app: &AppHandle,
    request_id: &str,
    url: &str,
    key: &str,
    payload: Value,
    mut cancel: oneshot::Receiver<()>,
) {
    let mut builder = client_for(url)
        .post(url)
        // 浏览器发 fetch 时默认带 `Accept: */*`，这里对齐，避免上游按请求头区分行为
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload.to_string());
    if !key.is_empty() {
        builder = builder.bearer_auth(key);
    }

    let sent = tokio::select! {
        _ = &mut cancel => {
            emit(app, event("aborted", request_id));
            return;
        }
        result = builder.send() => result,
    };
    let response = match sent {
        Ok(response) => response,
        Err(error) => {
            emit_error(app, request_id, format!("请求模型服务失败：{error}"));
            return;
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let mut failed = event("httpError", request_id);
        failed.status = Some(status.as_u16());
        failed.body = Some(body);
        emit(app, failed);
        return;
    }

    let mut stream = response.bytes_stream();
    // 跨块拼接的字节缓冲：文本边界与网络分块边界无关，必须自己攒够再解码
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let next = tokio::select! {
            _ = &mut cancel => {
                emit(app, event("aborted", request_id));
                return;
            }
            item = stream.next() => item,
        };
        match next {
            Some(Ok(bytes)) => {
                pending.extend_from_slice(&bytes);
                if let Some(text) = take_text(&mut pending) {
                    let mut chunk = event("chunk", request_id);
                    chunk.text = Some(text);
                    emit(app, chunk);
                }
            }
            Some(Err(error)) => {
                emit_error(app, request_id, format!("读取模型服务响应失败：{error}"));
                return;
            }
            None => {
                // 收尾：补齐最后一段完整文本（不完整的多字节残留没有意义，直接丢弃）
                if let Some(text) = take_text(&mut pending) {
                    let mut chunk = event("chunk", request_id);
                    chunk.text = Some(text);
                    emit(app, chunk);
                }
                emit(app, event("done", request_id));
                return;
            }
        }
    }
}

/// 中断一次进行中的模型请求（停止按钮、请求超时）。
///
/// 请求已结束时是空操作：前端可能在收到终态事件之后才触发中断，不应因此报错。
#[tauri::command]
pub fn model_abort(app: AppHandle, request_id: String) {
    app.state::<ModelProxyState>().cancel(&request_id);
}

/// 非流式代理的返回体
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFetchResult {
    /// 上游 HTTP 状态码；被中断时为 0（此时以 `aborted` 为准）
    pub status: u16,
    /// 上游响应体原文，由前端按各自协议解析
    pub body: String,
    /// 是否被调用方主动中断
    pub aborted: bool,
}

/// 经 Rust 侧发起一次**非流式**模型请求（模型列表探测、图像生成、旁路对话）。
///
/// 只放行 `GET` / `POST`：调用处都是「取资源」或「提交 JSON」，放开任意方法并无用途，
/// 收窄取值也避免把前端传错的方法原样打到上游。
#[tauri::command]
pub async fn model_fetch(
    app: AppHandle,
    request_id: String,
    method: String,
    url: String,
    key: String,
    body: Option<String>,
) -> Result<ModelFetchResult, String> {
    let http_method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("不支持的模型请求方法：{other}")),
    };

    let cancel = app.state::<ModelProxyState>().begin(&request_id);
    let result = fetch_once(http_method, &url, &key, body, cancel).await;
    app.state::<ModelProxyState>().finish(&request_id);
    result
}

/// 非流式转发本体
async fn fetch_once(
    method: reqwest::Method,
    url: &str,
    key: &str,
    body: Option<String>,
    mut cancel: oneshot::Receiver<()>,
) -> Result<ModelFetchResult, String> {
    let mut builder = client_for(url)
        .request(method, url)
        .header(reqwest::header::ACCEPT, "*/*");
    if !key.is_empty() {
        builder = builder.bearer_auth(key);
    }
    if let Some(body) = body {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }

    let sent = tokio::select! {
        _ = &mut cancel => {
            return Ok(ModelFetchResult {
                status: 0,
                body: String::new(),
                aborted: true,
            });
        }
        result = builder.send() => result,
    };
    let response = sent.map_err(|error| format!("请求模型服务失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取模型服务响应失败：{error}"))?;
    Ok(ModelFetchResult {
        status,
        body,
        aborted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_text_passes_through_complete_text() {
        let mut pending = b"data: {\"a\":1}\n\n".to_vec();
        assert_eq!(take_text(&mut pending).as_deref(), Some("data: {\"a\":1}\n\n"));
        assert!(pending.is_empty());
    }

    #[test]
    fn take_text_keeps_incomplete_multibyte_for_next_chunk() {
        // 「你」的 UTF-8 是三字节，这里只给前两字节，必须攒着而不是解成替换字符
        let mut pending = "你".as_bytes()[..2].to_vec();
        assert!(take_text(&mut pending).is_none());
        assert_eq!(pending.len(), 2);

        pending.extend_from_slice(&"你".as_bytes()[2..]);
        assert_eq!(take_text(&mut pending).as_deref(), Some("你"));
        assert!(pending.is_empty());
    }

    #[test]
    fn take_text_emits_valid_prefix_before_incomplete_tail() {
        let mut pending = "好".as_bytes().to_vec();
        pending.extend_from_slice(&"你".as_bytes()[..2]);
        assert_eq!(take_text(&mut pending).as_deref(), Some("好"));
        assert_eq!(pending, "你".as_bytes()[..2].to_vec());
    }

    #[test]
    fn take_text_replaces_invalid_bytes_instead_of_stalling() {
        // 0xFF 在任何位置都是非法字节，不能一直留在缓冲里等「补齐」
        let mut pending = vec![b'a', 0xFF];
        assert_eq!(take_text(&mut pending).as_deref(), Some("a\u{FFFD}"));
        assert!(pending.is_empty());
    }

    #[test]
    fn state_cancel_only_consumes_registered_request() {
        let state = ModelProxyState::default();
        let mut receiver = state.begin("req-1");
        state.cancel("req-1");
        assert!(receiver.try_recv().is_ok());

        // 已注销的请求再次取消是空操作，不应 panic
        state.cancel("req-1");
    }

    #[test]
    fn state_finish_drops_handle() {
        let state = ModelProxyState::default();
        let mut receiver = state.begin("req-2");
        state.finish("req-2");
        state.cancel("req-2");
        assert!(receiver.try_recv().is_err());
    }
}
