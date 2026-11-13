//! 客户端启动与退出追踪（开发者 Jan）：把原生侧的关键节点落到临时目录的文件里。
//!
//! 客户端从桌面图标启动后脱离控制台，任何输出都留不下痕迹；若进程起来后很快自行消失，
//! 用户只能看到「点了一下，客户端没了」。因此这里把启动、窗口生命周期与退出原因追加写到
//! `%TEMP%\octopuses-update\client-trace.log`，事后按时间线还原整条链路。
//!
//! 追踪只服务于排查：任何写入失败都静默忽略，诊断手段不能变成新的故障点。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 追踪日志所在目录名（位于系统临时目录下），与用户数据目录分开存放，便于整体清理
const TRACE_DIR_NAME: &str = "octopuses-update";
/// 追踪日志文件名
const TRACE_FILE_NAME: &str = "client-trace.log";

/// 秒／分／时／天各自的秒数，用于把纪元秒拆成时刻
const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY: u64 = 24 * SECONDS_PER_HOUR;
const MILLIS_PER_SECOND: u128 = 1000;

/// 追加一行追踪记录（开发者 Jan）
pub fn write(message: &str) {
    let Ok(mut file) = open_log() else {
        return;
    };
    let _ = writeln!(file, "{} {}", timestamp(), message);
}

/// 以追加方式打开追踪日志，必要时连同目录一起创建
fn open_log() -> std::io::Result<std::fs::File> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// 追踪日志的完整路径（开发者 Jan）。
///
/// 由本模块统一持有，文件名只在上面定义一处，改路径时不会漏改。
pub(crate) fn log_path() -> PathBuf {
    std::env::temp_dir()
        .join(TRACE_DIR_NAME)
        .join(TRACE_FILE_NAME)
}

/// `时:分:秒.毫秒Z` 形式的 UTC 时间戳（开发者 Jan）。
///
/// 只用标准库实现：追踪要解决的是「同一台机器上几个进程谁先谁后、间隔多久」，
/// 取 UTC 时刻即可。结尾的 `Z` 明确标注时区，避免与更新进程日志里的本地时间直接混淆。
fn timestamp() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds_of_day = elapsed.as_secs() % SECONDS_PER_DAY;
    format!(
        "{:02}:{:02}:{:02}.{:03}Z",
        seconds_of_day / SECONDS_PER_HOUR,
        (seconds_of_day % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
        seconds_of_day % SECONDS_PER_MINUTE,
        elapsed.as_millis() % MILLIS_PER_SECOND
    )
}
