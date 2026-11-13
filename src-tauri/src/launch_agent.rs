//! macOS LaunchAgent 注册与卸载。
//!
//! 应用进程完全退出后，[automation.rs](crate::automation) 里的进程内定时器不再运行。为了让
//! 「长期任务」在应用关闭时仍能按时执行，这里把每个已启用的定时任务注册成一个 LaunchAgent：
//! 到点由系统重新唤起本应用，并带上 `--automation-run <taskId>` 参数，由前端复用同一条运行
//! 链路直接执行该任务。
//!
//! 只用系统自带的 `launchctl`，不引入 plist / cron 依赖：plist 由字符串模板生成并做 XML 转义。
//!
//! **平台支持**：系统级后台定时仅 macOS 有对应机制。非 macOS 上所有对外入口都返回空结果
//! （注册 / 查询 / 清理 / 卸载均为空操作），不报错也不落任何文件；前端据平台隐藏「后台定时」
//! 入口，应用内调度（[automation.rs](crate::automation)）在三平台行为一致。
//! 纯函数（label 生成、plist 拼装、参数解析）保持跨平台，因此其单测在三个平台都会执行。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// LaunchAgent label 前缀；避免与用户其它定时项冲突，同时便于识别本应用注册的项
const LABEL_PREFIX: &str = "vip.octopuses.box.automation.";
/// 唤起应用时传入的参数名，取值需与 `lib.rs` 的解析保持一致
pub const RUN_ARG: &str = "--automation-run";
/// StartInterval 的最小秒数：低于一分钟的高频唤起没有意义
const MIN_INTERVAL_SECONDS: u64 = 60;

/// 一个要注册为后台定时项的任务规格（由前端从 cron / 间隔推导后下发）
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    /// 任务 id，与前端 `Automation.id` 一致
    id: String,
    /// 固定间隔（秒）；与 `calendar` 二选一，都没有则不注册
    interval_seconds: Option<u64>,
    /// 日历式触发；与 `interval_seconds` 二选一
    calendar: Option<CalendarSpec>,
}

/// 日历式触发规格（`StartCalendarInterval`）；字段为 `None` 表示该维度不限制
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSpec {
    minute: Option<u32>,
    hour: Option<u32>,
    weekday: Option<u32>,
    day: Option<u32>,
}

/// 已注册的后台定时项信息
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// 任务 id
    pub task_id: String,
    /// LaunchAgent label，也是 plist 文件名（去掉 `.plist`）
    pub label: String,
    /// plist 文件绝对路径
    pub path: String,
}

/// 任务 id → LaunchAgent label。
///
/// 文件名安全字符直通、其余替换为下划线；末尾附加原始 id 的短哈希，保证「`a b` 与 `a_b`」
/// 这类净化后会撞车的不同 id 仍然得到不同的 label。
pub fn label_for(task_id: &str) -> String {
    let mut safe = String::with_capacity(task_id.len());
    for ch in task_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            safe.push(ch);
        } else {
            safe.push('_');
        }
    }
    if safe.is_empty() {
        safe.push_str("task");
    }
    // FNV-1a 32 位：只用于避免撞名，不作为安全哈希
    let mut hash: u32 = 2_166_136_261;
    for byte in task_id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("{LABEL_PREFIX}{safe}-{hash:08x}")
}

/// plist 是 XML，文本节点必须转义，否则路径或任务名里的 `& < >` 会让 plist 无法解析
fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 反向转义：读取 plist 时把 `&amp;` 之类还原，便于取回原始任务 id 与可执行文件路径
fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 生成一段调度声明；间隔优先，其次是日历，都没有则不写调度键
fn schedule_block(spec: &AgentSpec) -> String {
    if let Some(seconds) = spec.interval_seconds {
        let seconds = seconds.max(MIN_INTERVAL_SECONDS);
        return format!("  <key>StartInterval</key>\n  <integer>{seconds}</integer>\n");
    }
    let Some(calendar) = &spec.calendar else {
        return String::new();
    };
    let mut entries = String::new();
    if let Some(minute) = calendar.minute {
        entries.push_str(&format!(
            "    <key>Minute</key>\n    <integer>{minute}</integer>\n"
        ));
    }
    if let Some(hour) = calendar.hour {
        entries.push_str(&format!(
            "    <key>Hour</key>\n    <integer>{hour}</integer>\n"
        ));
    }
    if let Some(weekday) = calendar.weekday {
        entries.push_str(&format!(
            "    <key>Weekday</key>\n    <integer>{weekday}</integer>\n"
        ));
    }
    if let Some(day) = calendar.day {
        entries.push_str(&format!(
            "    <key>Day</key>\n    <integer>{day}</integer>\n"
        ));
    }
    format!("  <key>StartCalendarInterval</key>\n  <dict>\n{entries}  </dict>\n")
}

/// 生成一个 LaunchAgent 的 plist 内容。
///
/// `RunAtLoad` 恒为 `false`：装载本身不触发运行，只有到点才唤起，避免每次打开应用都补跑一轮。
pub fn plist_body(exe: &str, task_id: &str, label: &str, spec: &AgentSpec) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ",
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "  <key>Label</key>\n  <string>{label}</string>\n",
            "  <key>ProgramArguments</key>\n  <array>\n",
            "    <string>{exe}</string>\n",
            "    <string>{run_arg}</string>\n",
            "    <string>{task_id}</string>\n",
            "  </array>\n",
            "  <key>RunAtLoad</key>\n  <false/>\n",
            "{schedule}",
            "  <key>ProcessType</key>\n  <string>Background</string>\n",
            "</dict>\n",
            "</plist>\n",
        ),
        label = xml_escape(label),
        exe = xml_escape(exe),
        run_arg = xml_escape(RUN_ARG),
        task_id = xml_escape(task_id),
        schedule = schedule_block(spec),
    )
}

/// 取出 plist 中某段 `<string>...</string>` 列表（按出现顺序）
fn parse_string_list(fragment: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut rest = fragment;
    while let Some(start) = rest.find("<string>") {
        let after = &rest[start + "<string>".len()..];
        let Some(end) = after.find("</string>") else {
            break;
        };
        values.push(xml_unescape(&after[..end]));
        rest = &after[end + "</string>".len()..];
    }
    values
}

/// 读取 `ProgramArguments` 的字符串项：`[可执行文件, --automation-run, 任务 id]`
fn parse_program_arguments(body: &str) -> Vec<String> {
    let Some(marker) = body.find("<key>ProgramArguments</key>") else {
        return Vec::new();
    };
    let rest = &body[marker..];
    // 只取数组内部：后面还有 ProcessType 等其它 <string>，不能一路扫到文件末尾
    let end = rest.find("</array>").unwrap_or(rest.len());
    parse_string_list(&rest[..end])
}

/// 从命令行参数里取出被唤起要执行的任务 id（`--automation-run <taskId>`）。
///
/// 只有 macOS 会把任务注册成系统级定时项，因此其它平台不可能带该参数，直接返回 `None`。
pub fn wake_task_id() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    wake_from_args(std::env::args().skip(1))
}

/// `wake_task_id` 的纯函数形态，便于单测
fn wake_from_args<I: Iterator<Item = String>>(mut args: I) -> Option<String> {
    while let Some(arg) = args.next() {
        if arg == RUN_ARG {
            return args.next();
        }
    }
    None
}

/// 当前可执行文件的绝对路径（写入 plist，作为唤起时的 `program`）
fn current_exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("获取当前可执行文件路径失败：{error}"))
}

/// LaunchAgents 目录：`~/Library/LaunchAgents`（仅 macOS 分支使用）
fn launch_agents_dir() -> Result<PathBuf, String> {
    Ok(crate::platform::home_dir()
        .join("Library")
        .join("LaunchAgents"))
}

/// 当前用户 uid，用于 `launchctl` 的 `gui/<uid>` 目标
fn current_uid() -> Result<String, String> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("获取用户 uid 失败：{error}"))?;
    if !output.status.success() {
        return Err("获取用户 uid 失败：id -u 非零退出".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 卸载一个已装载的定时项；未装载时 `launchctl` 会报错，调用方按「本来就没有」忽略
fn bootout(uid: &str, label: &str) -> Result<(), String> {
    let target = format!("gui/{uid}/{label}");
    let output = Command::new("launchctl")
        .arg("bootout")
        .arg(&target)
        .output()
        .map_err(|error| format!("执行 launchctl bootout 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

/// 装载一个 plist
fn bootstrap(uid: &str, plist: &Path) -> Result<(), String> {
    let target = format!("gui/{uid}");
    let output = Command::new("launchctl")
        .arg("bootstrap")
        .arg(&target)
        .arg(plist)
        .output()
        .map_err(|error| format!("执行 launchctl bootstrap 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "launchctl bootstrap 失败：{}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// 启用一个已装载的定时项（历史上被 `disable` 过时需要）
fn enable(uid: &str, label: &str) -> Result<(), String> {
    let target = format!("gui/{uid}/{label}");
    let output = Command::new("launchctl")
        .arg("enable")
        .arg(&target)
        .output()
        .map_err(|error| format!("执行 launchctl enable 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

/// 列出本应用注册的全部后台定时项
fn list_installed() -> Result<Vec<AgentInfo>, String> {
    let dir = launch_agents_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries =
        fs::read_dir(&dir).map_err(|error| format!("读取 LaunchAgents 目录失败：{error}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(LABEL_PREFIX) || !name.ends_with(".plist") {
            continue;
        }
        let label = name.trim_end_matches(".plist").to_string();
        // 任务 id 从 plist 的 ProgramArguments 里取回：label 受过净化与哈希，无法反推
        let task_id = fs::read_to_string(&path)
            .ok()
            .and_then(|body| parse_program_arguments(&body).into_iter().nth(2))
            .unwrap_or_else(|| label.clone());
        out.push(AgentInfo {
            task_id,
            label,
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

/// 注册一批后台定时项；对同一任务重复调用是幂等的（先卸载再覆盖写入并重新装载）。
///
/// 只有带调度（间隔或日历）的规格才会被注册；调用方需另行 [prune] 掉不再需要的任务。
///
/// 仅 macOS 有对应的系统机制（LaunchAgent）；其它平台直接返回空列表而不报错——报错会打断
/// 前端的注册流程，而这些平台的后台定时入口已由前端按平台隐藏。
#[tauri::command]
pub fn launch_agent_install(specs: Vec<AgentSpec>) -> Result<Vec<AgentInfo>, String> {
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }
    let exe = current_exe()?;
    let dir = launch_agents_dir()?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建 LaunchAgents 目录失败：{error}"))?;
    let uid = current_uid()?;
    let mut installed = Vec::new();
    for spec in &specs {
        if spec.interval_seconds.is_none() && spec.calendar.is_none() {
            continue;
        }
        let label = label_for(&spec.id);
        let path = dir.join(format!("{label}.plist"));
        // 幂等：先卸载同名项（可能指向旧的可执行文件路径），再覆盖写入并重新装载
        let _ = bootout(&uid, &label);
        fs::write(&path, plist_body(&exe, &spec.id, &label, spec))
            .map_err(|error| format!("写入 plist 失败（{}）：{error}", path.display()))?;
        bootstrap(&uid, &path)?;
        let _ = enable(&uid, &label);
        installed.push(AgentInfo {
            task_id: spec.id.clone(),
            label,
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(installed)
}

/// 卸载一个后台定时项：先 `bootout` 再删除 plist，二者都按幂等处理（非 macOS 为空操作）
#[tauri::command]
pub fn launch_agent_uninstall(task_id: String) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let dir = launch_agents_dir()?;
    let label = label_for(&task_id);
    let path = dir.join(format!("{label}.plist"));
    let uid = current_uid()?;
    let _ = bootout(&uid, &label);
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("删除 plist 失败（{}）：{error}", path.display()))?;
    }
    Ok(())
}

/// 列出已注册的后台定时项（供设置页展示与清理）；非 macOS 恒为空列表
#[tauri::command]
pub fn launch_agent_status() -> Result<Vec<AgentInfo>, String> {
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }
    list_installed()
}

/// 保留 `active_ids` 里的任务，其余一律卸载；返回被移除的任务 id 列表。
///
/// 传空列表即「移除全部后台定时项」，用于设置页的一次性清理。非 macOS 无定时项可清，直接返回空。
#[tauri::command]
pub fn launch_agent_prune(active_ids: Vec<String>) -> Result<Vec<String>, String> {
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }
    let uid = current_uid()?;
    let mut removed = Vec::new();
    for info in list_installed()? {
        if active_ids.contains(&info.task_id) {
            continue;
        }
        let _ = bootout(&uid, &info.label);
        let _ = fs::remove_file(&info.path);
        removed.push(info.task_id);
    }
    Ok(removed)
}

/// 启动自检：清掉指向「其它路径下的可执行文件」的旧定时项。
///
/// 应用被移动或升级后 `current_exe()` 会变，旧 plist 里的路径已失效。这里只做清理，
/// 重建交给前端——前端加载任务后会带着当前路径重新 `install`（幂等）。
pub fn prune_stale_agents() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Ok(exe) = current_exe() else {
        return;
    };
    let Ok(uid) = current_uid() else {
        return;
    };
    for info in list_installed().unwrap_or_default() {
        let Ok(body) = fs::read_to_string(&info.path) else {
            continue;
        };
        if parse_program_arguments(&body).first().map(String::as_str) == Some(exe.as_str()) {
            continue;
        }
        let _ = bootout(&uid, &info.label);
        let _ = fs::remove_file(&info.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str) -> AgentSpec {
        AgentSpec {
            id: id.to_string(),
            interval_seconds: Some(900),
            calendar: None,
        }
    }

    #[test]
    fn labels_stay_unique_after_sanitizing() {
        // 净化后同为 `a_b`，但哈希不同，label 不应撞车
        assert_ne!(label_for("a b"), label_for("a_b"));
        assert!(label_for("auto-1").starts_with(LABEL_PREFIX));
        assert!(label_for("").starts_with(LABEL_PREFIX));
    }

    #[test]
    fn xml_escape_covers_plist_specials() {
        assert_eq!(xml_escape("a&b<c>\"d'e"), "a&amp;b&lt;c&gt;&quot;d&apos;e");
        assert_eq!(xml_unescape(&xml_escape("a&b<c>\"d'e")), "a&b<c>\"d'e");
    }

    #[test]
    fn plist_body_carries_interval_and_escapes_text() {
        let task_id = "task <1>";
        let body = plist_body(
            "/Applications/octopuses & co/octopuses",
            task_id,
            &label_for(task_id),
            &spec(task_id),
        );
        assert!(body.contains("<key>StartInterval</key>"));
        assert!(body.contains("<integer>900</integer>"));
        assert!(body.contains(RUN_ARG));
        assert!(body.contains("task &lt;1&gt;"));
        assert!(!body.contains("task <1>"));
        assert!(body.contains("octopuses &amp; co"));
        assert!(body.contains("<key>RunAtLoad</key>\n  <false/>"));
    }

    #[test]
    fn plist_body_clamps_tiny_intervals() {
        let mut item = spec("tiny");
        item.interval_seconds = Some(5);
        let body = plist_body("/bin/octopuses", "tiny", "lbl", &item);
        assert!(body.contains(&format!("<integer>{MIN_INTERVAL_SECONDS}</integer>")));
    }

    #[test]
    fn plist_body_supports_calendar_only() {
        let mut item = spec("daily");
        item.interval_seconds = None;
        item.calendar = Some(CalendarSpec {
            minute: Some(30),
            hour: Some(9),
            weekday: None,
            day: None,
        });
        let body = plist_body("/bin/octopuses", "daily", "lbl", &item);
        assert!(body.contains("<key>StartCalendarInterval</key>"));
        assert!(body.contains("<key>Minute</key>"));
        assert!(body.contains("<key>Hour</key>"));
        assert!(body.contains("<integer>30</integer>"));
        assert!(!body.contains("<key>StartInterval</key>"));
        assert!(!body.contains("Weekday"));
    }

    #[test]
    fn plist_body_without_schedule_has_no_timer_key() {
        let mut item = spec("manual");
        item.interval_seconds = None;
        let body = plist_body("/bin/octopuses", "manual", "lbl", &item);
        assert!(!body.contains("<key>StartInterval</key>"));
        assert!(!body.contains("<key>StartCalendarInterval</key>"));
    }

    #[test]
    fn program_arguments_round_trip() {
        let body = plist_body(
            "/bin/octopuses",
            "auto-1",
            &label_for("auto-1"),
            &spec("auto-1"),
        );
        assert_eq!(
            parse_program_arguments(&body),
            vec![
                "/bin/octopuses".to_string(),
                RUN_ARG.to_string(),
                "auto-1".to_string()
            ]
        );
        assert!(parse_program_arguments("no args here").is_empty());
    }

    #[test]
    fn wake_argument_is_read_from_pair() {
        let args = vec![
            "--other".to_string(),
            RUN_ARG.to_string(),
            "auto-9".to_string(),
        ];
        assert_eq!(wake_from_args(args.into_iter()).as_deref(), Some("auto-9"));
        assert!(wake_from_args(std::iter::empty()).is_none());
        assert!(wake_from_args(vec!["--flag".to_string()].into_iter()).is_none());
    }
}
