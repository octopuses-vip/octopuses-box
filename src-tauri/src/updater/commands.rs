use tauri::AppHandle;

use crate::client_api::ApiError;
use crate::trace;
use super::download::*;
use super::install::*;

/// 下载安装包并交由独立进程完成更新。
///
/// 成功后本进程会随即退出（安装程序需要替换正在使用的可执行文件），因此调用方拿到
/// `Ok` 后不会再有后续交互；任何失败都保持客户端可用，由界面提示并可重试。
/// 安装过程与结论都由更新进程负责，客户端下次启动时经 [`update_take_result`] 读回。
#[tauri::command]
pub async fn update_download_and_install(
    app: AppHandle,
    download_url: String,
    expected_size: i64,
) -> Result<(), ApiError> {
    if !cfg!(windows) {
        return Err(download_error(
            "当前系统暂不支持应用内更新，请在浏览器中打开下载地址。".to_string(),
        ));
    }
    // 开发模式下当前可执行文件是 target 目录里的调试产物，不会被安装包替换，还需要开发服务器在场，
    // 装上也无法重启回新版本。这里明确拒绝，避免用户点了更新、客户端退出后再也回不来。
    if cfg!(debug_assertions) {
        return Err(download_error(
            "开发模式下不支持应用内更新，请用打包后的安装包验证。".to_string(),
        ));
    }
    // 署名：安装包下载是「用户点了立即更新」才会发生的事，日志里没这一行却被拉起又退出，
    // 就说明客户端不是被更新流程带走的，排查方向要立刻换到窗口与退出请求那边
    trace::write(&format!("收到前端更新安装请求：开始下载 {download_url}"));
    let installer = download_package(&app, &download_url, expected_size).await?;
    // 更新源可能指向客户端本体（裸 octopuses.exe）而不是安装包，必须在这里拦下：
    // 脚本会把裸本体当安装程序执行 `octopuses.exe /S -Wait`，而客户端不认识 `/S`，
    // 会作为普通程序启动且永不退出，脚本便永久阻塞在等待里，用户看到的就是「点了更新，客户端再没回来」
    ensure_installer(&installer)?;
    // 上一次更新可能失败并被用户忽略：先清掉旧结论，免得下次启动读到过期提示
    clear_previous_result();
    // 客户端启动/退出的追踪日志由更新脚本在「旧实例已退出」之后再清空：
    // 若在这里就清，旧实例随后写入的 ExitRequested/Exit 会先留下两行，
    // 新实例的「客户端启动」会被夹在中间，读日志时容易把旧实例的退出当成新实例的故障
    launch_updater(&installer)?;
    trace::write("应用内更新流程请求退出：安装包已交给更新进程");
    app.exit(0);
    Ok(())
}

/// 读取上一次更新留下的结论并清除，没有结论时返回 `None`。
///
/// 客户端退出后已无进程持有更新结果，因此这里读取即删除：一条结论只在紧随其后的那次启动里提示一次。
#[tauri::command]
pub fn update_take_result() -> Option<UpdateOutcome> {
    let directory = temp_dir();
    let path = directory.join(RESULT_FILE_NAME);
    let raw = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(interpret_result(raw.trim(), &directory.join(LOG_FILE_NAME)))
}
