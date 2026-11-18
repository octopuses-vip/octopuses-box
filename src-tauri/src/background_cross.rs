//! Per-user systemd timers and Windows scheduled tasks, scoped to application-owned labels.
use crate::launch_agent::{AgentInfo, AgentSpec, CalendarSpec, label_for};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, process::Command};
#[derive(Deserialize, Serialize)]
struct Record { id: String, label: String, path: String, exe: String }
/// Keep scheduler ownership records in the application user directory.
fn root() -> PathBuf { crate::platform::home_dir().join(".octopuses/background") }
/// Read the scheduler registry without hiding corruption or I/O failures.
fn read() -> Result<Vec<Record>, String> {
    match fs::read(root().join("registry.json")) { Ok(v) => serde_json::from_slice(&v).map_err(|e| e.to_string()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]), Err(e) => Err(e.to_string()) }
}
/// Persist scheduler entries after successful system registration.
fn save(records: &[Record]) -> Result<(), String> { fs::create_dir_all(root()).map_err(|e| e.to_string())?; fs::write(root().join("registry.json"), serde_json::to_vec_pretty(records).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }
/// Invoke the platform scheduler without a command shell.
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(program); command.args(args); crate::platform::hide_console(&mut command);
    let out = command.output().map_err(|e| format!("无法启动 {program}：{e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().into()) }
}
/// Escape dynamic values before embedding them in Task Scheduler XML.
fn xml(value: &str) -> String { value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;") }
/// Quote executable arguments and escape systemd expansion syntax.
fn systemd_arg(value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r']) { return Err("定时任务参数不能包含换行".into()); }
    Ok(format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%").replace('$', "$$")))
}
/// Reject calendar values outside platform-independent ranges.
fn validate_calendar(c: &CalendarSpec) -> Result<(), String> {
    if c.minute.is_some_and(|v| v > 59) || c.hour.is_some_and(|v| v > 23) || c.weekday.is_some_and(|v| v > 6) || c.day.is_some_and(|v| !(1..=31).contains(&v)) { return Err("定时日历字段无效".into()); } Ok(())
}
/// Translate interval or calendar schedules to a per-user systemd timer.
fn timer(spec: &AgentSpec) -> Result<String, String> {
    let trigger = if let Some(interval) = spec.interval_seconds { format!("OnStartupSec=60s\nOnUnitActiveSec={}s", interval.max(60)) }
    else if let Some(c) = &spec.calendar {
        validate_calendar(c)?;
        let field = |v: Option<u32>| v.map(|v| format!("{v:02}")).unwrap_or_else(|| "*".into());
        let weekday = c.weekday.map(|v| ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][v as usize].to_string() + " ").unwrap_or_default();
        format!("OnCalendar={weekday}*-*-{} {}:{}:00", field(c.day), field(c.hour), field(c.minute))
    } else { return Err("缺少定时规则".into()); };
    Ok(format!("[Unit]\nDescription=octopuses scheduled task\n[Timer]\n{trigger}\nPersistent=true\n[Install]\nWantedBy=timers.target\n"))
}
/// Generate a least-privilege interactive-user Task Scheduler definition.
fn windows_xml(exe: &str, spec: &AgentSpec) -> Result<String, String> {
    let trigger = if let Some(seconds) = spec.interval_seconds {
        if seconds > 2678400 { return Err("Windows 重复间隔不能超过 31 天".into()); }
        format!("<TimeTrigger><Repetition><Interval>PT{}S</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>", seconds.max(60))
    } else if let Some(c) = &spec.calendar {
        validate_calendar(c)?; if c.weekday.is_some() && c.day.is_some() { return Err("Windows 定时器暂不支持同时限制星期和月内日期".into()); }
        let repeat = if c.hour.is_none() && c.minute.is_none() { "<Repetition><Interval>PT1M</Interval><Duration>PT23H59M</Duration></Repetition>" } else if c.hour.is_none() { "<Repetition><Interval>PT1H</Interval><Duration>PT23H59M</Duration></Repetition>" } else if c.minute.is_none() { "<Repetition><Interval>PT1M</Interval><Duration>PT59M</Duration></Repetition>" } else { "" };
        let schedule = if let Some(day) = c.weekday { format!("<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><{}/></DaysOfWeek></ScheduleByWeek>", ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day as usize]) }
        else if let Some(day) = c.day { format!("<ScheduleByMonth><DaysOfMonth><Day>{day}</Day></DaysOfMonth><Months><January/><February/><March/><April/><May/><June/><July/><August/><September/><October/><November/><December/></Months></ScheduleByMonth>") }
        else { "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>".into() };
        format!("<CalendarTrigger>{repeat}<StartBoundary>2020-01-01T{:02}:{:02}:00</StartBoundary><Enabled>true</Enabled>{schedule}</CalendarTrigger>", c.hour.unwrap_or(0), c.minute.unwrap_or(0))
    } else { return Err("缺少定时规则".into()); };
    Ok(format!(r#"<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers>{trigger}</Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>{}</Command><Arguments>--automation-run {}</Arguments></Exec></Actions></Task>"#, xml(exe), xml(&format!("\"{}\"", spec.id.replace('"', "\\\"")))))
}
/// Install only application-owned tasks and record their exact locations.
pub fn install(specs: Vec<AgentSpec>) -> Result<Vec<AgentInfo>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned(); let mut records = read()?;
    for spec in specs {
        if spec.interval_seconds.is_none() && spec.calendar.is_none() { continue; }
        if spec.id.len() > 100 || !spec.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') { return Err("任务 ID 无效".into()); }
        let label = label_for(&spec.id);
        let path = if cfg!(windows) {
            let xml = windows_xml(&exe, &spec)?; fs::create_dir_all(root()).map_err(|e| e.to_string())?;
            let path = root().join(format!("{label}.xml")); let bytes = [vec![0xff, 0xfe], xml.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat();
            fs::write(&path, bytes).map_err(|e| e.to_string())?;
            run("schtasks", &["/Create", "/TN", &label, "/XML", &path.to_string_lossy(), "/F"])?; path
        } else {
            let dir = crate::platform::home_dir().join(".config/systemd/user"); fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(format!("{label}.timer"));
            let service = format!("[Unit]\nDescription=octopuses scheduled task\n[Service]\nType=oneshot\nExecStart={} --automation-run {}\n", systemd_arg(&exe)?, systemd_arg(&spec.id)?);
            fs::write(dir.join(format!("{label}.service")), service).map_err(|e| e.to_string())?;
            fs::write(&path, timer(&spec)?).map_err(|e| e.to_string())?;
            run("systemctl", &["--user", "daemon-reload"])?; run("systemctl", &["--user", "enable", "--now", &format!("{label}.timer")])?; path
        };
        records.retain(|r| r.id != spec.id); records.push(Record { id: spec.id, label, path: path.to_string_lossy().into(), exe: exe.clone() }); save(&records)?;
    }
    status()
}
/// Remove a registered task only after checking its ownership label.
pub fn uninstall(id: &str) -> Result<(), String> {
    let mut records = read()?; let Some(record) = records.iter().find(|r| r.id == id) else { return Ok(()); };
    if record.label != label_for(id) { return Err("定时项所有权无效".into()); }
    if cfg!(windows) { run("schtasks", &["/Delete", "/TN", &record.label, "/F"])?; }
    else { run("systemctl", &["--user", "disable", "--now", &format!("{}.timer", record.label)])?; }
    let path = Path::new(&record.path);
    if cfg!(windows) && path.parent() == Some(root().as_path()) { let _ = fs::remove_file(path); }
    if cfg!(target_os = "linux") && path.parent() == Some(crate::platform::home_dir().join(".config/systemd/user").as_path()) { let _ = fs::remove_file(path); let _ = fs::remove_file(path.with_extension("service")); let _ = run("systemctl", &["--user", "daemon-reload"]); }
    records.retain(|r| r.id != id); save(&records)
}
/// Expose installed task identifiers without accessing unrelated scheduler entries.
pub fn status() -> Result<Vec<AgentInfo>, String> { Ok(read()?.into_iter().map(|r| AgentInfo { task_id: r.id, label: r.label, path: r.path }).collect()) }
/// Remove app-owned entries whose automation no longer exists.
pub fn prune(active: &[String]) -> Result<Vec<String>, String> { let mut removed = vec![]; for r in read()? { if !active.contains(&r.id) { uninstall(&r.id)?; removed.push(r.id); } } Ok(removed) }
/// Clean registrations pointing at an obsolete application executable.
pub fn prune_stale() { if let Ok(exe) = std::env::current_exe() { if let Ok(records) = read() { for r in records { if Path::new(&r.exe) != exe { let _ = uninstall(&r.id); } } } } }
#[cfg(test)] mod tests {
    use super::*;
    fn spec() -> AgentSpec { AgentSpec { id: "task-1".into(), interval_seconds: Some(300), calendar: None } }
    #[test] fn timer_and_windows_tasks_preserve_boundaries() { let s = spec(); assert!(timer(&s).unwrap().contains("OnUnitActiveSec=300s")); let xml = windows_xml("C:\\A&B\\app.exe", &s).unwrap(); assert!(xml.contains("A&amp;B")); assert!(xml.contains("PT300S")); assert!(xml.contains("LeastPrivilege")); assert_eq!(systemd_arg("/a/%x/$y").unwrap(), "\"/a/%%x/$$y\""); }
    #[test] fn reject_bad_calendar_and_newlines() { assert!(systemd_arg("bad\nExecStart=evil").is_err()); assert!(validate_calendar(&CalendarSpec { minute: Some(60), hour: None, weekday: None, day: None }).is_err()); }
}
