//! Streamable HTTP transport, JSON/SSE responses and saved resource-bound credentials.
use futures::StreamExt;
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Distinguish remote HTTP endpoints from stdio executable names.
pub fn is_http(command: &str) -> bool { command.starts_with("https://") || command.starts_with("http://") }
/// Require HTTPS for remote resources and reject URL credentials.
fn validate_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| e.to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err("MCP URL 不得含账号密码或片段".into()); }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) { return Err("远程 MCP 必须使用 HTTPS，本机可使用 HTTP".into()); }
    Ok(url)
}
/// Create a bounded MCP transport that never follows credential-bearing redirects.
fn client() -> Result<Client, String> { Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).build().map_err(|e| e.to_string()) }
/// Bind one OS credential entry to the exact resource URL.
fn credential(url: &str) -> Result<keyring::Entry, String> { keyring::Entry::new("vip.octopuses.mcp", url).map_err(|e| e.to_string()) }
/// Serialize refresh and verify resource binding before returning a bearer token.
async fn access_token(url: &str, client: &Client) -> Result<Option<String>, String> {
    static REFRESH: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _guard = REFRESH.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let entry = credential(url)?;
    let Some(raw) = entry.get_password().ok() else { return Ok(None); };
    let mut token: Value = serde_json::from_str(&raw).map_err(|_| "MCP 已保存的授权记录无效")?;
    if token["resource"].as_str() != Some(validate_url(url)?.as_str()) { return Err("MCP 已保存的授权资源不匹配".into()); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    if token["expires_at"].as_u64().is_some_and(|at| at <= now + 30000) {
        let endpoint = validate_url(token["token_endpoint"].as_str().ok_or("令牌刷新地址缺失")?)?;
        let refresh = token["refresh_token"].as_str().ok_or("MCP 已保存的授权已过期")?;
        let mut form = Url::parse("https://form.invalid").map_err(|e| e.to_string())?;
        form.query_pairs_mut().append_pair("grant_type", "refresh_token").append_pair("refresh_token", refresh)
            .append_pair("client_id", token["client_id"].as_str().ok_or("OAuth client ID 缺失")?).append_pair("resource", url);
        let response = client.post(endpoint).header("Content-Type", "application/x-www-form-urlencoded").body(form.query().unwrap_or("").to_string()).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() { return Err("MCP 已保存的授权刷新失败".into()); }
        let updated: Value = response.json().await.map_err(|e| e.to_string())?;
        if updated["token_type"].as_str().is_some_and(|s| !s.eq_ignore_ascii_case("bearer")) || !updated["access_token"].is_string() { return Err("不支持的 OAuth 令牌响应".into()); }
        token["access_token"] = updated["access_token"].clone();
        if updated["refresh_token"].is_string() { token["refresh_token"] = updated["refresh_token"].clone(); }
        token["expires_at"] = updated["expires_in"].as_u64().map(|s| json!(now + s.saturating_mul(1000))).unwrap_or(Value::Null);
        entry.set_password(&token.to_string()).map_err(|e| e.to_string())?;
    }
    Ok(token["access_token"].as_str().map(str::to_string))
}
/// Convert JSON-RPC success or error envelopes into transport results.
fn rpc_result(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") { return Err(format!("MCP RPC error: {error}")); }
    value.get("result").cloned().ok_or("MCP 响应缺少 result".into())
}
/// Find the matching JSON-RPC response in a possibly multi-event SSE buffer.
fn parse_sse(buffer: &str, id: u64) -> Option<Result<Value, String>> {
    for event in buffer.split("\n\n") {
        let data = event.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
        if let Ok(value) = serde_json::from_str::<Value>(&data) { if value["id"].as_u64() == Some(id) { return Some(rpc_result(value)); } }
    }
    None
}
struct Session { client: Client, url: Url, token: Option<String>, session: Option<String>, version: String, next_id: u64 }
impl Session {
    /// Send session-aware JSON-RPC and bound streamed JSON/SSE response size.
    async fn post(&mut self, method: &str, params: Value, notify: bool) -> Result<Value, String> {
        let id = self.next_id; self.next_id += 1;
        let mut body = json!({ "jsonrpc": "2.0", "method": method, "params": params }); if !notify { body["id"] = json!(id); }
        let mut request = self.client.post(self.url.clone()).header("Accept", "application/json, text/event-stream").header("MCP-Protocol-Version", &self.version).json(&body);
        if let Some(token) = &self.token { request = request.bearer_auth(token); }
        if let Some(session) = &self.session { request = request.header("Mcp-Session-Id", session); }
        let response = request.send().await.map_err(|e| e.to_string())?;
        if response.status().as_u16() == 401 { return Err("MCP 服务要求有效的身份凭据（HTTP 401）".into()); }
        if !response.status().is_success() { return Err(format!("MCP HTTP {}", response.status())); }
        if let Some(session) = response.headers().get("Mcp-Session-Id") { self.session = Some(session.to_str().map_err(|e| e.to_string())?.to_string()); }
        if notify { return Ok(Value::Null); }
        let sse = response.headers().get("Content-Type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream"));
        let mut stream = response.bytes_stream(); let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("MCP 响应超过 2 MB".into()); }
            bytes.extend_from_slice(&chunk);
            if sse { let buffer = String::from_utf8_lossy(&bytes).replace("\r\n", "\n"); if let Some(result) = parse_sse(&buffer, id) { return result; } }
        }
        if sse { return Err("MCP SSE 已关闭但没有返回本次请求结果".into()); }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if value["id"].as_u64() != Some(id) { return Err("MCP 响应 ID 不匹配".into()); }
        rpc_result(value)
    }
}
/// Run initialization, notifications, paginated tools and session cleanup.
pub async fn rpc(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let url_value = validate_url(url)?; let client = client()?; let token = access_token(url, &client).await?;
    exchange(url_value, client, token, method, params).await
}
/// Bridge the synchronous stdio-facing API to the async HTTP transport.
async fn exchange(url: Url, client: Client, token: Option<String>, method: &str, params: Value) -> Result<Value, String> {
    let mut session = Session { client, url, token, session: None, version: "2025-06-18".into(), next_id: 1 };
    let init = session.post("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "octopuses", "version": env!("CARGO_PKG_VERSION") } }), false).await?;
    session.version = init["protocolVersion"].as_str().ok_or("MCP 缺少协议版本")?.to_string();
    session.post("notifications/initialized", json!({}), true).await?;
    let mut result = session.post(method, params, false).await?;
    if method == "tools/list" {
        let mut pages = 0;
        while let Some(cursor) = result["nextCursor"].as_str().map(str::to_string) {
            pages += 1; if pages > 50 { return Err("MCP 工具分页过多".into()); }
            let next = session.post(method, json!({ "cursor": cursor }), false).await?;
            let tools = next["tools"].as_array().ok_or("MCP 工具列表无效")?;
            result["tools"].as_array_mut().ok_or("MCP 工具列表无效")?.extend(tools.clone()); result["nextCursor"] = next["nextCursor"].clone();
        }
    }
    if let Some(id) = session.session { let mut close = session.client.delete(session.url).header("Mcp-Session-Id", id).header("MCP-Protocol-Version", session.version); if let Some(token) = session.token { close = close.bearer_auth(token); } let _ = close.send().await; }
    Ok(result)
}
#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test]
    async fn http_sessions_support_json_sse_and_tool_pagination() {
        use std::{io::{Read, Write}, net::TcpListener};
        for sse in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                for request_number in 0..5 {
                    let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut bytes = Vec::new(); let mut buffer = [0u8; 2048];
                    let split = loop {
                        let n = stream.read(&mut buffer).unwrap(); assert!(n > 0); bytes.extend_from_slice(&buffer[..n]);
                        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") { break at + 4; }
                    };
                    let headers = String::from_utf8_lossy(&bytes[..split]).to_lowercase();
                    assert!(headers.contains("authorization: bearer test-token"));
                    if request_number > 0 { assert!(headers.contains("mcp-session-id: session-1")); }
                    let len = headers.lines().find_map(|l| l.strip_prefix("content-length: ").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
                    while bytes.len() < split + len { let n = stream.read(&mut buffer).unwrap(); assert!(n > 0); bytes.extend_from_slice(&buffer[..n]); }
                    let (status, body) = if headers.starts_with("delete ") { ("204 No Content", String::new()) }
                    else {
                        let value: Value = serde_json::from_slice(&bytes[split..split + len]).unwrap();
                        let result = match value["method"].as_str().unwrap() {
                            "initialize" => json!({ "protocolVersion": "2025-06-18" }),
                            "notifications/initialized" => Value::Null,
                            "tools/list" if value["params"]["cursor"] == "page-2" => json!({ "tools": [{ "name": "second", "inputSchema": { "type": "object" } }] }),
                            "tools/list" => json!({ "tools": [{ "name": "first", "inputSchema": { "type": "object" } }], "nextCursor": "page-2" }),
                            other => panic!("unexpected method {other}"),
                        };
                        if value.get("id").is_none() { ("202 Accepted", String::new()) }
                        else { let response = json!({ "jsonrpc": "2.0", "id": value["id"], "result": result }).to_string(); ("200 OK", if sse { format!("event: message\ndata: {response}\n\n") } else { response }) }
                    };
                    let response = format!("HTTP/1.1 {status}\r\nContent-Type: {}\r\nMcp-Session-Id: session-1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", if sse { "text/event-stream" } else { "application/json" }, body.len());
                    stream.write_all(response.as_bytes()).unwrap();
                }
            });
            let result = exchange(Url::parse(&format!("http://{address}/mcp")).unwrap(), client().unwrap(), Some("test-token".into()), "tools/list", json!({})).await.unwrap();
            assert_eq!(result["tools"].as_array().unwrap().len(), 2); server.join().unwrap();
        }
    }
    #[test] fn sse_matches_request_id_and_handles_multiline() { assert!(parse_sse("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":4,\ndata: \"result\":{\"ok\":true}}\n\n", 4).unwrap().unwrap()["ok"].as_bool().unwrap()); assert!(parse_sse("data: {\"id\":3,\"result\":{}}\n\n", 4).is_none()); }
    #[test] fn rejects_cleartext_remote_and_embedded_credentials() { assert!(validate_url("http://example.com/mcp").is_err()); assert!(validate_url("https://user:pass@example.com/mcp").is_err()); assert!(validate_url("http://127.0.0.1:3333/mcp").is_ok()); }
}
