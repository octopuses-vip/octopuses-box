//! 浏览器与电脑自动化：让模型能驱动本机浏览器与系统应用。
//!
//! **平台支持**：`open_in_browser` 与协议式 CDP 三平台可用（CDP 只是启动本机浏览器，平台差异
//! 在可执行文件位置）；脚本式（AppleScript）、截图与坐标点击仅 macOS 有实现，其它平台返回
//! 可读的「本平台暂不支持」而非静默失败，对应入口由前端按平台隐藏。
//!
//! 能力分两类，全部经由 macOS 系统自带命令完成，不引入任何额外依赖：
//! - **脚本式**（面向已装好的浏览器 / 任意应用）：`open_in_browser` 用系统默认浏览器打开网址、
//!   `run_browser_script` 用 AppleScript 驱动 Chrome / Safari、`run_computer_script` 直接执行 AppleScript；
//! - **协议式**（面向可控的调试浏览器与视觉闭环）：`control_cdp_launch` / `control_cdp_targets` /
//!   `control_cdp_close` 用独立 profile 拉起 Chrome 并暴露 DevTools 协议端口（真正的协议交互由前端
//!   WebView 的原生 WebSocket 完成，这里只负责启动与探测），`control_screenshot` 截全屏图、
//!   `control_computer_click` 按「截图 + 视觉」给出的像素坐标点击。
//!
//! 安全边界（所有动作在界面上都要先过一次审批）：
//! - 传入值一律作为独立的进程参数传递，绝不经过 shell 拼接；
//! - 网址只接受 `http://` / `https://`；JS 与 AppleScript 里的引号、反斜杠统一转义后再嵌进脚本，
//!   杜绝用引号截断脚本拼接出额外语句；
//! - 单条脚本有最长执行时间，超时即杀掉进程并带回已有输出，避免一个弹窗把调用永久挂住；
//! - CDP 只连本机回环地址且端口限定在 9000-9999，启动的浏览器使用**独立 profile**，不复用用户日常数据；
//! - 权限被系统拒绝（屏幕录制 / 辅助功能）时返回可读的授权指引，而不是把原始报错丢给模型。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cache;

/// 单条脚本 / 打开动作的最长执行时间
const TIMEOUT: Duration = Duration::from_secs(60);
/// 轮询子进程状态的间隔
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 一条自动化调用的结果；`ok` 为 false 时 `output` 是可读的失败原因
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResult {
    pub ok: bool,
    pub output: String,
}

/// 校验并规整 http/https 网址
fn validate_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("网址不能为空。".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("只允许打开 http:// 或 https:// 开头的网址。".to_string());
    }
    Ok(url.to_string())
}

/// 转义 AppleScript 字符串字面量里的反斜杠与双引号
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 按浏览器与动作拼出对应的 AppleScript
fn build_browser_script(browser: &str, action: &str, value: &str) -> Result<String, String> {
    let app = match browser.trim().to_lowercase().as_str() {
        "chrome" | "google chrome" => "Google Chrome",
        "safari" => "Safari",
        other => {
            return Err(format!(
                "不支持的浏览器：{other}。目前只支持 chrome 与 safari。"
            ))
        }
    };
    match action.trim().to_lowercase().as_str() {
        "navigate" => {
            let url = validate_url(value)?;
            let escaped = escape_applescript(&url);
            Ok(if app == "Safari" {
                format!("tell application \"Safari\" to set URL of current tab of front window to \"{escaped}\"")
            } else {
                format!("tell application \"Google Chrome\" to set URL of active tab of front window to \"{escaped}\"")
            })
        }
        "eval" => {
            let script = value.trim();
            if script.is_empty() {
                return Err("要执行的 JavaScript 不能为空。".to_string());
            }
            let escaped = escape_applescript(script);
            Ok(if app == "Safari" {
                format!("tell application \"Safari\" to do JavaScript \"{escaped}\" in current tab of front window")
            } else {
                format!("tell application \"Google Chrome\" to execute front window's active tab javascript \"{escaped}\"")
            })
        }
        other => Err(format!(
            "不支持的动作：{other}。目前只支持 navigate 与 eval。"
        )),
    }
}

/// 执行一个已装配好的命令并收集输出（含超时保护）
fn run_program(mut command: Command, timeout: Duration) -> Result<ControlResult, String> {
    // Windows 上 `cmd` / 其它控制台程序不加 CREATE_NO_WINDOW 会闪窗（开发者 Jan）
    crate::platform::hide_console(&mut command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动命令失败: {error}"))?;

    // 输出必须由独立线程持续读取：否则输出超过管道缓冲区时子进程会阻塞在 write 上，被误判超时
    let stdout_reader = child.stdout.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });
    let stderr_reader = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().ok().and_then(|status| status.code());
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => return Err(format!("等待命令结束失败: {error}")),
        }
    };

    let stdout = stdout_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    let mut output = stdout.trim().to_string();
    if output.is_empty() {
        output = stderr.trim().to_string();
    }
    if timed_out {
        output = if output.is_empty() {
            "执行超时。".to_string()
        } else {
            format!("{output}\n（执行超时，已终止）")
        };
    }
    if output.is_empty() {
        output = "（无输出）".to_string();
    }

    Ok(ControlResult {
        ok: exit_code == Some(0) && !timed_out,
        output,
    })
}

/// 用系统默认浏览器打开一个网址
fn open_in_browser(url: &str) -> Result<ControlResult, String> {
    let target = validate_url(url)?;
    let command = if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(&target);
        cmd
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        // start 的第一个参数是窗口标题，给个空标题避免把网址当成标题
        cmd.arg("/C").arg("start").arg("").arg(&target);
        cmd
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&target);
        cmd
    };
    let result = run_program(command, TIMEOUT)?;
    Ok(ControlResult {
        ok: result.ok,
        output: if result.ok {
            format!("已在系统浏览器打开：{target}")
        } else {
            format!("打开浏览器失败：{}", result.output)
        },
    })
}

/// 执行一段 AppleScript（多行脚本按行拆成多个 `-e` 传入）。
///
/// AppleScript 只有 macOS 提供，其它平台直接返回可读原因；入参校验先做，保证空脚本的报错
/// 在任何平台都一致。
fn run_osascript(script: &str) -> Result<ControlResult, String> {
    let lines: Vec<&str> = script
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return Err("AppleScript 不能为空。".to_string());
    }
    if !cfg!(target_os = "macos") {
        return Err(format!(
            "该能力仅 macOS 支持（AppleScript 自动化），当前平台为 {}。",
            crate::platform::os_name()
        ));
    }
    let mut command = Command::new("osascript");
    for line in &lines {
        command.arg("-e").arg(line);
    }
    run_program(command, TIMEOUT)
}

/// 用系统默认浏览器打开一个 http/https 链接（开发者 Jan）：只读动作，不触碰页面内容
#[tauri::command]
pub fn control_open_in_browser(url: String) -> Result<ControlResult, String> {
    open_in_browser(&url)
}

/// 用 AppleScript 驱动本机浏览器执行一个动作（开发者 Jan）：仅 macOS 可用。
/// 动作与取值都经 build_browser_script 白名单校验后再拼脚本，避免把任意 AppleScript 传进来执行。
#[tauri::command]
pub fn control_browser_script(
    browser: String,
    action: String,
    value: String,
) -> Result<ControlResult, String> {
    let script = build_browser_script(&browser, &action, &value)?;
    run_osascript(&script)
}

/// 执行一段用户提供的 AppleScript（开发者 Jan）：仅 macOS 可用，属写动作，恒需人工审批
#[tauri::command]
pub fn control_computer_script(script: String) -> Result<ControlResult, String> {
    run_osascript(&script)
}

/* ============ CDP：可被协议驱动的调试浏览器 ============ */

/// CDP 调试端口允许的下界：只放行回环地址上的本区间，避免探测动作退化成任意端口扫描
const CDP_PORT_MIN: u16 = 9000;
/// CDP 调试端口允许的上界
const CDP_PORT_MAX: u16 = 9999;
/// 未指定时使用的 CDP 端口
const CDP_DEFAULT_PORT: u16 = 9222;
/// 启动 Chrome 后等待调试端口就绪的最长时间
const CDP_READY_TIMEOUT: Duration = Duration::from_secs(10);
/// 轮询调试端口是否就绪的间隔
const CDP_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// 通过本应用启动的浏览器进程句柄：`control_cdp_launch` 写入，`control_cdp_close` 取走并结束
#[derive(Default)]
pub struct CdpState(pub Mutex<Option<Child>>);

/// 一个可供 CDP 驱动的目标（通常就是一个标签页）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpTarget {
    pub id: String,
    /// 目标类型：`page` 是标签页，其余（`iframe` / `worker` 等）不建议直接驱动
    #[serde(rename = "type")]
    pub target_type: String,
    pub title: String,
    pub url: String,
    /// 前端 WebSocket 直连协议用的地址；host 会在前端再校验一次
    pub web_socket_debugger_url: String,
}

/// 一次屏幕截图的结果；`base64` 为 PNG 内容，宽高是**像素**尺寸（Retina 下是逻辑点的 2 倍）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub ok: bool,
    pub output: String,
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub mime: String,
}

/// 校验并规整 CDP 调试端口
fn resolve_cdp_port(port: Option<u16>) -> Result<u16, String> {
    let value = port.unwrap_or(CDP_DEFAULT_PORT);
    if !(CDP_PORT_MIN..=CDP_PORT_MAX).contains(&value) {
        return Err(format!(
            "CDP 调试端口必须在 {CDP_PORT_MIN}-{CDP_PORT_MAX} 之间，收到 {value}。"
        ));
    }
    Ok(value)
}

/// 定位浏览器可执行文件：只认各平台常见的安装位置，找不到就让用户自己装。
///
/// CDP 协议本身跨平台，平台差异只在可执行文件的位置。
fn chrome_binary() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ));
    } else if cfg!(target_os = "windows") {
        // Windows 用环境变量拼装：Program Files 与 x86 版本、以及用户级安装位置都要覆盖
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            let Ok(root) = std::env::var(key) else {
                continue;
            };
            if root.trim().is_empty() {
                continue;
            }
            let root = PathBuf::from(root);
            candidates.push(
                root.join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
            candidates.push(
                root.join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
        }
    } else {
        for candidate in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/opt/google/chrome/chrome",
        ] {
            candidates.push(PathBuf::from(candidate));
        }
    }
    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(format!(
        "未找到 Chrome（当前平台 {}）：请先安装 Google Chrome 或 Chromium 后重试。",
        crate::platform::os_name()
    ))
}

/// CDP 专用浏览器 profile 目录：独立于用户日常浏览器数据，绝不复用其登录态与 Cookie。
///
/// 与缓存目录同源（`<系统数据目录>/octopuses/cdp-profile`），三平台自动落到各自的数据目录。
fn cdp_profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .data_dir()
        .map_err(|error| format!("无法获取系统数据目录: {error}"))?;
    Ok(base.join("octopuses").join("cdp-profile"))
}

/// 解析 `GET /json/list` 的原始 HTTP 响应：取正文并按 Chrome 的字段名映射成目标列表
fn parse_cdp_targets_response(raw: &str) -> Result<Vec<CdpTarget>, String> {
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or(raw);
    let parsed: Vec<serde_json::Value> = serde_json::from_str(body.trim())
        .map_err(|error| format!("解析 CDP 目标列表失败: {error}"))?;
    Ok(parsed
        .iter()
        .filter_map(|item| {
            let web_socket_debugger_url = item.get("webSocketDebuggerUrl")?.as_str()?.to_string();
            Some(CdpTarget {
                id: item
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                target_type: item
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                title: item
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                url: item
                    .get("url")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                web_socket_debugger_url,
            })
        })
        .collect())
}

/// 读取一次 HTTP 响应：优先按 Content-Length 收齐正文，不等待 keep-alive 连接主动关闭。
fn read_cdp_http_response(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let size = stream
            .read(&mut chunk)
            .map_err(|error| format!("读取 CDP 响应失败: {error}"))?;
        if size == 0 {
            return Ok(raw);
        }
        raw.extend_from_slice(&chunk[..size]);
        if let Some(index) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };

    let headers = String::from_utf8_lossy(&raw[..header_end]);
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    if let Some(content_length) = content_length {
        let body_read = raw.len().saturating_sub(header_end);
        if body_read < content_length {
            let remaining = content_length - body_read;
            let mut body = vec![0_u8; remaining];
            stream
                .read_exact(&mut body)
                .map_err(|error| format!("读取 CDP 响应正文失败: {error}"))?;
            raw.extend_from_slice(&body);
        }
    } else {
        stream
            .read_to_end(&mut raw)
            .map_err(|error| format!("读取 CDP 响应失败: {error}"))?;
    }
    Ok(raw)
}

/// 用一次 HTTP/1.1 请求读取 CDP 目标列表：只连 `127.0.0.1`，不引入 HTTP 客户端依赖
fn fetch_cdp_targets(port: u16) -> Result<Vec<CdpTarget>, String> {
    let port = resolve_cdp_port(Some(port))?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|error| format!("连接 CDP 调试端口 {port} 失败（浏览器是否已启动？）: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送 CDP 请求失败: {error}"))?;
    let raw = read_cdp_http_response(&mut stream)?;
    parse_cdp_targets_response(&String::from_utf8_lossy(&raw))
}

/// 启动一个仅用于调试协议的浏览器实例（独立 profile），并等待调试端口就绪
#[tauri::command]
pub fn control_cdp_launch(
    app: AppHandle,
    state: tauri::State<'_, CdpState>,
    port: Option<u16>,
) -> Result<ControlResult, String> {
    let port = resolve_cdp_port(port)?;
    // 端口已在服务就直接复用（开发者 Jan）：应用重启后进程句柄丢失，但上次启动的
    // 调试浏览器还活着；此时返回「已在运行」而不是再拉起一个实例——同一个 profile
    // 被两个 Chrome 进程使用时，新进程会把命令移交给旧实例随即退出，新端口永远开不出来。
    if let Ok(targets) = fetch_cdp_targets(port) {
        let pages = targets
            .iter()
            .filter(|target| target.target_type == "page")
            .count();
        return Ok(ControlResult {
            ok: true,
            output: format!("调试浏览器已在运行（端口 {port}），可驱动页面 {pages} 个。"),
        });
    }
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "CDP 状态锁已损坏。".to_string())?;
    // 已有实例还活着就复用：否则反复调用会堆出多个浏览器进程
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(ControlResult {
                    ok: true,
                    output: format!("调试浏览器已在运行（端口 {port}）。"),
                })
            }
            _ => *guard = None,
        }
    }
    let binary = chrome_binary()?;
    let profile = cdp_profile_dir(&app)?;
    std::fs::create_dir_all(&profile)
        .map_err(|error| format!("创建调试 profile 目录失败: {error}"))?;
    let child = Command::new(&binary)
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动浏览器失败: {error}"))?;
    *guard = Some(child);
    // 等端口就绪期间不能占着锁，否则取消 / 关闭命令无法进入
    drop(guard);

    let deadline = Instant::now() + CDP_READY_TIMEOUT;
    let mut last_error = String::new();
    let mut exited_early = false;
    while Instant::now() < deadline {
        // 轮询期间顺带看一眼子进程：若已退出就不必等满超时——同 profile 被旧实例
        // 占用时新进程会立即退出，继续轮询只会白等 10 秒（等待期短暂持锁，不阻碍 close）。
        {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "CDP 状态锁已损坏。".to_string())?;
            match guard.as_mut() {
                Some(child) => {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        *guard = None;
                        exited_early = true;
                        break;
                    }
                }
                // 等待期间子进程被 close 命令取走，视同退出
                None => {
                    exited_early = true;
                    break;
                }
            }
        }
        match fetch_cdp_targets(port) {
            Ok(targets) => {
                let pages = targets
                    .iter()
                    .filter(|target| target.target_type == "page")
                    .count();
                return Ok(ControlResult {
                    ok: true,
                    output: format!("调试浏览器已就绪（端口 {port}），可驱动页面 {pages} 个。"),
                });
            }
            Err(error) => last_error = error,
        }
        thread::sleep(CDP_POLL_INTERVAL);
    }
    if exited_early {
        return Ok(ControlResult {
            ok: false,
            output: format!(
                "浏览器进程启动后立即退出，调试端口 {port} 未能就绪。常见原因：该调试 profile 已被一个仍在运行的旧实例占用（启动命令被它接管、新进程随即退出）。请关闭旧的调试浏览器后重试，或直接使用它已开启的调试端口。"
            ),
        });
    }
    Ok(ControlResult {
        ok: false,
        output: format!("浏览器已启动但调试端口 {port} 未就绪：{last_error}"),
    })
}

/// 列出调试浏览器的可驱动目标
#[tauri::command]
pub fn control_cdp_targets(port: Option<u16>) -> Result<Vec<CdpTarget>, String> {
    fetch_cdp_targets(resolve_cdp_port(port)?)
}

/// 关闭由本应用启动的调试浏览器
#[tauri::command]
pub fn control_cdp_close(state: tauri::State<'_, CdpState>) -> Result<ControlResult, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "CDP 状态锁已损坏。".to_string())?;
    let Some(mut child) = guard.take() else {
        return Ok(ControlResult {
            ok: true,
            output: "当前没有通过本应用启动的调试浏览器。".to_string(),
        });
    };
    let killed = child.kill().is_ok();
    let _ = child.wait();
    Ok(ControlResult {
        ok: true,
        output: if killed {
            "已关闭本应用启动的调试浏览器。".to_string()
        } else {
            "调试浏览器进程已结束。".to_string()
        },
    })
}

/* ============ 截图与坐标点击：桌面原生应用的视觉闭环 ============ */

/// `screencapture` 的位置：macOS 上在 `/usr/sbin`，个别系统只在 PATH 里
fn screencapture_binary() -> &'static str {
    if Path::new("/usr/sbin/screencapture").is_file() {
        "/usr/sbin/screencapture"
    } else {
        "screencapture"
    }
}

/// 从 PNG 字节流里取像素宽高：IHDR 的宽高固定在第 16..24 字节（大端 u32）
fn png_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("截图不是合法的 PNG。".to_string());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return Err("截图尺寸不合法。".to_string());
    }
    Ok((width, height))
}

/// 截图失败时给出可读原因：系统未授权屏幕录制是最常见的一种
fn screenshot_failure_hint(reason: &str) -> String {
    let detail = reason.trim();
    if detail.is_empty()
        || detail.contains("could not create image")
        || detail.contains("not authorized")
        || detail.contains("not permitted")
    {
        return "截图失败：系统未授权屏幕录制。请到 系统设置 → 隐私与安全性 → 屏幕录制 勾选 octopuses 后重试。"
            .to_string();
    }
    format!("截图失败：{detail}")
}

/// 截一张全屏图：写临时文件读回后立刻删除，不把二进制留在磁盘上
fn capture_screenshot() -> Result<(Vec<u8>, u32, u32), String> {
    if !cfg!(target_os = "macos") {
        return Err("屏幕截图目前仅支持 macOS。".to_string());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("octopuses-shot-{stamp}.png"));
    let mut command = Command::new(screencapture_binary());
    command.arg("-x").arg("-m").arg("-t").arg("png").arg(&path);
    let result = run_program(command, TIMEOUT)?;
    let read = std::fs::read(&path);
    let _ = std::fs::remove_file(&path);
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(_) => return Err(screenshot_failure_hint(&result.output)),
    };
    if bytes.is_empty() {
        return Err(screenshot_failure_hint(&result.output));
    }
    let (width, height) = png_size(&bytes)?;
    Ok((bytes, width, height))
}

/// 截一张全屏图，返回 PNG 的 base64 与像素尺寸
#[tauri::command]
pub fn control_screenshot() -> Result<ScreenshotResult, String> {
    match capture_screenshot() {
        Ok((bytes, width, height)) => Ok(ScreenshotResult {
            ok: true,
            output: format!("已截取屏幕 {width}×{height} 像素。"),
            base64: cache::base64_encode(&bytes),
            width,
            height,
            mime: "image/png".to_string(),
        }),
        Err(reason) => Ok(ScreenshotResult {
            ok: false,
            output: reason,
            base64: String::new(),
            width: 0,
            height: 0,
            mime: "image/png".to_string(),
        }),
    }
}

/// 解析 Finder 返回的桌面 bounds（形如 `0, 0, 2560, 1440`）为逻辑尺寸
fn parse_desktop_bounds(text: &str) -> Result<(f64, f64), String> {
    let numbers: Vec<f64> = text
        .split(',')
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .collect();
    if numbers.len() != 4 {
        return Err(format!("无法解析屏幕尺寸：{text}"));
    }
    let width = numbers[2] - numbers[0];
    let height = numbers[3] - numbers[1];
    if width <= 0.0 || height <= 0.0 {
        return Err(format!("屏幕尺寸不合法：{text}"));
    }
    Ok((width, height))
}

/// 屏幕的**逻辑**尺寸（点）
fn desktop_point_size() -> Result<(f64, f64), String> {
    let result = run_osascript("tell application \"Finder\" to get bounds of window of desktop")?;
    if !result.ok {
        return Err(format!("读取屏幕尺寸失败：{}", result.output));
    }
    parse_desktop_bounds(&result.output)
}

/// 按坐标点击屏幕。
///
/// 模型看到的是截图，因此传进来的 `x` / `y` 是**截图像素**坐标；Retina 屏上截图像素是逻辑点的
/// 两倍，直接用像素点会偏一倍，这里按「截图像素宽 ÷ 桌面逻辑宽」换算后再点。
#[tauri::command]
pub fn control_computer_click(
    x: f64,
    y: f64,
    image_width: Option<u32>,
) -> Result<ControlResult, String> {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("点击坐标必须是非负的有限数值。".to_string());
    }
    // 点击依赖截图与 AppleScript，二者都只在 macOS 有实现
    if !cfg!(target_os = "macos") {
        return Err(format!(
            "该能力仅 macOS 支持（截图 + 坐标点击），当前平台为 {}。",
            crate::platform::os_name()
        ));
    }
    let (logical_width, _) = desktop_point_size()?;
    // 调用方给了截图像素宽就用它；没给就现截一张推断，保证缩放换算始终基于真实像素
    let pixel_width = match image_width {
        Some(value) if value > 0 => value as f64,
        _ => capture_screenshot()?.1 as f64,
    };
    let scale = if logical_width > 0.0 && pixel_width > 0.0 {
        pixel_width / logical_width
    } else {
        1.0
    };
    let target_x = (x / scale).round() as i64;
    let target_y = (y / scale).round() as i64;
    let script =
        format!("tell application \"System Events\" to click at {{{target_x}, {target_y}}}");
    let result = run_osascript(&script)?;
    if !result.ok && (result.output.contains("辅助访问") || result.output.contains("assistive"))
    {
        return Ok(ControlResult {
            ok: false,
            output: "系统拒绝模拟点击：请到 系统设置 → 隐私与安全性 → 辅助功能 勾选 octopuses 后重试。"
                .to_string(),
        });
    }
    Ok(ControlResult {
        ok: result.ok,
        output: if result.ok {
            format!("已点击屏幕坐标 ({target_x}, {target_y})。")
        } else {
            format!("点击失败：{}", result.output)
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_http_urls_only() {
        assert_eq!(
            validate_url("  https://example.com/a  ").unwrap(),
            "https://example.com/a"
        );
        for url in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "example.com",
        ] {
            assert!(validate_url(url).is_err(), "应拒绝 {url}");
        }
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        assert_eq!(escape_applescript(r#"a"b\c"#), r#"a\"b\\c"#);
    }

    #[test]
    fn builds_browser_scripts_per_browser_and_action() {
        let chrome = build_browser_script("chrome", "eval", "document.title").unwrap();
        assert!(chrome.contains("Google Chrome"));
        assert!(chrome.contains("javascript"));

        let safari = build_browser_script("safari", "navigate", "https://example.com").unwrap();
        assert!(safari.contains("Safari"));
        assert!(safari.contains("https://example.com"));

        // 恶意 JS 里的引号被转义，无法截断脚本拼接出额外语句
        let injected = build_browser_script("chrome", "eval", r#"1" to activate"#).unwrap();
        assert!(injected.contains(r#"1\" to activate"#));
    }

    #[test]
    fn rejects_unknown_browser_action_and_bad_url() {
        assert!(build_browser_script("firefox", "eval", "1")
            .unwrap_err()
            .contains("浏览器"));
        assert!(build_browser_script("chrome", "click", "x")
            .unwrap_err()
            .contains("动作"));
        assert!(build_browser_script("chrome", "navigate", "javascript:1")
            .unwrap_err()
            .contains("http"));
    }

    #[test]
    fn rejects_empty_script() {
        assert!(run_osascript("   \n  ").unwrap_err().contains("不能为空"));
    }

    #[test]
    fn restricts_cdp_port_range() {
        assert_eq!(resolve_cdp_port(None).unwrap(), CDP_DEFAULT_PORT);
        assert_eq!(resolve_cdp_port(Some(9000)).unwrap(), 9000);
        assert_eq!(resolve_cdp_port(Some(9999)).unwrap(), 9999);
        for port in [80u16, 8999, 10000] {
            assert!(resolve_cdp_port(Some(port)).is_err(), "应拒绝端口 {port}");
        }
    }

    #[test]
    fn parses_cdp_target_list_response() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Length: 42\r\n\r\n[\
            {\"id\":\"A\",\"type\":\"page\",\"title\":\"首页\",\"url\":\"https://example.com\",\
            \"webSocketDebuggerUrl\":\"ws://127.0.0.1:9222/devtools/page/A\"},\
            {\"id\":\"B\",\"type\":\"other\"}]";
        let targets = parse_cdp_targets_response(raw).unwrap();
        // 没有 webSocketDebuggerUrl 的目标无法驱动，必须被过滤掉
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].target_type, "page");
        assert_eq!(
            targets[0].web_socket_debugger_url,
            "ws://127.0.0.1:9222/devtools/page/A"
        );
        assert!(parse_cdp_targets_response("HTTP/1.1 200 OK\r\n\r\nnot-json").is_err());
    }

    #[test]
    fn parses_desktop_bounds_and_png_size() {
        assert_eq!(
            parse_desktop_bounds("0, 0, 2560, 1440").unwrap(),
            (2560.0, 1440.0)
        );
        assert!(parse_desktop_bounds("0, 0, 0, 0").is_err());
        assert!(parse_desktop_bounds("nonsense").is_err());

        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1440u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        assert_eq!(png_size(&png).unwrap(), (1440, 900));
        assert!(png_size(b"not a png").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn screenshot_outcome_is_always_readable() {
        // 屏幕录制权限由系统决定：成功要给出像素尺寸，被拒要给出可读的授权指引，都不能 panic
        match capture_screenshot() {
            Ok((bytes, width, height)) => {
                assert!(!bytes.is_empty());
                assert!(width > 0 && height > 0);
            }
            Err(reason) => assert!(reason.contains("截图失败"), "原因应可读: {reason}"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn runs_applescript_and_returns_output() {
        // 不触碰任何应用：只做纯计算，验证 osascript 调用链与输出回传
        let result = run_osascript("return 1 + 1").expect("执行 AppleScript 失败");
        assert!(result.ok, "输出: {}", result.output);
        assert_eq!(result.output, "2");
    }
}
