//! 用户控制的持久 PTY 终端。
//!
//! 该通道只接收用户在终端面板中直接输入的内容，不复用模型的命令执行与审批链路。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 1;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyEvent {
    session_id: String,
    kind: &'static str,
    data: Option<String>,
    exit_code: Option<u32>,
}

struct PtySession {
    info: PtySessionInfo,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send>>,
}

trait ManagedPtySession: Send + Sync {
    /// 取该会话的对外信息（开发者 Jan）：会话 id、工作目录与 shell 路径
    fn info(&self) -> PtySessionInfo;
    /// 把用户输入写进 PTY（开发者 Jan）
    fn write(&self, data: &[u8]) -> Result<(), String>;
    /// 调整 PTY 窗口尺寸（开发者 Jan），让 shell 与全屏程序按新列宽重排
    fn resize(&self, size: PtySize) -> Result<(), String>;
    /// 结束该会话的子进程（开发者 Jan）
    fn kill(&self) -> Result<(), String>;
}

impl ManagedPtySession for PtySession {
    /// 返回会话信息的副本（开发者 Jan）：对外只暴露快照，调用方拿不到内部句柄
    fn info(&self) -> PtySessionInfo {
        self.info.clone()
    }

    /// 写入并立即 flush（开发者 Jan）：终端交互要求输入马上生效，缓冲会让按键看起来没反应
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "PTY 输入通道已损坏".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("写入 PTY 失败: {error}"))
    }

    /// 调整 PTY 尺寸（开发者 Jan）；主通道锁损坏时报错而非静默忽略
    fn resize(&self, size: PtySize) -> Result<(), String> {
        let master = self
            .master
            .lock()
            .map_err(|_| "PTY 主通道已损坏".to_string())?;
        master
            .resize(size)
            .map_err(|error| format!("调整 PTY 尺寸失败: {error}"))
    }

    /// 结束子进程（开发者 Jan）：通过 portable-pty 的 killer 句柄发送终止信号
    fn kill(&self) -> Result<(), String> {
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| "PTY 进程控制器已损坏".to_string())?;
        killer
            .kill()
            .map_err(|error| format!("关闭 PTY 失败: {error}"))
    }
}

#[derive(Default)]
struct SessionRegistry {
    sessions: HashMap<String, Arc<dyn ManagedPtySession>>,
}

#[derive(Default)]
pub struct PtyManager {
    registry: Arc<Mutex<SessionRegistry>>,
}

impl Drop for PtyManager {
    /// 应用退出时收尾（开发者 Jan）：终端进程不会随窗口关闭自动结束，必须显式终止
    fn drop(&mut self) {
        self.close_all();
    }
}

impl PtyManager {
    /// 登记一个新会话（开发者 Jan）：以会话 id 为键，同 id 覆盖
    fn insert(&self, session: Arc<dyn ManagedPtySession>) -> Result<(), String> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "PTY 会话表已损坏".to_string())?;
        registry.sessions.insert(session.info().session_id, session);
        Ok(())
    }

    /// 按会话 id 取句柄（开发者 Jan）；不存在时给出可读错误，供上层直接展示
    fn get(&self, session_id: &str) -> Result<Arc<dyn ManagedPtySession>, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "PTY 会话表已损坏".to_string())?;
        registry
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("PTY 会话不存在: {session_id}"))
    }

    /// 从会话表移除一个会话（开发者 Jan），返回它以便调用方决定是否终止进程
    fn remove(&self, session_id: &str) -> Result<Option<Arc<dyn ManagedPtySession>>, String> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "PTY 会话表已损坏".to_string())?;
        Ok(registry.sessions.remove(session_id))
    }

    /// 终止全部会话（开发者 Jan），应用退出时兜底。
    ///
    /// 先把会话表整体 drain 出来再逐个终止：持有锁的同时去 kill 可能阻塞，
    /// 期间任何 pty_write 都会被卡住，因此先释放锁再操作。
    pub fn close_all(&self) {
        let sessions = match self.registry.lock() {
            Ok(mut registry) => registry
                .sessions
                .drain()
                .map(|(_, value)| value)
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            let _ = session.kill();
        }
    }
}

/// 校验并规范化终端尺寸（开发者 Jan）。
///
/// 上下限不是形式主义：cols 为 0 会让部分程序除零或算出负宽度，
/// 过大的值则会申请巨量缓冲，因此这里夹在固定区间内再交给 PTY。
fn validate_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) {
        return Err(format!("终端列数必须在 {MIN_COLS}..={MAX_COLS} 之间"));
    }
    if !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(format!("终端行数必须在 {MIN_ROWS}..={MAX_ROWS} 之间"));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

/// 决定终端的起始工作目录（开发者 Jan）。
///
/// 传入的目录不存在（如会话的工作区已被删除）时回落到用户主目录，
/// 而不是让终端启动失败——终端是用户的自救通道，打不开比开在别处更糟。
fn resolved_cwd(cwd: Option<&str>) -> String {
    if let Some(path) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        if Path::new(path).is_dir() {
            return path.to_string();
        }
    }
    crate::platform::home_dir().to_string_lossy().to_string()
}

/// 决定用哪个 shell（开发者 Jan）：优先取环境变量 SHELL 且该文件确实存在。
///
/// 校验存在性是因为 SHELL 可能指向已卸载的解释器（如换过 brew 前缀），
/// 那样会直接启动失败；Windows 与兜底场景分别用 cmd.exe 与 /bin/sh。
fn resolved_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|value| Path::new(value).is_file())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "cmd.exe".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

/// 向前端推送一条 PTY 事件（开发者 Jan）：窗口已关闭等发送失败的情况直接忽略，不打断终端读取
fn emit(app: &AppHandle, event: PtyEvent) {
    let _ = app.emit("pty-event", event);
}

/// 创建一个持久 PTY 终端会话（开发者 Jan），返回会话信息。
///
/// 这是集成终端的后端入口，与模型的命令执行链路完全独立：用户在这里输入的命令
/// 不经过命令审批，也不受 test_runner 的策略限制——它是用户自己的控制面。
///
/// 实现上分三步：
/// 1. 开一对 PTY 主从设备并按传入尺寸初始化，启动登录 shell（非 Windows 加 -l）；
/// 2. 起一个读取线程把 master 的输出持续推给前端（read 返回 0 表示子进程已结束）；
/// 3. 起一个等待线程在子进程退出时推送 exit 事件，并把会话从表里摘掉。
/// 会话 id 由进程号加自增序号拼成，保证重启前后不会串号。
#[tauri::command]
pub fn pty_create(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<PtySessionInfo, String> {
    let size = validate_size(cols.unwrap_or(DEFAULT_COLS), rows.unwrap_or(DEFAULT_ROWS))?;
    let cwd = resolved_cwd(cwd.as_deref());
    let shell = resolved_shell();
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("创建 PTY 失败: {error}"))?;

    let mut command = CommandBuilder::new(&shell);
    if !cfg!(target_os = "windows") {
        command.arg("-l");
    }
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动终端 shell 失败: {error}"))?;
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("读取 PTY 输出失败: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("打开 PTY 输入失败: {error}"))?;

    let session_id = format!(
        "pty-{}-{}",
        std::process::id(),
        NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let info = PtySessionInfo {
        session_id: session_id.clone(),
        cwd,
        shell,
    };
    manager.insert(Arc::new(PtySession {
        info: info.clone(),
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
    }))?;
    let cleanup_registry = Arc::clone(&manager.registry);

    let output_app = app.clone();
    let output_session_id = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => emit(
                    &output_app,
                    PtyEvent {
                        session_id: output_session_id.clone(),
                        kind: "output",
                        data: Some(String::from_utf8_lossy(&buffer[..read]).into_owned()),
                        exit_code: None,
                    },
                ),
                Err(error) => {
                    emit(
                        &output_app,
                        PtyEvent {
                            session_id: output_session_id.clone(),
                            kind: "error",
                            data: Some(error.to_string()),
                            exit_code: None,
                        },
                    );
                    break;
                }
            }
        }
    });

    let exit_app = app;
    thread::spawn(move || {
        let result = child.wait();
        let (exit_code, data) = match result {
            Ok(status) => (Some(status.exit_code()), None),
            Err(error) => (None, Some(error.to_string())),
        };
        emit(
            &exit_app,
            PtyEvent {
                session_id: session_id.clone(),
                kind: "exit",
                data,
                exit_code,
            },
        );
        if let Ok(mut registry) = cleanup_registry.lock() {
            registry.sessions.remove(&session_id);
        }
    });

    Ok(info)
}

/// 把用户输入写入指定终端会话（开发者 Jan）：键盘输入原样转发，不在后端做任何解释
#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.get(&session_id)?.write(data.as_bytes())
}

/// 调整指定终端会话的窗口尺寸（开发者 Jan）：尺寸非法时直接报错，不静默忽略
#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.get(&session_id)?.resize(validate_size(cols, rows)?)
}

/// 关闭指定终端会话（开发者 Jan）：会话不存在时视为已关闭，不报错，便于前端重复调用清理
#[tauri::command]
pub fn pty_close(manager: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    if let Some(session) = manager.remove(&session_id)? {
        session.kill()?;
    }
    Ok(())
}

/// 列出当前存活的终端会话（开发者 Jan）：供界面重挂载后接回已有终端
#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Result<Vec<PtySessionInfo>, String> {
    let registry = manager
        .registry
        .lock()
        .map_err(|_| "PTY 会话表已损坏".to_string())?;
    Ok(registry
        .sessions
        .values()
        .map(|session| session.info())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct MockSession {
        info: PtySessionInfo,
        killed: Arc<AtomicBool>,
    }

    impl ManagedPtySession for MockSession {
        fn info(&self) -> PtySessionInfo {
            self.info.clone()
        }

        fn write(&self, _data: &[u8]) -> Result<(), String> {
            Ok(())
        }

        fn resize(&self, _size: PtySize) -> Result<(), String> {
            Ok(())
        }

        fn kill(&self) -> Result<(), String> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    fn mock_session(session_id: &str, killed: Arc<AtomicBool>) -> Arc<dyn ManagedPtySession> {
        Arc::new(MockSession {
            info: PtySessionInfo {
                session_id: session_id.to_string(),
                cwd: "/tmp".to_string(),
                shell: "/bin/sh".to_string(),
            },
            killed,
        })
    }

    #[test]
    fn validates_resize_boundaries() {
        assert!(validate_size(MIN_COLS, MIN_ROWS).is_ok());
        assert!(validate_size(MAX_COLS, MAX_ROWS).is_ok());
        assert!(validate_size(MIN_COLS - 1, MIN_ROWS).is_err());
        assert!(validate_size(MIN_COLS, 0).is_err());
        assert!(validate_size(MAX_COLS + 1, MAX_ROWS).is_err());
        assert!(validate_size(MAX_COLS, MAX_ROWS + 1).is_err());
    }

    #[test]
    fn registry_registers_removes_and_cleans_sessions() {
        let manager = PtyManager::default();
        let first_killed = Arc::new(AtomicBool::new(false));
        let second_killed = Arc::new(AtomicBool::new(false));

        manager
            .insert(mock_session("first", Arc::clone(&first_killed)))
            .expect("注册首个会话失败");
        manager
            .insert(mock_session("second", Arc::clone(&second_killed)))
            .expect("注册第二个会话失败");
        assert_eq!(
            manager
                .registry
                .lock()
                .expect("读取会话表失败")
                .sessions
                .len(),
            2
        );

        let removed = manager
            .remove("first")
            .expect("移除会话失败")
            .expect("会话不存在");
        removed.kill().expect("关闭会话失败");
        assert!(first_killed.load(Ordering::SeqCst));
        assert!(!second_killed.load(Ordering::SeqCst));

        manager.close_all();
        assert!(second_killed.load(Ordering::SeqCst));
        assert!(manager
            .registry
            .lock()
            .expect("读取会话表失败")
            .sessions
            .is_empty());
        manager.close_all();
    }
}
