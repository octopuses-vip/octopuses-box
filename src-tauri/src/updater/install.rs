use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use serde::Serialize;
use crate::client_api::ApiError;
use crate::trace;
use super::download::*;
use super::script::*;

/// 更新脚本落盘的文件名（与安装包、日志同目录）：用 `-File` 执行，避开命令行引号转义
pub(super) const SCRIPT_FILE_NAME: &str = "octopuses-update.ps1";

/// 更新进程的日志文件名（与安装包同目录）：安装失败时这是唯一能还原过程的东西
pub(super) const LOG_FILE_NAME: &str = "octopuses-update.log";

/// 更新结果文件名（与安装包同目录）：更新进程写入，客户端下次启动读走并删除
pub(super) const RESULT_FILE_NAME: &str = "octopuses-update-result.txt";

/// 结果文件里表示「安装成功」的状态标记
pub(super) const RESULT_OK: &str = "ok";

/// 文件通道只在没有这类驱动的环境里生效，并供人工查看。
pub(super) const READY_FILE_NAME: &str = "octopuses-update-ready.txt";

/// 紧接着拉起容易被它误伤，因此先让出一小段时间。
pub(super) const RESTART_GRACE_SECONDS: u32 = 2;

/// 否则用户停在「点了更新、客户端再没回来」。
pub(super) const RESTART_ATTEMPTS: u32 = 4;

/// 每轮拉起后观察客户端是否存活的秒数：既留出初始化时间，也用于识别「起来几秒就被结束」。
pub(super) const RESTART_SETTLE_SECONDS: u32 = 3;

/// 即认定更新进程根本没起来，客户端必须留在原地报错，而不是退出后什么都等不到。
pub(super) const READY_WAIT_SECONDS: u64 = 20;

/// 轮询就绪标记的间隔毫秒数：太密会空转，太疏会让用户多等。
pub(super) const READY_POLL_MILLIS: u64 = 200;

/// 就能解释这次客户端为何被结束；没有的话说明原因落在别处。
pub(super) const INSTALLER_PROCESS_PATTERN: &str = "'uninstall|setup|msiexec'";

/// 安装程序不会返回这个值，用负数与真实退出码区分开。
pub(super) const EXIT_ELEVATION_DENIED: i32 = -2;

/// 因此不存在无限自我复制的可能。
pub(super) const ESCAPE_FLAG: &str = "-Escaped";

#[cfg(windows)]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 那时客户端已经没了，用户只能自己去任务管理器收场。
pub(super) fn ensure_installer(installer: &Path) -> Result<(), ApiError> {
    let client = std::env::current_exe().ok();
    let is_client_itself = client
        .as_deref()
        .is_some_and(|path| is_client_binary(installer, path));
    if !is_client_itself {
        return Ok(());
    }
    // 这个文件留在临时目录只会被下一次更新再误用一次，直接删掉
    let _ = std::fs::remove_file(installer);
    Err(download_error(
        "更新源下发的是客户端本体而不是安装包，已取消本次更新。请确认更新地址指向 *-setup.exe 或 .msi 安装包。"
            .to_string(),
    ))
}

/// 两个路径的文件名是否指向同一个可执行文件（Windows 下文件名不区分大小写）
pub(super) fn is_client_binary(installer: &Path, client: &Path) -> bool {
    // 测试与更新接口可能传入 Windows 风格的 `C:/...` 路径；在 macOS/Linux
    // 上 `Path::file_name` 不会把反斜杠当分隔符，所以先统一取两种分隔符后的末段。
    fn basename(path: &Path) -> Option<String> {
        path.to_string_lossy()
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
            .map(str::to_owned)
    }

    /// 将历史 OTS 可执行文件别名归一到当前产品名（开发者 Jan）。
    fn canonical_name(name: String) -> String {
        let lower = name.to_ascii_lowercase();
        // 历史安装包仍可能把客户端本体命名为 OTS.EXE；升级保护需要把旧别名
        // 与当前产品名视为同一个本体，避免把正在运行的程序交给安装脚本。
        if lower == "ots.exe" { "octopuses.exe".to_string() } else { lower }
    }

    match (basename(installer), basename(client)) {
        (Some(installer_name), Some(client_name)) => {
            canonical_name(installer_name) == canonical_name(client_name)
        }
        _ => false,
    }
}

/// 用户看到的就是「点了更新，客户端没了」却什么都没发生。
pub(super) fn launch_updater(installer: &Path) -> Result<(), ApiError> {
    let client_exe = std::env::current_exe()
        .map_err(|error| download_error(format!("定位客户端可执行文件失败：{error}")))?;

    // 先在本机回环上占一个 UDP 端口：脚本会把「干活进程的 PID」发到这里。
    // 走 UDP 而不是共享文件，是因为透明加密／DLP 会让脚本写的文件在客户端侧变成密文，握手必然失败。
    let socket = UdpSocket::bind("127.0.0.1:0")
        .map_err(|error| download_error(format!("创建更新握手端口失败：{error}")))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(READY_POLL_MILLIS)))
        .map_err(|error| download_error(format!("设置更新握手超时失败：{error}")))?;
    let ready_port = socket
        .local_addr()
        .map_err(|error| download_error(format!("读取更新握手端口失败：{error}")))?
        .port();

    let script_path = write_update_script(std::process::id(), installer, &client_exe, ready_port)?;

    // 启动前先清掉上一次遗留的就绪标记：否则会把上次的残留误当成本次就绪（文件兜底通道仍会读它）
    let ready_path = ready_file_path();
    let _ = std::fs::remove_file(&ready_path);

    let child = spawn_update_script(&script_path)?;
    wait_for_ready(&socket, &ready_path, child.id())
}

/// WMI 由 WmiPrvSE 代建进程，天然落在作业之外，是本环境下唯一可靠的逃逸方式。
pub(super) fn spawn_update_script(script: &Path) -> Result<std::process::Child, ApiError> {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        // 脚本是自己写的文件，不受用户执行策略限制
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        script.to_string_lossy().as_ref(),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|error| download_error(format!("启动更新进程失败：{error}")))
}

/// 就绪标记文件的完整路径（与安装包、日志同目录）
pub(super) fn ready_file_path() -> PathBuf {
    temp_dir().join(READY_FILE_NAME)
}

/// 「信号压根没出现」「收到但读不出 pid」等情形，否则排查只能靠猜。
pub(super) fn wait_for_ready(socket: &UdpSocket, ready_path: &Path, child_pid: u32) -> Result<(), ApiError> {
    let started = Instant::now();
    let timeout = Duration::from_secs(READY_WAIT_SECONDS);
    trace::write(&format!(
        "等待更新进程就绪：回环端口={} 标记={} 子进程pid={child_pid}",
        socket.local_addr().map(|addr| addr.port()).unwrap_or(0),
        ready_path.display()
    ));
    let mut buffer = [0u8; 64];
    // 每轮刷新：超时时记录的是「最后一次」的状态，而不是启动初期那必然的空
    let mut last_read = String::from("尚未收到就绪信号");
    loop {
        // 首选回环 UDP：recv 会阻塞到收到报文或读超时（READY_POLL_MILLIS），天然形成轮询节奏
        let udp_pid = match socket.recv_from(&mut buffer) {
            Ok((len, _)) => match parse_ready_pid(&buffer[..len]) {
                Some(pid) => Some(pid),
                None => {
                    last_read = format!("UDP 报文首段不是 pid：{}", hex_preview(&buffer[..len]));
                    None
                }
            },
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                None
            }
            Err(error) => {
                last_read = format!("UDP 接收失败：{:?}", error.kind());
                None
            }
        };
        // 兜底：就绪标记文件（无加密驱动的环境可用；透明加密下客户端读到的是密文，会被忽略）
        let ready_pid = udp_pid.or_else(|| {
            let bytes = std::fs::read(ready_path).ok()?;
            let pid = parse_ready_pid(&bytes);
            if pid.is_none() {
                last_read = format!("标记文件首段不是 pid：{}", hex_preview(&bytes));
            }
            pid
        });

        if let Some(worker_pid) = ready_pid {
            if worker_pid == child_pid {
                trace::write(&format!(
                    "就绪信号与子进程 pid 相同，作业逃逸未完成：pid={worker_pid}"
                ));
                return Err(download_error(
                    "无法在作业对象之外启动更新进程，本次更新已取消，请重试。".to_string(),
                ));
            }
            trace::write(&format!(
                "更新进程已就绪（作业逃逸成功，pid={worker_pid}，耗时 {}ms）",
                started.elapsed().as_millis()
            ));
            return Ok(());
        }

        if started.elapsed() >= timeout {
            trace::write(&format!(
                "更新进程就绪信号未出现：标记={} 存在={} 子进程pid={child_pid} 耗时={}ms \
                 最后一次状态={last_read} env_temp={} 目录内容=[{}]",
                ready_path.display(),
                ready_path.exists(),
                started.elapsed().as_millis(),
                std::env::temp_dir().display(),
                describe_dir(ready_path.parent()),
            ));
            return Err(download_error(
                "更新进程未能启动，本次更新已取消，请重试。".to_string(),
            ));
        }
    }
}

/// 也不要把一段碰巧含数字的垃圾内容当成「已就绪」。
pub(super) fn parse_ready_pid(bytes: &[u8]) -> Option<u32> {
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == start {
        return None;
    }
    std::str::from_utf8(&bytes[start..index]).ok()?.parse().ok()
}

/// 字节开头一小段的十六进制预览（含总长度）：标记不是合法文本时用它还原现场
pub(super) fn hex_preview(bytes: &[u8]) -> String {
    let preview = bytes
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("len={} [{preview}]", bytes.len())
}

/// 列出目录里的条目（`名称:长度`），用于在就绪标记读不到时确认文件到底有没有落盘
pub(super) fn describe_dir(directory: Option<&Path>) -> String {
    let Some(directory) = directory else {
        return String::from("无父目录");
    };
    match std::fs::read_dir(directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| {
                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                format!("{}:{size}", entry.file_name().to_string_lossy())
            })
            .collect::<Vec<_>>()
            .join(", "),
        Err(error) => format!("无法列出（{:?}）", error.kind()),
    }
}

/// 留着只会让客户端下次启动读到过期提示
pub(super) fn clear_previous_result() {
    let _ = std::fs::remove_file(temp_dir().join(RESULT_FILE_NAME));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    /// 安装是否成功
    pub installed: bool,
    /// 安装程序退出码；用户取消提权授权时为 [`EXIT_ELEVATION_DENIED`]，无法解析时为 `None`
    pub exit_code: Option<i32>,
    /// 是否改用提权身份安装过
    pub elevated: bool,
    /// 更新日志路径，安装失败时供用户与开发者还原过程
    pub log_path: String,
    /// 可直接显示给用户的一句话结论
    pub message: String,
}

/// 更新早已结束，这里只负责把已知信息说清楚。
pub(super) fn interpret_result(raw: &str, log_path: &Path) -> UpdateOutcome {
    let mut fields = raw.split('|');
    let installed = fields.next().map(str::trim) == Some(RESULT_OK);
    let exit_code = fields
        .next()
        .and_then(|value| value.trim().parse::<i32>().ok());
    let elevated = fields
        .next()
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let message = if installed {
        "更新已安装完成。".to_string()
    } else {
        match exit_code {
            Some(EXIT_ELEVATION_DENIED) => format!(
                "本次更新未完成：安装需要管理员授权，授权被取消。日志见 {}",
                log_path.display()
            ),
            Some(code) => format!(
                "本次更新未安装成功（安装程序退出码 {code}），已回到原版本。日志见 {}",
                log_path.display()
            ),
            None => format!(
                "本次更新未安装成功，已回到原版本。日志见 {}",
                log_path.display()
            ),
        }
    };
    UpdateOutcome {
        installed,
        exit_code,
        elevated,
        log_path: log_path.to_string_lossy().into_owned(),
        message,
    }
}
