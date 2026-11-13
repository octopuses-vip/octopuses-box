use std::time::Duration;

use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tokio::time::timeout;

use super::connect::*;
use super::guard::*;
use super::types::*;

/// 单条命令的默认超时与用户可设置的上限（秒）
pub(super) const EXEC_TIMEOUT_DEFAULT_SECS: u64 = 60;

pub(super) const EXEC_TIMEOUT_MAX_SECS: u64 = 3600;

/// 单次命令累计输出上限（stdout + stderr 合计字节），超出即截断但继续排空
pub(super) const OUTPUT_LIMIT: usize = 256 * 1024;

/// 远端未上报 exit-status 时的占位退出码
pub(super) const NO_EXIT_CODE: i32 = -1;

/// 累计的命令输出（开发者 Jan）
///
/// 超过 [`OUTPUT_LIMIT`] 后只丢弃内容、不中断读取：必须持续排空通道，
/// 否则远端进程会因窗口写满而卡住，连退出码都拿不到。
#[derive(Default)]
pub(super) struct ExecOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: i32,
    received: usize,
    truncated: bool,
}

impl ExecOutput {
    /// 新建并带上「未上报退出码」的占位值（开发者 Jan）
    fn new() -> Self {
        Self {
            exit_code: NO_EXIT_CODE,
            ..Default::default()
        }
    }

    /// 追加一段输出，超出上限即截断（开发者 Jan）
    fn push(&mut self, target: OutputStream, data: &[u8]) {
        if self.received >= OUTPUT_LIMIT {
            self.truncated = true;
            return;
        }
        let remaining = OUTPUT_LIMIT - self.received;
        let (taken, overflowed) = if data.len() > remaining {
            (&data[..remaining], true)
        } else {
            (data, false)
        };
        match target {
            OutputStream::Stdout => self.stdout.extend_from_slice(taken),
            OutputStream::Stderr => self.stderr.extend_from_slice(taken),
        }
        self.received += taken.len();
        if overflowed {
            self.truncated = true;
        }
    }

    /// 收敛成回前端的结构
    fn finish(self, timed_out: bool) -> SshExecResult {
        SshExecResult {
            ok: !timed_out && self.exit_code == 0,
            exit_code: self.exit_code,
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            timed_out,
            truncated: self.truncated,
        }
    }
}

/// 输出流归属
#[derive(Clone, Copy)]
pub(super) enum OutputStream {
    Stdout,
    Stderr,
}

/// 在远程主机执行一条命令（开发者 Jan）
///
/// 采用非交互式 exec：`exec` 后立即发送 EOF 关闭标准输入，再持续读取直至通道关闭。
/// 超时只中断本地等待并断开连接，不保证远端进程一定被终止（远端会随连接断开收到 SIGHUP）。
pub(super) async fn run_command(
    connection: &SshConnection,
    command: &str,
    timeout_secs: u64,
) -> Result<SshExecResult, String> {
    if let Some(reason) = remote_deny_reason(command) {
        return Ok(SshExecResult {
            ok: false,
            exit_code: NO_EXIT_CODE,
            stdout: String::new(),
            stderr: reason,
            timed_out: false,
            truncated: false,
        });
    }

    let mut channel = connection.open_session().await?;
    channel
        .exec(true, command.to_string())
        .await
        .map_err(|error| format!("[{}] 下发命令失败：{error}", connection.host_label))?;
    // 非交互执行没有输入要写，主动通知远端「标准输入已结束」
    let _ = channel.eof().await;

    let mut output = ExecOutput::new();
    let timed_out = timeout(
        Duration::from_secs(clamp_exec_timeout(timeout_secs)),
        drain_exec_channel(&mut channel, &mut output),
    )
    .await
    .is_err();

    Ok(output.finish(timed_out))
}

/// 把用户给的超时收敛到合法区间（开发者 Jan）
pub(super) fn clamp_exec_timeout(seconds: u64) -> u64 {
    if seconds == 0 {
        EXEC_TIMEOUT_DEFAULT_SECS
    } else {
        seconds.min(EXEC_TIMEOUT_MAX_SECS)
    }
}

/// 持续读取命令输出直至通道关闭（开发者 Jan）
pub(super) async fn drain_exec_channel(channel: &mut Channel<Msg>, output: &mut ExecOutput) {
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => output.push(OutputStream::Stdout, &data),
            // SSH 用 ext = 1 表示标准错误流
            ChannelMsg::ExtendedData { data, ext } => {
                let stream = if ext == STDERR_EXT { OutputStream::Stderr } else { OutputStream::Stdout };
                output.push(stream, &data);
            }
            ChannelMsg::ExitStatus { exit_status } => output.exit_code = exit_status as i32,
            ChannelMsg::Close => break,
            _ => {}
        }
    }
}

/// 标准错误流在 SSH 扩展数据中的类型号
pub(super) const STDERR_EXT: u32 = 1;
