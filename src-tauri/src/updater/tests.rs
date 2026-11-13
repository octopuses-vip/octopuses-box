use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use super::commands::*;
use super::download::*;
use super::install::*;
use super::script::*;

#[test]
fn percent_decode_restores_utf8_names() {
    assert_eq!(percent_decode("octopuses-0.40.0.zip"), "octopuses-0.40.0.zip");
    assert_eq!(percent_decode("%E5%AE%89%E8%A3%85.exe"), "安装.exe");
    // 非法转义与截断的转义按原样保留，不 panic
    assert_eq!(percent_decode("100%25"), "100%");
    assert_eq!(percent_decode("bad%"), "bad%");
}

#[test]
fn extract_file_name_prefers_rfc5987_form() {
    let header =
        "attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E5%AE%89%E8%A3%85.exe";
    assert_eq!(extract_file_name(header).as_deref(), Some("安装.exe"));
}

#[test]
fn extract_file_name_reads_plain_form() {
    assert_eq!(
        extract_file_name("attachment; filename=\"octopuses-0.40.0-setup.exe\"").as_deref(),
        Some("octopuses-0.40.0-setup.exe")
    );
    assert_eq!(
        extract_file_name("attachment; filename=octopuses.zip").as_deref(),
        Some("octopuses.zip")
    );
    assert_eq!(extract_file_name("inline").as_deref(), None);
}

#[test]
fn extract_file_name_drops_directory_parts() {
    // 服务端返回的名字不可信：带上目录时只取最后一段，防止写出临时目录
    assert_eq!(
        extract_file_name("attachment; filename=\"../../etc/passwd\"").as_deref(),
        Some("passwd")
    );
    assert_eq!(
        extract_file_name("attachment; filename=\"..\"").as_deref(),
        None
    );
}

#[test]
fn script_branches_install_by_package_type() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses-setup.exe"),
        Path::new(r"C:\tmp\octopuses.exe"),
        0,
    );
    // NSIS 静默参数与 WiX 的 msiexec 调用都由脚本按扩展名分支执行
    assert!(script.contains("$installArgs = @('/S')"), "{script}");
    assert!(script.contains("$file = 'msiexec.exe'"), "{script}");
    assert!(script.contains("'/quiet', '/norestart'"), "{script}");
    // 两种安装包都必须等待安装结束，否则会新旧版本并存
    assert!(script.contains("-Wait -PassThru"), "{script}");
    // 压缩包按系统默认方式打开且不等待：等它「结束」可能永远不返回
    assert!(
        script.contains("Start-Process -FilePath $installer\n    return 0"),
        "{script}"
    );
}

#[test]
fn script_waits_then_installs_then_restarts_unconditionally() {
    let script = update_script(
        4321,
        Path::new(r"C:\tmp\octopuses-setup.exe"),
        Path::new(r"C:\Program Files\octopuses\octopuses.exe"),
        0,
    );
    let wait = script
        .find("Wait-Process -Id 4321")
        .expect("应先等待客户端退出");
    let install = script
        .find("Install-Package -AsAdmin $false")
        .expect("应安装安装包");
    let restart = script
        .find("Start-Process -FilePath $target")
        .expect("应重新启动客户端");
    assert!(wait < install, "安装必须发生在客户端退出之后：{script}");
    assert!(install < restart, "重启必须发生在安装之后：{script}");
    assert!(
        script.contains("'C:\\Program Files\\octopuses\\octopuses.exe'"),
        "路径含空格时应被单引号包住：{script}"
    );
    // 客户端此刻已经退出，安装失败也必须拉起，否则用户停在「客户端不见了」的状态
    assert!(
        script.contains("if (Test-Path -LiteralPath $target)"),
        "重启不能以安装成功为前提：{script}"
    );
}

#[test]
fn script_retries_restart_until_the_client_survives() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses-setup.exe"),
        Path::new(r"C:\tmp\octopuses.exe"),
        0,
    );
    // 安装程序异步收尾会误伤刚起来的客户端（退出码 0、追踪日志一行不写），
    // 因此必须重试到确认存活，而不是拉起一次就放手
    assert!(
        script.contains(&format!("foreach ($round in 1..{RESTART_ATTEMPTS})")),
        "{script}"
    );
    assert!(
        script.contains(&format!("Start-Sleep -Seconds {RESTART_SETTLE_SECONDS}")),
        "{script}"
    );
    assert!(script.contains("restart alive"), "{script}");
    assert!(script.contains("restart died"), "{script}");
    // 重启失败时把同期残留的安装进程一并记下，否则「客户端被谁结束的」无从判断
    assert!(script.contains(INSTALLER_PROCESS_PATTERN), "{script}");
}

#[test]
fn script_restarts_the_newest_installed_copy() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses.msi"),
        Path::new(r"C:\tmp\octopuses.exe"),
        0,
    );
    // MSI 会装到与用户级安装不同的目录：重启前要按卸载登记重新定位，否则拉起的是旧版本
    assert!(script.contains("function Resolve-ClientPath"), "{script}");
    assert!(
        script.contains("Sort-Object -Property Version -Descending"),
        "应按版本号挑最新的那份安装：{script}"
    );
    // NSIS 写入的 InstallLocation 带引号，必须剥掉再拼路径
    assert!(script.contains(r#".Trim('"')"#), "{script}");
}

#[test]
fn script_retries_with_elevation_only_for_privilege_errors() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses.msi"),
        Path::new(r"C:\tmp\octopuses.exe"),
        0,
    );
    // 只有权限类退出码才提权重试，避免包损坏等失败也白弹一次 UAC
    assert!(
        script.contains("$elevationCodes = @(1603, 1925)"),
        "{script}"
    );
    assert!(
        script.contains("if ($elevationCodes -contains $exitCode)"),
        "{script}"
    );
    assert!(script.contains("-Verb RunAs"), "{script}");
    // 用户取消授权时脚本仍要继续走完，客户端才拉得起来
    assert!(script.contains("$exitCode = -2"), "{script}");
}

#[test]
fn script_writes_result_and_log_beside_the_package() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses.msi"),
        Path::new(r"C:\tmp\octopuses.exe"),
        0,
    );
    let directory = temp_dir();
    assert!(
        script.contains(&ps_quote_path(&directory.join("octopuses-update.log"))),
        "{script}"
    );
    assert!(
        script.contains(&ps_quote_path(&directory.join("octopuses-update-result.txt"))),
        "{script}"
    );
    assert!(script.contains("Set-Content -LiteralPath"), "{script}");
}

#[test]
fn script_has_no_unreplaced_placeholder() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses.msi"),
        Path::new(r"C:\tmp\octopuses.exe"),
        0,
    );
    assert!(
        !script.contains("__OTS_"),
        "占位符必须全部被替换：{script}"
    );
}

#[test]
fn interpret_result_reads_status_code_and_elevation() {
    let log = Path::new(r"C:\tmp\octopuses-update.log");

    let ok = interpret_result("ok|0|true", log);
    assert!(ok.installed);
    assert_eq!(ok.exit_code, Some(0));
    assert!(ok.elevated);

    let failed = interpret_result("failed|1925|false", log);
    assert!(!failed.installed);
    assert_eq!(failed.exit_code, Some(1925));
    assert!(failed.message.contains("1925"), "{}", failed.message);

    let denied = interpret_result("failed|-2|true", log);
    assert!(!denied.installed);
    assert!(denied.message.contains("授权"), "{}", denied.message);

    // 内容不合格式时按「未安装成功」处理，不 panic
    let broken = interpret_result("", log);
    assert!(!broken.installed);
    assert_eq!(broken.exit_code, None);
    assert!(!broken.elevated);
}

#[test]
fn parse_ready_pid_reads_prefix_and_ignores_trailing_junk() {
    // 正常写入：数字 + 换行
    assert_eq!(parse_ready_pid(b"9284\r\n"), Some(9284));
    // 前缀带空白也认
    assert_eq!(parse_ready_pid(b"  3688 "), Some(3688));
    // 关键场景：前缀是合法 PID，后面跟着非 UTF-8 残留也必须能读出 PID，
    // 否则 read_to_string 会整体报 InvalidData，把「已就绪」误判成「读不到」
    assert_eq!(parse_ready_pid(b"9284\r\n\xFF\xFE\x00garbage"), Some(9284));
}

#[test]
fn parse_ready_pid_rejects_non_numeric_prefix() {
    // 首段不是数字时宁可继续等，也不要把含数字的垃圾当成 PID
    assert_eq!(parse_ready_pid(b"\xFF\xFE9284"), None);
    assert_eq!(parse_ready_pid(b""), None);
    assert_eq!(parse_ready_pid(b"   "), None);
    // 数字超出 u32 范围时解析失败而不是回绕
    assert_eq!(parse_ready_pid(b"999999999999"), None);
}

#[test]
fn ps_quote_path_escapes_single_quotes() {
    assert_eq!(
        ps_quote_path(Path::new("C:\\it's\\a.exe")),
        "'C:\\it''s\\a.exe'"
    );
}

#[test]
fn detects_the_client_binary_itself_as_not_an_installer() {
    // 正斜杠在 Windows 与 Unix 都能分隔路径，避免宿主平台把整条 Windows 路径当成文件名。
    let client = Path::new("C:/Users/me/AppData/Local/octopuses/octopuses.exe");
    // 更新源直接下发客户端本体：文件名与本体一致，必须判为本体
    assert!(is_client_binary(Path::new("C:/Temp/octopuses.exe"), client));
    // Windows 文件名不区分大小写，改过大小写仍是同一个文件
    assert!(is_client_binary(Path::new("C:/Temp/OTS.EXE"), client));

    // 打包工具产出的安装包名与本体不同，不能误伤
    assert!(!is_client_binary(
        Path::new("C:/Temp/octopuses_0.41.2_x64-setup.exe"),
        client
    ));
    assert!(!is_client_binary(
        Path::new("C:/Temp/octopuses_0.41.2_x64_en-US.msi"),
        client
    ));
    assert!(!is_client_binary(Path::new("C:/Temp"), client));
}

#[test]
fn percent_of_handles_unknown_total() {
    assert_eq!(percent_of(10, 0), 0);
    assert_eq!(percent_of(1, 4), 25);
    // 超过总量时按 100 封顶，避免进度条溢出
    assert_eq!(percent_of(200, 100), 100);
}

/// 校验器：只把脚本解析成语法树，不执行其中任何语句
const SYNTAX_CHECKER: &str = r#"$errors = $null; $tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile('__OTS_SCRIPT__', [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }"#;

/// 读取脚本产出的文本文件。
///
/// 本机若装有透明加密／DLP 驱动，「脚本（白名单进程）写的文件」在**非白名单**进程里会呈现为
/// 8192 字节密文（以 `%TSD-Header-###%` 开头），而测试二进制并不在白名单里，
/// `std::fs::read_to_string` 因此读不到内容——这正是客户端读不到就绪标记的同一现象。
/// 这里改由 PowerShell（与脚本同属白名单）读取，用例在有无加密驱动的环境下都能验证产出内容；
/// PowerShell 不可用时退回直接读取。
#[cfg(windows)]
fn read_output(path: &Path) -> String {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Content -LiteralPath $env:OTS_READ -Raw",
        ])
        .env("OTS_READ", path)
        .output();
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        _ => std::fs::read_to_string(path).unwrap_or_default(),
    }
}

/// 更新脚本一旦语法出错，客户端退出后就再没有补救机会（连重启都不会发生），
/// 因此这里借助 PowerShell 自己的解析器做一次静态校验：只解析、不执行。
#[cfg(windows)]
#[test]
fn script_template_parses_as_valid_powershell() {
    let script = update_script(
        4321,
        Path::new(r"C:\tmp\octopuses-setup.exe"),
        Path::new(r"C:\Program Files\octopuses\octopuses.exe"),
        0,
    );
    let path =
        std::env::temp_dir().join(format!("octopuses-script-check-{}.ps1", std::process::id()));
    // 带 BOM 落盘：PowerShell 5.1 读 .ps1 默认按 ANSI，模板里的中文注释会被读成乱码，
    // 校验结果就失真了（真正执行时脚本经 UTF-16 命令行传入，不受文件编码影响）
    std::fs::write(&path, format!("\u{feff}{script}")).expect("写入待校验脚本失败");

    let checker = SYNTAX_CHECKER.replace("__OTS_SCRIPT__", &path.to_string_lossy());
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            checker.as_str(),
        ])
        .output()
        .expect("调用 PowerShell 解析器失败");
    let _ = std::fs::remove_file(&path);

    assert!(
        output.status.success(),
        "更新脚本存在语法错误：{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

/// 端到端验证「脚本落盘 → PowerShell 读文件执行 → 结果落盘」这条链路。
///
/// 这条链曾经断在第一步：脚本被塞进 `-Command` 传参，双引号经命令行转义后解析坏掉，
/// 子进程连第一行都跑不到，而客户端此时已经退出，于是只剩「点了更新，客户端没了」。
/// 这里只解析语法是不够的——本用例真的把脚本跑一遍，确认它执行到了写结果那一步。
///
/// 脚本开头会尝试经 WMI 自我逃逸；为了让用例确定性地只验证「能跑完」，这里按「已在作业之外」
/// 的方式调用脚本（把 [`ESCAPE_FLAG`] 传给它），从而跳过逃逸分支，直接走安装与重启流程。
#[cfg(windows)]
#[test]
fn generated_script_runs_and_writes_result() {
    let probe = std::env::temp_dir().join(format!("octopuses-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&probe);
    std::fs::create_dir_all(&probe).expect("创建探测目录失败");

    // 安装包故意用压缩包后缀：脚本走「按系统默认方式打开」分支且不等待，
    // 文件不存在也只是一次非终止错误，不会真的安装或启动任何东西
    let script = update_script(
        999_999,
        &probe.join("fake-setup.zip"),
        &probe.join("fake-client.exe"),
        0,
    )
    .replace(
        &temp_dir().to_string_lossy().to_string(),
        &probe.to_string_lossy().to_string(),
    );

    let path = probe.join("probe.ps1");
    let mut bytes = "\u{feff}".as_bytes().to_vec();
    bytes.extend_from_slice(script.as_bytes());
    std::fs::write(&path, bytes).expect("写入探测脚本失败");

    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.to_string_lossy().as_ref(),
            // 跳过 WMI 自我逃逸分支，让用例确定性地验证「脚本能跑完」
            ESCAPE_FLAG,
        ])
        .status()
        .expect("启动 PowerShell 失败");

    let raw = read_output(&probe.join(RESULT_FILE_NAME));
    let log = read_output(&probe.join(LOG_FILE_NAME));
    // 就绪标记是客户端判定「逃逸成功」的依据，脚本跑完必须留下它
    let ready = read_output(&probe.join(READY_FILE_NAME));
    let _ = std::fs::remove_dir_all(&probe);

    assert!(
        raw.starts_with(RESULT_OK),
        "脚本没能执行到最后一步（结果文件缺失或内容异常）：{raw:?}"
    );
    // 日志同样必须落地：更新失败时它是唯一能还原过程的东西，不能依赖 host 是否支持转录
    assert!(log.contains("updater started"), "日志缺少启动记录：{log:?}");
    assert!(log.contains("done"), "日志缺少结束记录：{log:?}");
    assert_eq!(
        ready.trim().parse::<u32>().map(|_| ()),
        Ok(()),
        "就绪标记必须写入可解析的 PID：{ready:?}"
    );
}

/// 渲染后的脚本必须同时具备「就绪握手」与「逃逸守卫」两处关键逻辑，
/// 否则客户端无法判定更新进程是否已逃出作业对象，会退回到「点了更新、客户端没了」的旧毛病。
#[test]
fn script_escapes_job_and_reports_readiness() {
    let script = update_script(
        1,
        Path::new(r"C:\tmp\octopuses.msi"),
        Path::new(r"C:\tmp\octopuses.exe"),
        38217,
    );
    // 就绪握手首选回环 UDP：端口占位符必须被替换成客户端占用的实际端口。
    // 透明加密/DLP 会让脚本写的标记文件在客户端侧变成密文，握手只能走内核对象而非文件系统。
    assert!(
        !script.contains(PLACEHOLDER_READY_PORT),
        "端口占位符必须被替换：{script}"
    );
    assert!(
        script.contains("UdpClient"),
        "脚本应经回环 UDP 报回 PID：{script}"
    );
    assert!(script.contains("'127.0.0.1', 38217"), "{script}");
    // 文件通道作为兜底保留（无加密驱动环境可用），路径占位符同样必须被替换
    let ready = temp_dir()
        .join(READY_FILE_NAME)
        .to_string_lossy()
        .into_owned();
    assert!(script.contains(&format!("'{ready}'")), "{script}");
    // 逃逸标志必须被替换进「二次拉起自己」的命令行
    assert!(script.contains(ESCAPE_FLAG), "{script}");
    // 参数守卫与 WMI 逃逸逻辑必须存在，否则会无限自我复制
    assert!(script.contains("param([switch]$Escaped)"), "{script}");
    assert!(script.contains("if (-not $Escaped)"), "{script}");
    assert!(script.contains("[wmiclass]'Win32_Process'"), "{script}");
    // 逃逸失败时必须退回原地（不静默放过），并有日志说明
    assert!(script.contains("continue in place"), "{script}");
}
