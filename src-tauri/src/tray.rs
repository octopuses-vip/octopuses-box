//! 系统托盘：把「关闭窗口」改写成「隐藏到托盘」，应用继续驻留后台。
//!
//! 客户端带自动化调度，关掉窗口不应该让定时任务停摆，因此这里拦截关窗请求改为隐藏窗口，
//! 并在托盘区常驻一个图标作为恢复入口：左键单击恢复主界面，右键菜单提供
//! 「显示主界面 / 检查更新 / 退出」。真正的退出只从托盘菜单走，避免关闭窗口时中断会话和自动化。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};

/// 主窗口的 label，与 `tauri.conf.json` 中窗口配置的默认 label 一致。
///
/// 需要按 label 取窗口的地方（如启动追踪）统一引用这里，避免同一个字面量散落多处。
pub(crate) const MAIN_WINDOW: &str = "main";
/// 托盘图标 id：重新创建时按 id 覆盖，避免出现多个托盘图标
const TRAY_ID: &str = "octopuses-tray";
/// 托盘菜单项 id：恢复并聚焦主界面
const MENU_SHOW: &str = "tray-show";
/// 托盘菜单项 id：手动检查客户端更新
const MENU_CHECK_UPDATE: &str = "tray-check-update";
/// 托盘菜单项 id：退出应用
const MENU_QUIT: &str = "tray-quit";
/// 推给前端的事件名：托盘菜单点了「检查更新」，由前端发起一次手动检查
const EVENT_CHECK_UPDATE: &str = "tray-check-update";

/// 取出主窗口并恢复到前台（开发者 Jan）
///
/// 窗口可能是被隐藏的、也可能处于最小化状态，两个状态各恢复一半都看不到窗口：
/// 先 `unminimize` 再 `show`，最后 `set_focus` 才能保证从托盘唤回时窗口真的出现在眼前。
pub(crate) fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 托盘菜单点了「检查更新」（开发者 Jan）
///
/// 先把主界面唤到前台，再通知前端发起一次手动检查。之所以必须在原生侧唤起窗口：
/// 菜单是从隐藏到托盘的状态下点的，检查结果（更新弹窗或「已是最新」提示）都画在窗口里，
/// 窗口不在前台用户就看不到任何反馈。窗口关闭只是隐藏、webview 并未销毁，事件一定有人接。
fn request_update_check<R: Runtime>(app: &AppHandle<R>) {
    restore_main_window(app);
    let _ = app.emit(EVENT_CHECK_UPDATE, ());
}

/// 创建常驻托盘图标与右键菜单（开发者 Jan）
fn install_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "显示主界面", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, MENU_CHECK_UPDATE, "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &check_update, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键单击直接恢复窗口，只有右键才展开菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => restore_main_window(app),
            MENU_CHECK_UPDATE => request_update_check(app),
            MENU_QUIT => {
                crate::trace::write("托盘菜单「退出」请求结束进程");
                app.exit(0)
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    // 复用打包进可执行文件的默认图标：托盘、任务栏与安装包三处保持同一张图
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 拦截关窗请求，改写成「隐藏到托盘」（开发者 Jan）
///
/// 只有阻止默认关闭行为才能让进程留在后台；窗口对象本身保留，因此会话与自动化调度
/// 都不会因为关窗被打断，从托盘唤回后界面状态与关闭前一致。
fn intercept_close<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
    });
}

/// 安装托盘与「关闭即隐藏」的窗口行为（开发者 Jan）
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    install_tray(app)?;
    intercept_close(app);
    Ok(())
}
