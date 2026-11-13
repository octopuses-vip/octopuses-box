use std::path::{Path, PathBuf};
use crate::client_api::ApiError;
use crate::trace;
use super::download::*;

use super::install::*;

/// 脚本模板里的占位符：替换成实际值，模板本身的花括号因此无需转义，PowerShell 原样可读
pub(super) const PLACEHOLDER_PID: &str = "__OTS_PID__";

pub(super) const PLACEHOLDER_INSTALLER: &str = "__OTS_INSTALLER__";

pub(super) const PLACEHOLDER_CLIENT: &str = "__OTS_CLIENT__";

pub(super) const PLACEHOLDER_LOG: &str = "__OTS_LOG__";

pub(super) const PLACEHOLDER_RESULT: &str = "__OTS_RESULT__";

/// 以保证新实例的「客户端启动」成为第一行，避免新旧实例记录混淆
pub(super) const PLACEHOLDER_TRACE: &str = "__OTS_TRACE__";

pub(super) const PLACEHOLDER_ELEVATION_DENIED: &str = "__OTS_ELEVATION_DENIED__";

/// 就绪标记占位符：替换成标记文件的 PowerShell 路径（兜底路径使用）
pub(super) const PLACEHOLDER_READY: &str = "__OTS_READY__";

/// 就绪握手端口占位符：替换成客户端在本机回环上监听的 UDP 端口
pub(super) const PLACEHOLDER_READY_PORT: &str = "__OTS_READY_PORT__";

/// 逃逸标志占位符：替换成 [`ESCAPE_FLAG`]，用于脚本经 WMI 二次拉起自己时携带
pub(super) const PLACEHOLDER_ESCAPE_FLAG: &str = "__OTS_ESCAPE_FLAG__";

/// 重启环节的四个可调值：让位秒数、尝试轮次、每轮观察秒数、安装程序进程名匹配式
pub(super) const PLACEHOLDER_RESTART_GRACE: &str = "__OTS_RESTART_GRACE__";

pub(super) const PLACEHOLDER_RESTART_ATTEMPTS: &str = "__OTS_RESTART_ATTEMPTS__";

pub(super) const PLACEHOLDER_RESTART_SETTLE: &str = "__OTS_RESTART_SETTLE__";

pub(super) const PLACEHOLDER_INSTALLER_PATTERN: &str = "__OTS_INSTALLER_PATTERN__";

/// 以 UTF-8 BOM 落盘：PowerShell 5.1 读 `.ps1` 默认按 ANSI，模板里的中文注释会被读成乱码。
pub(super) fn write_update_script(
    client_pid: u32,
    installer: &Path,
    client_exe: &Path,
    ready_port: u16,
) -> Result<PathBuf, ApiError> {
    let directory = temp_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| download_error(format!("创建更新目录失败：{error}")))?;
    let script = update_script(client_pid, installer, client_exe, ready_port);
    let mut bytes = Vec::with_capacity(script.len() + 3);
    bytes.extend_from_slice("\u{feff}".as_bytes());
    bytes.extend_from_slice(script.as_bytes());

    let path = directory.join(SCRIPT_FILE_NAME);
    std::fs::write(&path, bytes)
        .map_err(|error| download_error(format!("写入更新脚本失败：{error}")))?;
    Ok(path)
}

/// 占位符由 [`update_script`] 替换，模板里的花括号与 `$` 因此都保持原样，脚本可直接阅读。
pub(super) const SCRIPT_TEMPLATE: &str = r#"param([switch]$Escaped)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# 日志用手写而不用 Start-Transcript：脱离控制台的进程里 PowerShell 的 host 未必支持转录，
# 转录一旦失败就一行日志都不会留下，更新出问题时便没有任何线索可查
function Write-Log {
  param([string]$Message)
  Add-Content -LiteralPath __OTS_LOG__ -Value "$(Get-Date -Format 'HH:mm:ss') $Message" -Encoding ascii -ErrorAction SilentlyContinue
}

# ---- 作业逃逸守卫（在任何实际工作之前执行）----
# 客户端可能长在「不允许 breakaway 的作业对象」里（例如从 IDE 或终端启动）。这类作业一旦关闭会把里面的
# 进程全部收走（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE），客户端一退出，本脚本就会被连坐结束——连第一行都跑不到，
# 用户那边只剩「点了更新，客户端没了」。因此这里先让 WMI 服务（父进程 WmiPrvSE，不在该作业内）在作业之外
# 另建一份自己，由那份完成真正的安装工作，本份随即退出。
# __OTS_ESCAPE_FLAG__ 是守卫：带此标志即表示本份已在作业之外，直接继续干活，从而不会无限自我复制。
if (-not $Escaped) {
  $escaped = $false
  try {
    # 用绝对路径的脚本文件重新拉起自己，并原样带上本次拿到的附加参数
    $scriptPath = $PSCommandPath
    $forwarded = if ($args.Count -gt 0) { ' ' + (($args | ForEach-Object { "`"$_`"" }) -join ' ') } else { '' }
    $powerShellExe = (Get-Process -Id $PID).Path
    if (-not $powerShellExe) { $powerShellExe = 'powershell.exe' }
    $commandLine = "`"$powerShellExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" __OTS_ESCAPE_FLAG__$forwarded"
    $created = ([wmiclass]'Win32_Process').Create($commandLine)
    if ($created.ReturnValue -eq 0) {
      Write-Log "escaped outside job object via WMI: worker pid=$($created.ProcessId)"
      $escaped = $true
    } else {
      # WMI 不可用时不静默放过：退回原地继续执行，至少还能试一次
      Write-Log "escape via WMI failed (returnValue=$($created.ReturnValue)), continue in place"
    }
  } catch {
    Write-Log "escape via WMI failed ($($_.Exception.Message)), continue in place"
  }
  # 逃逸成功：干活的那份已经在作业之外，本份退场
  if ($escaped) { exit 0 }
}

# 走到这里：本份要么已带 __OTS_ESCAPE_FLAG__（本就在作业之外），要么 WMI 逃逸失败退回原地执行。
# 两种情况都由本进程承担安装工作，因此统一写下就绪标记（内容为本进程 PID）：客户端用它与刚启动的
# 子进程 PID 比对——不同说明逃逸成功，相同说明仍在作业内，客户端据此取消本次更新并保持运行。
# 就绪握手：优先用回环 UDP 把本进程 PID 发给客户端。若本机装有透明加密／DLP 驱动，
# 「脚本写的文件」在客户端进程里会呈现为 8192 字节的密文（以 %TSD-Header-###% 开头），
# 客户端永远解析不出 PID；UDP 是内核对象、不经过文件系统，不受加密驱动影响。
try {
  $udp = New-Object System.Net.Sockets.UdpClient
  $payload = [Text.Encoding]::ASCII.GetBytes("$PID")
  [void]$udp.Send($payload, $payload.Length, '127.0.0.1', __OTS_READY_PORT__)
  $udp.Close()
  Write-Log "ready marker sent via udp: pid=$PID escaped=$($Escaped.IsPresent) port=__OTS_READY_PORT__"
} catch {
  Write-Log "ready marker udp send failed ($($_.Exception.Message))"
}
# 同时写一份文件（内容同为 PID）：无加密驱动环境下的兜底，也方便人工查看
Set-Content -LiteralPath __OTS_READY__ -Value $PID -Encoding ascii -ErrorAction SilentlyContinue
Write-Log "ready marker written: pid=$PID escaped=$($Escaped.IsPresent)"

Write-Log "updater started: pid=$PID installer=__OTS_INSTALLER__ client=__OTS_CLIENT__"

# 客户端不退出，安装程序无法替换它正在使用的可执行文件
Wait-Process -Id __OTS_PID__ -ErrorAction SilentlyContinue
Write-Log 'client exited'

# 旧实例已确认退出，此时再清空客户端追踪日志：
# 旧实例的 ExitRequested/Exit 记录也会被一起删掉，新实例的「客户端启动」会成为文件第一行
Remove-Item -LiteralPath __OTS_TRACE__ -ErrorAction SilentlyContinue

$installer = __OTS_INSTALLER__
$client = __OTS_CLIENT__
$extension = [System.IO.Path]::GetExtension($installer).ToLowerInvariant()
# msiexec 在缺少管理员权限时给出的退出码：换个提权身份再试一次
$elevationCodes = @(1603, 1925)

# 安装程序可能把程序装到新位置（MSI 装进 Program Files，与用户级安装并存），
# 这时重启原路径会拉起旧版本。这里按卸载登记里版本最高的那份客户端定位。
function Resolve-ClientPath {
  param([string]$Fallback)
  $exeName = [System.IO.Path]::GetFileName($Fallback)
  $productName = [System.IO.Path]::GetFileNameWithoutExtension($Fallback)
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $found = foreach ($entry in (Get-ItemProperty $roots -ErrorAction SilentlyContinue)) {
    if ($entry.DisplayName -ne $productName) { continue }
    # NSIS 写入的安装位置带引号，不剥掉拼出来就是无效路径
    $location = "$($entry.InstallLocation)".Trim('"')
    if (-not $location) { continue }
    $candidate = Join-Path $location $exeName
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    try { $version = [version]"$($entry.DisplayVersion)" } catch { continue }
    [pscustomobject]@{ Path = $candidate; Version = $version }
  }
  $best = $found | Sort-Object -Property Version -Descending | Select-Object -First 1
  if ($best) { return $best.Path }
  return $Fallback
}

function Install-Package {
  param([bool]$AsAdmin)
  if ($extension -eq '.msi') {
    $file = 'msiexec.exe'
    $installArgs = @('/i', $installer, '/quiet', '/norestart')
  } elseif ($extension -eq '.exe') {
    $file = $installer
    $installArgs = @('/S')
  } else {
    # 压缩包等其它格式没有静默安装约定，也不等待，交给系统默认方式打开
    Start-Process -FilePath $installer
    return 0
  }
  if ($AsAdmin) {
    return (Start-Process -FilePath $file -ArgumentList $installArgs -Wait -PassThru -Verb RunAs).ExitCode
  }
  return (Start-Process -FilePath $file -ArgumentList $installArgs -Wait -PassThru).ExitCode
}

$elevated = $false
$exitCode = Install-Package -AsAdmin $false
if ($elevationCodes -contains $exitCode) {
  # 提权会弹 UAC；用户取消授权时按「未安装」处理，脚本继续往下走，保证客户端仍会被拉起
  try {
    $exitCode = Install-Package -AsAdmin $true
    $elevated = $true
  } catch {
    $exitCode = __OTS_ELEVATION_DENIED__
  }
}
Write-Log "install finished: exitCode=$exitCode elevated=$elevated"

# 安装程序收尾（写注册表、释放文件句柄，必要时还会结束同名进程）可能比主进程退出更晚，
# 紧接着拉起容易被它误伤，这里先让出一段时间
Start-Sleep -Seconds __OTS_RESTART_GRACE__
$target = Resolve-ClientPath -Fallback $client
# 版本号一并记下：安装返回 0 不代表装的真是新版本（更新地址可能仍指向旧包）
$targetVersion = 'unknown'
try { $targetVersion = (Get-Item -LiteralPath $target).VersionInfo.FileVersion } catch { }
Write-Log "restart target=$target exists=$(Test-Path -LiteralPath $target) version=$targetVersion"

# 拉起客户端并确认它真的活下来。
# 安装程序可能在主进程退出后仍异步收尾并收掉同名进程，刚起来的客户端会被误伤——
# 表现为「启动几秒内以退出码 0 消失，且客户端追踪日志一行都没有」（被外部结束而非自身崩溃）。
# 因此这里不成功就隔几秒重试，直到确认存活，避免用户停在「点了更新，客户端再没回来」。
$restarted = $false
$productName = [System.IO.Path]::GetFileNameWithoutExtension($client)
if (Test-Path -LiteralPath $target) {
  foreach ($round in 1..__OTS_RESTART_ATTEMPTS__) {
    try {
      $launched = Start-Process -FilePath $target -WorkingDirectory ([System.IO.Path]::GetDirectoryName($target)) -PassThru
      # 等几秒再判断：既给客户端留出初始化时间，也确认它不是启动后立刻退出
      Start-Sleep -Seconds __OTS_RESTART_SETTLE__
      if (-not $launched.HasExited) {
        Write-Log "restart alive: pid=$($launched.Id) round=$round"
        $restarted = $true
        break
      }
      # 退出码与同期仍在运行的安装相关进程一起记下：有残留的安装/卸载程序在跑，就能解释这次被误伤
      $survivors = (Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -ne $PID -and ($_.Name -like "*$productName*" -or $_.Name -match __OTS_INSTALLER_PATTERN__) } |
        ForEach-Object { "$($_.Name)#$($_.Id)" }) -join ','
      Write-Log "restart died: pid=$($launched.Id) exitCode=$($launched.ExitCode) round=$round 同期安装相关进程=[$survivors]"
    } catch {
      Write-Log "restart failed: round=$round $($_.Exception.Message)"
    }
    Start-Sleep -Seconds __OTS_RESTART_SETTLE__
  }
  if (-not $restarted) {
    # 多轮直启都没活下来时改由资源管理器代启：explorer 本就是独立进程，
    # 由它创建客户端可脱离更新进程的进程树与继承句柄，这是最后一道兜底
    Write-Log 'restart retry via explorer'
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$target`""
  }
}

$status = if ($exitCode -eq 0) { 'ok' } else { 'failed' }
Set-Content -LiteralPath __OTS_RESULT__ -Value "$status|$exitCode|$elevated" -Encoding ascii
Write-Log "done: status=$status"
"#;

/// 路径统一经 [`ps_quote_path`] 引号化后再替换，因此模板里写占位符时不必自带引号。
pub(super) fn update_script(client_pid: u32, installer: &Path, client_exe: &Path, ready_port: u16) -> String {
    let directory = temp_dir();
    SCRIPT_TEMPLATE
        .replace(PLACEHOLDER_PID, &client_pid.to_string())
        .replace(PLACEHOLDER_INSTALLER, &ps_quote_path(installer))
        .replace(PLACEHOLDER_CLIENT, &ps_quote_path(client_exe))
        .replace(
            PLACEHOLDER_LOG,
            &ps_quote_path(&directory.join(LOG_FILE_NAME)),
        )
        .replace(
            PLACEHOLDER_RESULT,
            &ps_quote_path(&directory.join(RESULT_FILE_NAME)),
        )
        .replace(
            PLACEHOLDER_READY,
            &ps_quote_path(&directory.join(READY_FILE_NAME)),
        )
        .replace(PLACEHOLDER_READY_PORT, &ready_port.to_string())
        .replace(PLACEHOLDER_TRACE, &ps_quote_path(&trace::log_path()))
        .replace(
            PLACEHOLDER_ELEVATION_DENIED,
            &EXIT_ELEVATION_DENIED.to_string(),
        )
        .replace(
            PLACEHOLDER_RESTART_GRACE,
            &RESTART_GRACE_SECONDS.to_string(),
        )
        .replace(PLACEHOLDER_RESTART_ATTEMPTS, &RESTART_ATTEMPTS.to_string())
        .replace(
            PLACEHOLDER_RESTART_SETTLE,
            &RESTART_SETTLE_SECONDS.to_string(),
        )
        .replace(PLACEHOLDER_INSTALLER_PATTERN, INSTALLER_PROCESS_PATTERN)
        .replace(PLACEHOLDER_ESCAPE_FLAG, ESCAPE_FLAG)
}
