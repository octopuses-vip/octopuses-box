//! 结构化桌面动作；不接收模型生成的程序，只允许有界的输入事件。
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
static CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);
#[tauri::command]
pub fn computer_cancel() { CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst); }
fn validate(app: &str, a: &Value) -> Result<(), String> {
    if app.is_empty() || app.len() > 200 || !app.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c)) { return Err("无效应用 bundle ID".into()); }
    let kind = a["action"].as_str().unwrap_or("");
    if !["activate","click","double_click","right_click","drag","scroll","type","key","wait"].contains(&kind) { return Err("未知动作".into()); }
    if ["click","double_click","right_click","drag","scroll"].contains(&kind) {
        for key in if kind == "drag" { vec!["x","y","toX","toY"] } else { vec!["x","y"] } {
            if !a[key].as_f64().is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v)) { return Err("坐标必须在 0–1 之间".into()); }
        }
    }
    if kind == "scroll" && !a["amount"].as_i64().is_some_and(|v| (-10..=10).contains(&v) && v != 0) { return Err("滚动量无效".into()); }
    if kind == "type" && !a["text"].as_str().is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 2000) { return Err("输入文字长度无效".into()); }
    if kind == "key" { key_code(a["key"].as_str().unwrap_or(""))?; }
    Ok(())
}
fn key_code(key: &str) -> Result<u16, String> { Ok(match key {
    "Enter"=>36,"Tab"=>48,"Escape"=>53,"Backspace"=>51,"Up"=>126,"Down"=>125,"Left"=>123,"Right"=>124,
    "Cmd+A"=>0,"Cmd+C"=>8,"Cmd+V"=>9,"Cmd+S"=>1,"Cmd+F"=>3,_=>return Err("不支持的快捷键".into())
}) }
#[tauri::command]
pub async fn computer_action(app: String, action: Value) -> Result<(), String> {
    validate(&app, &action)?;
    let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || execute(&app, &action, epoch)).await.map_err(|e| e.to_string())?
}
#[cfg(not(target_os = "macos"))]
fn execute(_: &str, _: &Value, _: u64) -> Result<(), String> { Err("电脑操作助手目前仅支持 macOS".into()) }
#[cfg(target_os = "macos")]
fn execute(app: &str, a: &Value, epoch: u64) -> Result<(), String> {
    if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch { return Err("电脑操作已停止".into()); }
    let result = crate::control::control_computer_script(format!("tell application id \"{app}\" to activate"))?;
    if !result.ok { return Err(result.output); }
    std::thread::sleep(std::time::Duration::from_millis(200));
    let focused = crate::control::control_computer_script("tell application \"System Events\" to get bundle identifier of first application process whose frontmost is true".into())?;
    if !focused.ok || focused.output.trim() != app { return Err("目标应用未获得焦点，已停止".into()); }
    let pid = crate::control::control_computer_script("tell application \"System Events\" to get unix id of first application process whose frontmost is true".into())?;
    let pid: i32 = pid.output.trim().parse().map_err(|_| "无法确认目标应用进程")?;
    if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch { return Err("电脑操作已停止".into()); }
    native::perform(a, pid)?;
    std::thread::sleep(std::time::Duration::from_millis(250)); Ok(())
}
#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::ffi::c_void;
    type Event = *mut c_void;
    #[repr(C)] #[derive(Clone,Copy)] struct Point { x:f64, y:f64 }
    #[repr(C)] struct Size { width:f64, height:f64 }
    #[repr(C)] struct Rect { origin:Point, size:Size }
    #[link(name="ApplicationServices",kind="framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateSystemWide() -> Event;
        fn AXUIElementCopyElementAtPosition(element: Event, x: f32, y: f32, result: *mut Event) -> i32;
        fn AXUIElementGetPid(element: Event, pid: *mut i32) -> i32;
    }
    #[link(name="CoreGraphics",kind="framework")]
    extern "C" {
        fn CGMainDisplayID()->u32;
        fn CGDisplayBounds(display:u32)->Rect;
        fn CGEventCreateMouseEvent(source:Event,kind:u32,point:Point,button:u32)->Event;
        fn CGEventCreateKeyboardEvent(source:Event,key:u16,down:bool)->Event;
        fn CGEventKeyboardSetUnicodeString(event:Event,length:usize,text:*const u16);
        fn CGEventSetFlags(event:Event,flags:u64);
        fn CGEventSetIntegerValueField(event:Event,field:u32,value:i64);
        fn CGEventCreateScrollWheelEvent(source:Event,units:u32,count:u32,wheel:i32,...)->Event;
        fn CGEventPost(tap:u32,event:Event);
    }
    #[link(name="CoreFoundation",kind="framework")]
    extern "C" { fn CFRelease(value:Event); }
    unsafe fn post(event:Event)->Result<(),String> {
        if event.is_null() { return Err("无法创建输入事件".into()); }
        CGEventPost(0,event); CFRelease(event); Ok(())
    }
    unsafe fn mouse(kind:u32,p:Point,button:u32,count:i64)->Result<(),String> {
        let e=CGEventCreateMouseEvent(std::ptr::null_mut(),kind,p,button);
        if e.is_null() { return Err("无法创建鼠标事件".into()); }
        CGEventSetIntegerValueField(e,1,count); post(e)
    }
    unsafe fn check_target(point: Point, expected: i32) -> Result<(), String> {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() { return Err("无法读取目标控件".into()); }
        let mut element = std::ptr::null_mut();
        let status = AXUIElementCopyElementAtPosition(system, point.x as f32, point.y as f32, &mut element);
        CFRelease(system);
        if status != 0 || element.is_null() { return Err("无法确认点击位置属于目标应用，已停止".into()); }
        let mut pid = 0; let status = AXUIElementGetPid(element, &mut pid); CFRelease(element);
        if status != 0 || pid != expected { return Err("点击位置不属于允许的目标应用，已停止".into()); }
        Ok(())
    }
    pub fn perform(a:&Value, pid:i32)->Result<(),String> { unsafe {
        // 激活与等待不产生任何输入事件，不需要辅助功能授权。
        // 把它们也拦在授权检查后面，会让「应用没打开」被误报成「没有权限点击」。
        if matches!(a["action"].as_str().unwrap_or(""), "activate" | "wait") { return Ok(()); }
        if !AXIsProcessTrusted() {
            // 授权已勾选却仍返回 false，通常是重建后的二进制与 TCC 里那条记录不再是同一个签名：
            // macOS 按签名比对，旧条目会保持「已勾选但无效」，必须删掉重加并重启进程才刷新。
            return Err("octopuses 未获得「辅助功能」授权，无法模拟点击或键盘输入。请到 系统设置 → 隐私与安全性 → 辅助功能：若 octopuses 已勾选仍报错，先用「−」删除所有 octopuses 条目，退出并重新打开 octopuses 后重新添加并勾选。".into());
        }
        let b=CGDisplayBounds(CGMainDisplayID());
        let p=|x:&str,y:&str| Point { x:b.origin.x+a[x].as_f64().unwrap_or(0.0)*(b.size.width-1.0), y:b.origin.y+a[y].as_f64().unwrap_or(0.0)*(b.size.height-1.0) };
        if ["click","double_click","right_click","drag","scroll"].contains(&a["action"].as_str().unwrap_or("")) { check_target(p("x","y"), pid)?; }
        if a["action"]=="drag" { check_target(p("toX","toY"), pid)?; }
        match a["action"].as_str().unwrap_or("") {
            "activate"|"wait"=>{},
            "click"|"double_click"|"right_click"=> {
                let right=a["action"]=="right_click";
                for count in 1..=if a["action"]=="double_click" {2} else {1} {
                    mouse(if right {3} else {1},p("x","y"),if right {1} else {0},count)?;
                    mouse(if right {4} else {2},p("x","y"),if right {1} else {0},count)?;
                }
            },
            "drag"=> {
                let from=p("x","y"); let to=p("toX","toY"); mouse(1,from,0,1)?;
                let result:Result<(),String>=(|| { for i in 1..=10 {
                    mouse(6,Point{x:from.x+(to.x-from.x)*i as f64/10.0,y:from.y+(to.y-from.y)*i as f64/10.0},0,1)?;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                } Ok(()) })();
                let release=mouse(2,to,0,1); result?; release?;
            },
            "scroll"=> { mouse(5,p("x","y"),0,0)?; post(CGEventCreateScrollWheelEvent(std::ptr::null_mut(),1,1,a["amount"].as_i64().unwrap() as i32))?; },
            "type"|"key"=> {
                let key=a["key"].as_str().unwrap_or("");
                let text:Vec<u16>=a["text"].as_str().unwrap_or("").encode_utf16().collect();
                let code=if a["action"]=="key" {key_code(key)?} else {0};
                for down in [true,false] {
                    let e=CGEventCreateKeyboardEvent(std::ptr::null_mut(),code,down);
                    if e.is_null() {return Err("无法创建键盘事件".into());}
                    if a["action"]=="type" {CGEventKeyboardSetUnicodeString(e,text.len(),text.as_ptr());}
                    if key.starts_with("Cmd+") {CGEventSetFlags(e,1<<20);} post(e)?;
                }
            },
            _=>return Err("未知动作".into()),
        } Ok(())
    } }
}
#[cfg(test)] mod tests {
    use super::*; use serde_json::json;
    #[test] fn rejects_invalid_actions_before_input() {
        for a in [json!({"action":"click","x":1.1,"y":0.5}),json!({"action":"scroll","amount":999}),json!({"action":"type","text":""}),json!({"action":"key","key":"shell"}),json!({"action":"script"})] {assert!(validate("com.apple.TextEdit",&a).is_err());}
        assert!(validate("bad\"id",&json!({"action":"activate"})).is_err());
        assert!(validate("com.apple.TextEdit",&json!({"action":"type","text":"中文🙂"})).is_ok());
    }
}
