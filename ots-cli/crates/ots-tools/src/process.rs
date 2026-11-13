//! 子进程执行助手。
//!
//! 所有需要启动外部进程的工具都经由本模块执行，从而把「环境隔离、输出采集、
//! 超时终止、取消终止、守护包装」这些横切逻辑集中在一处，工具实现只需关心命令本身。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use ots_core::{ExecGuard, ToolError, ToolErrorKind, ToolResult};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

/// 采集已终止进程管道输出的最长等待时间。
///
/// 进程被终止后，若其派生的孙进程仍持有管道写端，读取会一直阻塞，因此必须有上限。
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// 执行 shell 命令文本时使用的解释器。
pub const SHELL_PROGRAM: &str = "/bin/sh";

/// 一次子进程执行的原始结果。
#[derive(Debug, Clone)]
pub struct ProcessOutcome {
    /// 退出码；被信号终止时为 `None`。
    pub exit_code: Option<i32>,
    /// 标准输出（UTF-8 有损解码）。
    pub stdout: String,
    /// 标准错误（UTF-8 有损解码）。
    pub stderr: String,
    /// 是否因超时被终止。
    pub timed_out: bool,
    /// 是否因取消被终止。
    pub cancelled: bool,
}

impl ProcessOutcome {
    /// 是否正常结束且退出码为 0。
    pub fn is_success(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// 转换为工具结果：退出码 0 视为成功，失败时保留标准输出与错误，便于模型自行定位问题。
    pub fn into_result(self, data: serde_json::Value) -> ToolResult {
        let ok = self.is_success();
        let mut stderr = self.stderr;
        if !ok && stderr.trim().is_empty() {
            stderr = match self.exit_code {
                Some(code) => format!("命令以退出码 {code} 结束"),
                None => "命令被信号终止".to_string(),
            };
        }
        ToolResult {
            ok,
            stdout: self.stdout,
            stderr,
            exit_code: self.exit_code,
            duration_ms: 0,
            truncated: false,
            error_kind: if ok { None } else { Some(ToolErrorKind::Failed) },
            data: Some(data),
        }
    }
}

/// 子进程执行请求。
#[derive(Debug, Clone)]
pub struct ProcessSpec {
    /// 可执行文件。
    pub program: String,
    /// 参数列表。
    pub args: Vec<String>,
    /// 工作目录。
    pub cwd: PathBuf,
    /// 注入的环境变量（完整环境，子进程不会继承父进程环境）。
    pub env: BTreeMap<String, String>,
    /// 超时。
    pub timeout: Duration,
}

impl ProcessSpec {
    /// 依据执行守卫构造请求：先让守卫包装命令（如 Seatbelt），再注入守卫给出的完整环境。
    ///
    /// `extra_env` 会覆盖守卫给出的同名变量（例如外部工具自定义的环境）。
    pub fn with_guard(
        guard: &dyn ExecGuard,
        program: impl Into<String>,
        args: Vec<String>,
        cwd: PathBuf,
        extra_env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> Self {
        let (program, args) = guard.wrap_command(program.into(), args);
        let mut env = guard.env_overrides();
        for (key, value) in extra_env {
            env.insert(key.clone(), value.clone());
        }
        Self { program, args, cwd, env, timeout }
    }
}

/// 构造「以 shell 执行一段命令文本」的请求，供 shell / test_runner / 验证器共用。
pub fn shell_spec(
    guard: &dyn ExecGuard,
    command: impl Into<String>,
    cwd: PathBuf,
    extra_env: &BTreeMap<String, String>,
    timeout: Duration,
) -> ProcessSpec {
    ProcessSpec::with_guard(
        guard,
        SHELL_PROGRAM,
        vec!["-c".to_string(), command.into()],
        cwd,
        extra_env,
        timeout,
    )
}

/// 等待结果。
enum Wait {
    /// 进程已结束（或等待本身出错）。
    Exited(std::io::Result<std::process::ExitStatus>),
    /// 超时。
    TimedOut,
    /// 被取消。
    Cancelled,
}

/// 执行子进程，直到正常结束、超时或被取消。
///
/// # Errors
/// 无法启动子进程或等待过程出错时返回 [`ToolError::Failed`]。
pub async fn run(spec: ProcessSpec, cancel: &CancellationToken) -> Result<ProcessOutcome, ToolError> {
    let mut command = tokio::process::Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|err| ToolError::Failed(format!("无法启动 `{}`: {err}", spec.program)))?;

    // 必须并发读取两个管道，否则输出超过管道缓冲区时子进程会阻塞在写上。
    let stdout_task = tokio::spawn(drain(child.stdout.take()));
    let stderr_task = tokio::spawn(drain(child.stderr.take()));

    let waited = tokio::select! {
        biased;
        () = cancel.cancelled() => Wait::Cancelled,
        result = tokio::time::timeout(spec.timeout, child.wait()) => match result {
            Ok(status) => Wait::Exited(status),
            Err(_elapsed) => Wait::TimedOut,
        },
    };

    let mut timed_out = false;
    let mut cancelled = false;
    let exit_code = match waited {
        Wait::Exited(Ok(status)) => status.code(),
        Wait::Exited(Err(err)) => {
            child.start_kill().ok();
            return Err(ToolError::Failed(format!("等待 `{}` 结束失败: {err}", spec.program)));
        }
        Wait::TimedOut => {
            timed_out = true;
            terminate(&mut child).await
        }
        Wait::Cancelled => {
            cancelled = true;
            terminate(&mut child).await
        }
    };

    let stdout = join_drain(stdout_task).await;
    let stderr = join_drain(stderr_task).await;

    Ok(ProcessOutcome { exit_code, stdout, stderr, timed_out, cancelled })
}

/// 终止进程并回收，返回终止后的退出码（通常为 `None`）。
async fn terminate(child: &mut tokio::process::Child) -> Option<i32> {
    child.start_kill().ok();
    child.wait().await.ok().and_then(|status| status.code())
}

/// 读取一个管道直至 EOF。
async fn drain<R>(reader: Option<R>) -> String
where
    R: AsyncRead + Unpin,
{
    let Some(mut reader) = reader else {
        return String::new();
    };
    let mut buffer = Vec::new();
    if reader.read_to_end(&mut buffer).await.is_err() {
        return String::from_utf8_lossy(&buffer).into_owned();
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

/// 等待采集任务结束，超时或任务异常时返回已采集到的部分内容。
async fn join_drain(task: tokio::task::JoinHandle<String>) -> String {
    match tokio::time::timeout(PIPE_DRAIN_TIMEOUT, task).await {
        Ok(Ok(text)) => text,
        Ok(Err(err)) => format!("读取进程输出失败: {err}"),
        Err(_elapsed) => String::new(),
    }
}

/// 组合标准输出与标准错误，便于错误信息中不丢失任何一侧的线索。
pub fn combine_output(outcome: &ProcessOutcome) -> String {
    let mut merged = String::new();
    if !outcome.stdout.is_empty() {
        merged.push_str(&outcome.stdout);
    }
    if !outcome.stderr.is_empty() {
        if !merged.is_empty() && !merged.ends_with('\n') {
            merged.push('\n');
        }
        merged.push_str(&outcome.stderr);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::PermissiveGuard;

    fn shell_spec(script: &str, timeout: Duration) -> ProcessSpec {
        ProcessSpec::with_guard(
            &PermissiveGuard,
            "/bin/sh",
            vec!["-c".to_string(), script.to_string()],
            std::env::temp_dir(),
            &BTreeMap::new(),
            timeout,
        )
    }

    #[tokio::test]
    async fn 正常执行采集到标准输出() {
        let outcome = run(shell_spec("printf 'hello'", Duration::from_secs(10)), &CancellationToken::new())
            .await
            .expect("启动成功");
        assert!(outcome.is_success());
        assert_eq!(outcome.stdout, "hello");
    }

    #[tokio::test]
    async fn 退出码非零时判为失败() {
        let outcome = run(shell_spec("exit 3", Duration::from_secs(10)), &CancellationToken::new())
            .await
            .expect("启动成功");
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.is_success());
    }

    #[tokio::test]
    async fn 超时会被终止() {
        let outcome = run(shell_spec("sleep 5", Duration::from_millis(200)), &CancellationToken::new())
            .await
            .expect("启动成功");
        assert!(outcome.timed_out);
        assert!(!outcome.is_success());
    }

    #[tokio::test]
    async fn 取消会被终止() {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.cancel();
        });
        let outcome = run(shell_spec("sleep 5", Duration::from_secs(30)), &cancel).await.expect("启动成功");
        assert!(outcome.cancelled);
    }

    #[tokio::test]
    async fn 启动不存在的程序时报错() {
        let spec = ProcessSpec::with_guard(
            &PermissiveGuard,
            "/definitely/not/here",
            Vec::new(),
            std::env::temp_dir(),
            &BTreeMap::new(),
            Duration::from_secs(5),
        );
        let err = run(spec, &CancellationToken::new()).await.expect_err("应当失败");
        assert!(matches!(err, ToolError::Failed(_)));
    }
}
