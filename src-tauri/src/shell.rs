//! 命令执行：在指定目录下跑一条 shell 命令并把输出带回前端。
//!
//! 终端由用户显式打开、命令由用户自己输入，因此不做命令白名单限制；但仍要在三处收紧：
//! 空命令直接拒绝（避免起一个无意义的 shell）、工作目录只在确实存在时才切换（否则回落到用户主目录）、
//! 单条命令有最长执行时间（避免一条 `tail -f` 把终端永久占住）。
//!
//! 模型触发的命令额外走 [`run_sandboxed`]：在 macOS 上用 `sandbox-exec` 叠加一层内核强制的
//! 写入范围限制（见 [`crate::sandbox`]），开关与网络策略由前端传入。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::sandbox::{self, SandboxOptions};

/// 一次沙箱执行请求：工作区根目录（写入白名单的基准）+ 策略
struct SandboxRequest<'a> {
    workspace: &'a Path,
    options: SandboxOptions,
}

/// 单条命令的最长执行时间，超过后杀掉进程并把已有输出带回
const TIMEOUT: Duration = Duration::from_secs(30);
/// 轮询子进程状态的间隔
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    /// 进程退出码；被信号终止等场景为 None
    pub exit_code: Option<i32>,
    /// 是否因超时被强制终止
    pub timed_out: bool,
}

/// 解析工作目录：传了且确实存在才使用，否则回落到用户主目录
fn resolve_dir(cwd: Option<&str>) -> Option<String> {
    if let Some(dir) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        if Path::new(dir).is_dir() {
            return Some(dir.to_string());
        }
    }
    Some(crate::platform::home_dir().to_string_lossy().to_string())
}

/// 在指定工作目录与超时内执行一条命令并收集输出
pub fn run_with_timeout(
    command: &str,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<ShellResult, String> {
    let (shell, _) = build_command(command, cwd, None)?;
    spawn_and_collect(shell, timeout)
}

/// 在 macOS 内核沙箱下执行一条命令：写入只允许工作区与显式白名单目录。
///
/// 沙箱不可用或开关关闭时自动退回原行为；被内核拦下时在 stderr 追加可读说明。
pub fn run_sandboxed(
    command: &str,
    cwd: Option<&Path>,
    timeout: Duration,
    workspace: &Path,
    options: SandboxOptions,
) -> Result<ShellResult, String> {
    let (shell, enforced) =
        build_command(command, cwd, Some(SandboxRequest { workspace, options }))?;
    let mut result = spawn_and_collect(shell, timeout)?;
    if enforced && sandbox::looks_denied(&result.stderr) {
        result.stderr.push_str(&sandbox::denial_hint(workspace));
    }
    Ok(result)
}

/// 构造要执行的命令；`sandbox` 为 `Some` 时尝试包一层 `sandbox-exec`。
///
/// 返回的 bool 表示本次是否**真的**套上了沙箱（开关打开且沙箱可用），调用方据此决定
/// 要不要把「Operation not permitted」解释为沙箱拦截。
fn build_command(
    command: &str,
    cwd: Option<&Path>,
    sandbox: Option<SandboxRequest<'_>>,
) -> Result<(Command, bool), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("命令不能为空".to_string());
    }

    let wrapped = sandbox.and_then(|request| {
        sandbox::wrap_shell_command(command, request.workspace, request.options)
    });
    let enforced = wrapped.is_some();
    let mut shell = match wrapped {
        Some((program, args)) => {
            let mut cmd = Command::new(program);
            cmd.args(args);
            cmd
        }
        None if cfg!(target_os = "windows") => {
            // PowerShell 而非 cmd：`ls` / `cat` / `rm` / `echo` 都有别名，管道与 `&&` 语义接近 Unix，
            // 现有工具描述里的命令示例大多可直接复用
            let mut cmd = Command::new("powershell");
            cmd.arg("-NoProfile").arg("-Command").arg(command);
            cmd
        }
        // 走登录 shell（`-l`）以便拿到用户 PATH，否则打包后的应用里 `pnpm` / `node` 之类会找不到
        None => {
            let mut cmd = Command::new("sh");
            cmd.arg("-lc").arg(command);
            cmd
        }
    };
    if let Some(dir) = cwd {
        shell.current_dir(dir);
    } else if let Some(dir) = resolve_dir(None) {
        shell.current_dir(dir);
    }
    // Windows 上不设 CREATE_NO_WINDOW 的话，每条命令都会闪一个控制台窗口（开发者 Jan）
    crate::platform::hide_console(&mut shell);
    Ok((shell, enforced))
}

/// 启动子进程、收集输出，并在超时后强制终止
fn spawn_and_collect(mut command: Command, timeout: Duration) -> Result<ShellResult, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动命令失败: {error}"))?;

    // 输出交给独立线程持续读取：如果只在超时前调用 try_wait，输出超过管道缓冲区（64 KB）时
    // 子进程会阻塞在 write 上永远不退出，于是命令必然被判超时，这是最容易踩的坑。
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

    Ok(ShellResult {
        stdout,
        stderr,
        exit_code,
        timed_out,
    })
}

/// 在独立线程里执行命令，避免长命令阻塞 Tauri 的事件循环（界面卡死）。
///
/// `sandbox_dir` 是工作区根目录：传了才启用内核沙箱（写入只允许该目录与工具链白名单），
/// 不传即原行为——集成终端是用户直接控制面，走这条路径时前端不会传 `sandbox_dir`。
#[tauri::command]
pub async fn run_shell(
    command: String,
    cwd: Option<String>,
    sandbox_dir: Option<String>,
    sandbox_enabled: Option<bool>,
    allow_network: Option<bool>,
) -> Result<ShellResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_dir(cwd.as_deref());
        let cwd_path = resolved.as_deref().map(Path::new);
        match sandbox_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(dir) => run_sandboxed(
                &command,
                cwd_path,
                TIMEOUT,
                Path::new(dir),
                SandboxOptions {
                    enabled: sandbox_enabled.unwrap_or(true),
                    allow_network: allow_network.unwrap_or(true),
                },
            ),
            None => run_with_timeout(&command, cwd_path, TIMEOUT),
        }
    })
    .await
    .map_err(|error| format!("执行命令失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octopuses-shell-test-{}-{}", std::process::id(), name));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        dir
    }

    /// 按默认超时直接执行一条命令
    fn run(command: &str, cwd: Option<&Path>) -> Result<ShellResult, String> {
        run_with_timeout(command, cwd, TIMEOUT)
    }

    #[test]
    fn rejects_empty_command() {
        assert!(run("   ", None).is_err());
    }

    #[test]
    fn captures_stdout_and_exit_code() {
        let result = run("echo hello", None).expect("执行命令失败");
        assert_eq!(result.stdout.trim(), "hello");
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
    }

    #[test]
    fn captures_stderr_and_non_zero_exit() {
        let result = run("echo oops >&2; exit 3", None).expect("执行命令失败");
        assert_eq!(result.stderr.trim(), "oops");
        assert_eq!(result.exit_code, Some(3));
        assert!(!result.timed_out);
    }

    #[test]
    fn runs_in_given_directory() {
        let dir = scratch("cwd");
        fs::create_dir_all(&dir).expect("创建测试目录失败");
        fs::write(dir.join("marker.txt"), "x").expect("写入标记文件失败");
        let result = run("ls", Some(&dir)).expect("执行命令失败");
        assert!(
            result.stdout.contains("marker.txt"),
            "输出: {}",
            result.stdout
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_falls_back_to_home() {
        // 目录不存在时不能直接失败，应回落到用户主目录继续执行
        let fallback = resolve_dir(Some("/no/such/dir/octopuses-not-exist"));
        assert!(fallback.is_none() || Path::new(&fallback.unwrap()).is_dir());
    }

    #[test]
    fn large_output_does_not_deadlock() {
        // 输出远超管道缓冲区（64 KB）：读取线程必须让子进程正常退出，而不是被误判超时
        let result = run("yes octopuses | head -c 200000", None).expect("执行命令失败");
        assert_eq!(result.stdout.len(), 200000);
        assert!(!result.timed_out);
        assert_eq!(result.exit_code, Some(0));
    }
}
