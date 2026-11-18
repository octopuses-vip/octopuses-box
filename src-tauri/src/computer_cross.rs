//! Structured Windows and Linux/X11 drivers; user-authored scripts are never executed.
use serde_json::{json, Value};
use std::{io::Write, path::Path, process::{Command, Stdio}};
/// Execute a fixed platform utility and preserve its failure diagnostics.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program); command.args(args); crate::platform::hide_console(&mut command);
    let output = command.output().map_err(|e| format!("需要安装 {program}：{e}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
/// Pass structured actions on stdin to the trusted Windows input adapter.
fn windows(data: Value) -> Result<(), String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", include_str!("../scripts/windows-computer.ps1")]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    crate::platform::hide_console(&mut command); let mut child = command.spawn().map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("stdin unavailable")?.write_all(data.to_string().as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).into()) }
}
/// Validate and dispatch input actions to the selected platform application.
pub fn perform(app: &str, action: &Value) -> Result<(), String> {
    if cfg!(windows) { return windows(json!({ "app": app, "action": action })); }
    if !cfg!(target_os = "linux") { return Err("此平台没有桌面驱动".into()); }
    if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") { return Err("Linux 输入驱动需要 X11 会话；Wayland 不允许 xdotool 全局输入".into()); }
    let ids = run("xdotool", &["search", "--onlyvisible", "--class", app])?;
    let window = ids.lines().next().filter(|v| v.chars().all(|c| c.is_ascii_digit())).ok_or("未找到目标应用窗口")?;
    run("xdotool", &["windowactivate", "--sync", window])?;
    if run("xdotool", &["getactivewindow"])? != window { return Err("目标应用未获得焦点".into()); }
    let kind = action["action"].as_str().ok_or("动作缺失")?;
    let (x, y) = if ["click", "double_click", "right_click", "drag", "scroll"].contains(&kind) {
        let size = run("xdotool", &["getdisplaygeometry"])?;
        let numbers = size.split_whitespace().filter_map(|v| v.parse::<f64>().ok()).collect::<Vec<_>>();
        if numbers.len() != 2 { return Err("无法读取屏幕尺寸".into()); }
        let x = (action["x"].as_f64().ok_or("x 缺失")? * (numbers[0] - 1.0)).round();
        let y = (action["y"].as_f64().ok_or("y 缺失")? * (numbers[1] - 1.0)).round();
        let geometry = run("xdotool", &["getwindowgeometry", "--shell", window])?;
        let field = |key: &str| geometry.lines().find_map(|line| line.strip_prefix(&format!("{key}=")).and_then(|s| s.parse::<f64>().ok())).ok_or("窗口尺寸无效");
        let left = field("X")?; let top = field("Y")?; let right = left + field("WIDTH")?; let bottom = top + field("HEIGHT")?;
        if x < left || y < top || x >= right || y >= bottom { return Err("坐标位于允许应用的窗口之外".into()); }
        if kind == "drag" {
            let tx = (action["toX"].as_f64().ok_or("toX 缺失")? * (numbers[0] - 1.0)).round();
            let ty = (action["toY"].as_f64().ok_or("toY 缺失")? * (numbers[1] - 1.0)).round();
            if tx < left || ty < top || tx >= right || ty >= bottom { return Err("拖拽终点位于允许窗口之外".into()); }
            return run("xdotool", &["mousemove", &x.to_string(), &y.to_string(), "mousedown", "1", "mousemove", "--sync", &tx.to_string(), &ty.to_string(), "mouseup", "1"]).map(|_| ());
        }
        run("xdotool", &["mousemove", &x.to_string(), &y.to_string()])?; (x, y)
    } else { (0.0, 0.0) };
    let _ = (x, y);
    match kind {
        "activate" => Ok(()),
        "click" => run("xdotool", &["click", "1"]).map(|_| ()),
        "double_click" => run("xdotool", &["click", "--repeat", "2", "--delay", "80", "1"]).map(|_| ()),
        "right_click" => run("xdotool", &["click", "3"]).map(|_| ()),
        "scroll" => { let amount = action["amount"].as_i64().ok_or("滚动量缺失")?; run("xdotool", &["click", "--repeat", &amount.unsigned_abs().to_string(), if amount > 0 { "4" } else { "5" }]).map(|_| ()) },
        "type" => run("xdotool", &["type", "--clearmodifiers", "--delay", "0", "--", action["text"].as_str().ok_or("文字缺失")?]).map(|_| ()),
        "key" => { let key = action["key"].as_str().ok_or("按键缺失")?; let key = match key { "Enter" => "Return".into(), "Backspace" => "BackSpace".into(), k if k.starts_with("Cmd+") => format!("ctrl+{}", k[4..].to_lowercase()), k => k.to_string() }; run("xdotool", &["key", "--clearmodifiers", &key]).map(|_| ()) },
        "wait" => { std::thread::sleep(std::time::Duration::from_millis(250)); Ok(()) },
        _ => Err("不支持的桌面动作".into()),
    }
}
/// Capture the platform screen into an application-owned image path.
pub fn capture() -> Result<Vec<u8>, String> {
    let folder = tempfile::tempdir().map_err(|e| e.to_string())?;
    let file = folder.path().join("screenshot.png");
    let path = file.to_str().ok_or("截图路径无效")?;
    if cfg!(windows) { windows(json!({ "action": { "action": "screenshot" }, "path": path }))?; }
    else if cfg!(target_os = "linux") {
        let exists = |name: &str| std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|p| p.join(name).is_file()));
        if exists("gnome-screenshot") { run("gnome-screenshot", &["-f", path])?; }
        else if exists("scrot") { run("scrot", &["-o", path])?; }
        else if exists("grim") { run("grim", &[path])?; }
        else { return Err("请安装 gnome-screenshot、scrot 或 grim，并授权屏幕访问".into()); }
    } else { return Err("截图驱动不可用".into()); }
    std::fs::read(Path::new(path)).map_err(|e| e.to_string())
}

/// Translate a pixel click to the cross-platform validated action format.
pub fn click(x: f64, y: f64, image_width: Option<u32>) -> Result<(), String> {
    let bytes = capture()?; let (width, height) = crate::control::png_size(&bytes)?;
    let image_width = image_width.unwrap_or(width); if image_width == 0 { return Err("截图宽度无效".into()); }
    let scale = width as f64 / image_width as f64;
    let nx = x * scale / width as f64; let ny = y * scale / height as f64;
    if !(0.0..=1.0).contains(&nx) || !(0.0..=1.0).contains(&ny) { return Err("坐标超出截图".into()); }
    let app = if cfg!(windows) { "__foreground__".to_string() } else {
        let id = run("xdotool", &["getactivewindow"])?;
        let class = run("xprop", &["-id", &id, "WM_CLASS"])?;
        class.rsplit('"').nth(1).ok_or("无法读取当前窗口 WM_CLASS")?.to_string()
    };
    perform(&app, &json!({ "action": "click", "x": nx, "y": ny }))
}
