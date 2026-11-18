//! MCP（Model Context Protocol）最小客户端。
//!
//! 服务配置统一放在缓存目录下的 `mcp/servers.json`，每条记录声明如何启动一个本地
//! MCP 服务（`command` + `args` + `env`）。与技能一样，这里只做本地能力，
//! 不引入额外依赖：进程通信走 stdio 上的「换行分隔 JSON-RPC 2.0」。
//!
//! 传输策略是「一次操作一个会话」：需要列工具或调工具时，现场 spawn 进程 →
//! `initialize` → `notifications/initialized` → 目标方法 → 读取响应 → 结束进程。
//! 这样没有长驻进程与跨线程会话状态，任何一个服务崩溃都不会影响其他服务。
//!
//! 安全约束：`command` 与 `args` 分别传给 `Command`，绝不经过 shell 拼接；
//! 服务 id 必须是单层目录名（仅 ASCII 字母数字与 `-_`），避免路径穿越。

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// MCP 配置目录（相对缓存目录）与配置文件
const MCP_DIR: &str = "mcp";
const SERVERS_FILE: &str = "servers.json";
/// 客户端声明的协议版本与身份信息
const PROTOCOL_VERSION: &str = "2024-11-05";
const CLIENT_NAME: &str = "octopuses";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 单次协议交互的超时（毫秒）；初始化与工具调用共用同一上限
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// 每个服务保留的 stderr 上限，超出只留尾部，避免日志撑爆内存
const STDERR_LIMIT: usize = 8_000;

/// 一条 MCP 服务配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    /// 唯一标识，单层目录名，用于持久化与工具名拼装
    pub id: String,
    /// 展示名
    pub name: String,
    /// 启动命令（可执行文件路径或 PATH 中的命令名）
    pub command: String,
    /// 启动参数，逐项传给进程，不经 shell 解析
    #[serde(default)]
    pub args: Vec<String>,
    /// 追加的环境变量，叠加在继承环境之上
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 是否启用；停用的服务不向模型暴露工具
    #[serde(default)]
    pub enabled: bool,
}

/// 一个 MCP 工具（来自 `tools/list`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    /// 工具名（服务内唯一）
    pub name: String,
    /// 工具说明
    pub description: String,
    /// 入参 JSON Schema，直接作为模型工具的 parameters
    pub input_schema: Value,
}

/// 工具调用结果；`ok` 为 false 时 `output` 是可读的失败原因或服务的报错文本
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub ok: bool,
    pub output: String,
}

/// 新增/更新服务入参
#[derive(Deserialize)]
pub struct SaveMcpServerInput {
    id: String,
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    overwrite: bool,
}

/// 删除服务入参
#[derive(Deserialize)]
pub struct DeleteMcpServerInput {
    id: String,
}

/// 校验服务 id：仅允许单层目录名 + ASCII 字母数字与 `-_`
fn validate_server_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || id == "." || id == ".." {
        return Err("MCP 服务 id 不能为空，也不能是 . 或 ..。".to_string());
    }
    if id.starts_with('/') || id.contains('/') || id.contains('\\') {
        return Err("MCP 服务 id 只能是单层目录名，不能包含路径分隔符。".to_string());
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("MCP 服务 id 只允许 ASCII 字母、数字、短横线和下划线。".to_string());
    }
    Ok(id.to_string())
}

/// MCP 配置目录，不存在时创建
fn mcp_root(cache_dir: &Path) -> Result<PathBuf, String> {
    let root = cache_dir.join(MCP_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("创建 MCP 配置目录失败: {error}"))?;
    Ok(root)
}

/// 读取服务配置；文件不存在或为空时视为没有服务
pub fn load(cache_dir: &Path) -> Result<Vec<McpServer>, String> {
    let file = mcp_root(cache_dir)?.join(SERVERS_FILE);
    Ok(crate::json_store::read_json::<Vec<McpServer>>(&file)?.unwrap_or_default())
}

/// 原子写服务配置
fn store(cache_dir: &Path, servers: &[McpServer]) -> Result<(), String> {
    let root = mcp_root(cache_dir)?;
    crate::json_store::write_json(&root.join(SERVERS_FILE), servers)
}

/// 新增或更新一条服务；同 id 覆盖需显式 overwrite
pub fn save(cache_dir: &Path, input: SaveMcpServerInput) -> Result<Vec<McpServer>, String> {
    let id = validate_server_id(&input.id)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err("MCP 服务名称不能为空。".to_string());
    }
    let command = input.command.trim();
    if command.is_empty() {
        return Err("MCP 启动命令不能为空。".to_string());
    }
    let server = McpServer {
        id: id.clone(),
        name: name.to_string(),
        command: command.to_string(),
        args: input.args,
        env: input.env,
        enabled: input.enabled,
    };
    let mut servers = load(cache_dir)?;
    match servers.iter().position(|item| item.id == id) {
        Some(_) if !input.overwrite => {
            return Err(format!("MCP 服务已存在：{id}。如需覆盖请明确确认。"));
        }
        Some(index) => servers[index] = server,
        None => servers.push(server),
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    store(cache_dir, &servers)?;
    Ok(servers)
}

/// 删除一条服务；不存在时报错，不做静默成功
pub fn delete(cache_dir: &Path, input: DeleteMcpServerInput) -> Result<Vec<McpServer>, String> {
    let id = validate_server_id(&input.id)?;
    let mut servers = load(cache_dir)?;
    let before = servers.len();
    servers.retain(|server| server.id != id);
    if servers.len() == before {
        return Err(format!("MCP 服务不存在：{id}"));
    }
    store(cache_dir, &servers)?;
    Ok(servers)
}

/// 按 id 取服务配置
pub(crate) fn find_server(cache_dir: &Path, server_id: &str) -> Result<McpServer, String> {
    let id = validate_server_id(server_id)?;
    load(cache_dir)?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| format!("MCP 服务不存在：{id}"))
}

/// 把任意 JSON 压成单行文本，用于错误信息与未知内容块的展示
fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

/// 一次 stdio 会话：持有子进程、stdin 与由后台线程投递的 stdout 行
struct Session {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    next_id: i64,
}

impl Session {
    /// 启动一个 MCP 服务进程并挂上 stdout / stderr 读取线程
    fn open(server: &McpServer) -> Result<Self, String> {
        let mut command = Command::new(server.command.trim());
        command
            .args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &server.env {
            command.env(key, value);
        }
        // MCP 服务多是 npx / node 这类控制台程序：Windows 上不设 CREATE_NO_WINDOW 会每次启动都弹窗
        crate::platform::hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 MCP 服务「{}」失败: {error}", server.name))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP 服务「{}」未提供 stdin。", server.name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP 服务「{}」未提供 stdout。", server.name))?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| format!("MCP 服务「{}」未提供 stderr。", server.name))?;

        // stdout 只承载协议帧：逐行投递给主线程，非 JSON 行由读取方跳过
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break; // 主线程已结束，停止读取
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // stderr 只承载日志：后台持续排空，避免管道写满把服务卡死；失败时回传给用户
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&stderr);
        thread::spawn(move || {
            let reader = BufReader::new(stderr_pipe);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(mut buffer) = sink.lock() {
                    if buffer.len() < STDERR_LIMIT {
                        buffer.push_str(&line);
                        buffer.push('\n');
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            rx,
            stderr,
            next_id: 0,
        })
    }

    /// 分配下一个请求 id（从 1 起递增）
    fn next_id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }

    /// 写入一条消息（换行分隔）
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(message)
            .map_err(|error| format!("序列化 MCP 请求失败: {error}"))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|error| format!("写入 MCP 请求失败: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("刷新 MCP 请求失败: {error}"))
    }

    /// 读取指定 id 的响应；跳过通知与其他请求的响应
    fn read_response(&mut self, id: i64) -> Result<Value, String> {
        loop {
            let line = match self.rx.recv_timeout(IO_TIMEOUT) {
                Ok(line) => line,
                Err(_) => {
                    let detail = self.stderr_text();
                    return Err(if detail.is_empty() {
                        "等待 MCP 响应超时。".to_string()
                    } else {
                        format!("等待 MCP 响应超时。服务输出：{detail}")
                    });
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                // 服务把日志写到 stdout 时不是协议帧，跳过而不是失败
                Err(_) => continue,
            };
            // 通知没有 id；只匹配本次请求的 id
            if parsed.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = parsed.get("error") {
                return Err(format!("MCP 服务返回错误: {}", compact(error)));
            }
            return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// 发起一次带 id 的请求并等待同 id 响应
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id();
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        self.read_response(id)
    }

    /// 发送一条通知（无 id，不等待响应）
    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    /// 当前累积的 stderr 文本
    fn stderr_text(&self) -> String {
        self.stderr
            .lock()
            .map(|text| text.trim().to_string())
            .unwrap_or_default()
    }
}

impl Drop for Session {
    /// 会话销毁时收掉子进程（开发者 Jan）。
    ///
    /// MCP 服务是 stdio 子进程，不会随请求结束自动退出；不显式 kill 就会留下孤儿进程。
    /// 先 kill 再 wait，避免进程变成僵尸；失败也忽略——此时已经没有更合适的补救手段。
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 完成初始化握手：initialize 请求 + initialized 通知
fn handshake(session: &mut Session) -> Result<(), String> {
    session.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
        }),
    )?;
    session.notify("notifications/initialized", json!({}))
}

/// 列出一个服务声明的全部工具
pub fn list_tools(cache_dir: &Path, server_id: &str) -> Result<Vec<McpTool>, String> {
    let server = find_server(cache_dir, server_id)?;
    let result = if crate::mcp_http::is_http(&server.command) {
        tauri::async_runtime::block_on(crate::mcp_http::rpc(&server.command, "tools/list", json!({})))?
    } else {
        let mut session = Session::open(&server)?;
        handshake(&mut session)?;
        session.request("tools/list", json!({}))?
    };
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(Value::as_str)?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(McpTool {
                name,
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input_schema: tool
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            })
        })
        .collect())
}

/// 把 `tools/call` 返回的 content 数组拍平成文本
fn flatten_content(content: Option<&Value>) -> String {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return content.map(compact).unwrap_or_default();
    };
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_string());
                }
            }
            // 图片 / 资源等非文本块保留原始 JSON，保证信息不丢
            _ => parts.push(compact(block)),
        }
    }
    parts.join("\n")
}

/// 调用一个服务上的工具，返回拍平后的文本结果
pub fn call_tool(
    cache_dir: &Path,
    server_id: &str,
    tool: &str,
    arguments_json: &str,
) -> Result<McpCallResult, String> {
    let name = tool.trim();
    if name.is_empty() {
        return Err("MCP 工具名不能为空。".to_string());
    }
    let raw = arguments_json.trim();
    let arguments: Value = if raw.is_empty() {
        json!({})
    } else {
        serde_json::from_str(raw).map_err(|error| format!("工具参数不是合法 JSON: {error}"))?
    };
    let server = find_server(cache_dir, server_id)?;
    let params = json!({ "name": name, "arguments": arguments });
    let result = if crate::mcp_http::is_http(&server.command) {
        tauri::async_runtime::block_on(crate::mcp_http::rpc(&server.command, "tools/call", params))?
    } else {
        let mut session = Session::open(&server)?;
        handshake(&mut session)?;
        session.request("tools/call", params)?
    };
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output = flatten_content(result.get("content"));
    Ok(McpCallResult {
        ok: !is_error,
        output: if output.is_empty() {
            "（MCP 工具返回空内容）".to_string()
        } else {
            output
        },
    })
}

/// 读取 MCP 服务清单（开发者 Jan）：配置文件不存在时返回空列表
#[tauri::command]
pub fn mcp_list_servers(cache_dir: String) -> Result<Vec<McpServer>, String> {
    load(Path::new(&cache_dir))
}

/// 新增或更新一个 MCP 服务（开发者 Jan）：已存在且未授权覆盖时报错，返回最新清单
#[tauri::command]
pub fn mcp_save_server(
    cache_dir: String,
    input: SaveMcpServerInput,
) -> Result<Vec<McpServer>, String> {
    save(Path::new(&cache_dir), input)
}

/// 删除一个 MCP 服务（开发者 Jan）：只改配置，不处理已启动的进程
#[tauri::command]
pub fn mcp_delete_server(
    cache_dir: String,
    input: DeleteMcpServerInput,
) -> Result<Vec<McpServer>, String> {
    delete(Path::new(&cache_dir), input)
}

/// 列出一个 MCP 服务声明的工具（开发者 Jan）。
///
/// 需要真正启动该服务的子进程并完成握手，因此只在设置页按需触发；
/// 失败原因作为可读文本抛出，由页面展示，方便用户排查命令或参数写错。
#[tauri::command]
pub async fn mcp_list_tools(cache_dir: String, server_id: String) -> Result<Vec<McpTool>, String> {
    tauri::async_runtime::spawn_blocking(move || list_tools(Path::new(&cache_dir), &server_id)).await.map_err(|e| e.to_string())?
}

/// 调用一个 MCP 服务上的工具（开发者 Jan）。
///
/// argumentsJson 是模型给出的参数 JSON 文本，先解析再转成 JSON-RPC 的 arguments；
/// 返回值统一折成 McpCallResult，把「传输失败」与「工具自身报错」都转成可读文本回给模型，
/// 而不是抛异常中断整轮运行。
#[tauri::command]
pub async fn mcp_call_tool(
    cache_dir: String,
    server_id: String,
    tool: String,
    arguments_json: String,
) -> Result<McpCallResult, String> {
    tauri::async_runtime::spawn_blocking(move || call_tool(Path::new(&cache_dir), &server_id, &tool, &arguments_json)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 伪 MCP 服务（`/bin/sh` 脚本）：按 method 回应，用于验证协议帧编解码与端到端调用。
    ///
    /// 依赖 Unix shell 与可执行位，因此相关用例只在 Unix 平台编译（见下方 `#[cfg(unix)]`）。
    #[cfg(unix)]
    const FAKE_SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"回显","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"echo ok"},{"type":"text","text":"第二段"}],"isError":false}}\n' "$id" ;;
    *) : ;;
  esac
done
"#;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octopuses-mcp-test-{}-{}", std::process::id(), name));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    fn save_input(id: &str) -> SaveMcpServerInput {
        SaveMcpServerInput {
            id: id.to_string(),
            name: id.to_string(),
            command: "/bin/echo".to_string(),
            args: vec!["hello".to_string()],
            env: HashMap::new(),
            enabled: true,
            overwrite: false,
        }
    }

    /// 落一个可执行的伪服务脚本，返回脚本路径
    #[cfg(unix)]
    fn fake_script(cache: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let script = cache.join("fake-mcp.sh");
        fs::write(&script, FAKE_SERVER).unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();
        script
    }

    #[test]
    fn validates_safe_server_ids() {
        for id in ["", ".", "..", "/tmp", "a/b", "a\\b", "技能", "a b"] {
            assert!(validate_server_id(id).is_err(), "应拒绝 {id}");
        }
        assert_eq!(
            validate_server_id("chrome-devtools_1").unwrap(),
            "chrome-devtools_1"
        );
    }

    #[test]
    fn load_missing_file_returns_empty_and_save_roundtrips() {
        let cache = scratch("roundtrip");
        assert!(load(&cache).unwrap().is_empty());
        let servers = save(&cache, save_input("fetch")).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].command, "/bin/echo");
        assert_eq!(servers[0].args, vec!["hello".to_string()]);
        // 重新读盘应拿到同样的配置
        let reloaded = load(&cache).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].id, "fetch");
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn save_requires_explicit_overwrite_and_rejects_empty_fields() {
        let cache = scratch("overwrite");
        save(&cache, save_input("fetch")).unwrap();
        assert!(save(&cache, save_input("fetch"))
            .unwrap_err()
            .contains("覆盖"));

        let mut input = save_input("fetch");
        input.overwrite = true;
        input.command = "  node  ".to_string();
        let servers = save(&cache, input).unwrap();
        assert_eq!(servers[0].command, "node");

        let mut blank = save_input("blank");
        blank.command = "   ".to_string();
        assert!(save(&cache, blank).unwrap_err().contains("命令"));

        let mut no_name = save_input("noname");
        no_name.name = "".to_string();
        assert!(save(&cache, no_name).unwrap_err().contains("名称"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn delete_removes_server_and_rejects_missing() {
        let cache = scratch("delete");
        save(&cache, save_input("a")).unwrap();
        save(&cache, save_input("b")).unwrap();
        let servers = delete(
            &cache,
            DeleteMcpServerInput {
                id: "a".to_string(),
            },
        )
        .unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "b");
        assert!(delete(
            &cache,
            DeleteMcpServerInput {
                id: "a".to_string()
            }
        )
        .unwrap_err()
        .contains("不存在"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn list_tools_rejects_unknown_server() {
        let cache = scratch("unknown");
        assert!(list_tools(&cache, "missing")
            .unwrap_err()
            .contains("不存在"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn flatten_content_joins_text_blocks_and_keeps_others() {
        let content = json!([
            { "type": "text", "text": "第一段" },
            { "type": "image", "data": "abc" },
            { "type": "text", "text": "第二段" }
        ]);
        let output = flatten_content(Some(&content));
        assert!(output.starts_with("第一段\n"));
        assert!(output.ends_with("\n第二段"));
        assert!(output.contains("\"type\":\"image\""));
        assert_eq!(flatten_content(None), "");
    }

    #[cfg(unix)]
    #[test]
    fn lists_and_calls_tools_through_real_stdio_server() {
        let cache = scratch("stdio");
        let script = fake_script(&cache);
        let mut input = save_input("fake");
        input.command = script.to_string_lossy().into_owned();
        input.args = vec![];
        save(&cache, input).unwrap();

        let tools = list_tools(&cache, "fake").unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].description, "回显");
        assert_eq!(tools[0].input_schema["type"], "object");

        let result = call_tool(&cache, "fake", "echo", "{\"text\":\"hi\"}").unwrap();
        assert!(result.ok);
        assert!(result.output.contains("echo ok"));
        assert!(result.output.contains("第二段"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn call_tool_reports_transport_failure() {
        let cache = scratch("failure");
        let mut input = save_input("broken");
        input.command = "/nonexistent/octopuses-mcp-binary".to_string();
        input.args = vec![];
        save(&cache, input).unwrap();
        let error = call_tool(&cache, "broken", "echo", "{}").unwrap_err();
        assert!(error.contains("启动 MCP 服务"), "实际错误：{error}");
        assert!(error.contains("broken"), "实际错误：{error}");
        fs::remove_dir_all(&cache).ok();
    }
}
