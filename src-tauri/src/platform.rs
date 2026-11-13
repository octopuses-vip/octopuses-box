//! 跨平台基础：用户主目录解析与操作系统名。
//!
//! 客户端原先各处直接读 `HOME` 环境变量，这在 Windows 上并不存在（Windows 用 `USERPROFILE`），
//! 会让集成终端、命令执行兜底目录、CDP profile 目录全部指向非法路径。这里集中处理解析顺序，
//! 各调用点只依赖本模块，不再各自读环境变量。

use std::path::PathBuf;
use std::process::Command;

/// Windows 上让子进程不弹控制台窗口（开发者 Jan）。
///
/// 客户端运行任务时会频繁通过 `run_shell`、MCP、`git` 启动 `powershell` / `cmd` / `npx` 这类
/// 控制台程序；不加 `CREATE_NO_WINDOW` 时 Windows 会为每次 spawn 分配并显示一个控制台窗口，
/// 一次任务几十条命令就是几十个黑框不停闪。这里集中收口，各 spawn 点只调一次，避免各写一份。
/// 只设 `CREATE_NO_WINDOW`，**不**叠加 `DETACHED_PROCESS`——后者会让 powershell 启动即静默退出
/// （见 `updater.rs` 的说明）。非 Windows 平台该函数为空操作。
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 解析当前用户主目录。
///
/// 依次尝试 `HOME`（macOS / Linux）→ `USERPROFILE`（Windows）→ `HOMEDRIVE` + `HOMEPATH`
/// （部分 Windows 服务环境）→ 当前工作目录。最后一项只是兜底，保证返回值非空，
/// 避免调用方再写平台相关的常量路径。
pub fn home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.trim().is_empty() {
            return PathBuf::from(profile);
        }
    }
    let drive = std::env::var("HOMEDRIVE").unwrap_or_default();
    let path = std::env::var("HOMEPATH").unwrap_or_default();
    let combined = format!("{}{}", drive.trim(), path.trim());
    if !combined.trim().is_empty() {
        return PathBuf::from(combined);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// 当前操作系统名：`macos` / `windows` / `linux`，用于错误文案与日志
pub fn os_name() -> &'static str {
    std::env::consts::OS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_is_never_empty() {
        assert!(!home_dir().as_os_str().is_empty());
    }

    #[test]
    fn os_name_matches_consts() {
        assert_eq!(os_name(), std::env::consts::OS);
    }
}
