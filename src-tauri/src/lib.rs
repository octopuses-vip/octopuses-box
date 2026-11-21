mod agents;
mod audio;
mod audio_segments;
mod audio_source;
mod automation;
mod cache;
mod client_api;
mod control;
mod computer;
mod computer_cross;
mod browser_preview;
mod companion;
mod desktop_api;
mod desktop_api_history;
mod fileops;
mod frontmatter;
mod git;
mod git_handoff;
mod review;
mod json_store;
mod knowledge;
mod knowledge_db;
mod launch_agent;
mod background_cross;
mod mcp;
mod mcp_http;
mod office;
mod model_proxy;
mod video;
mod parallel;
mod platform;
mod pty;
mod sandbox;
mod sandbox_cross;
mod session_db;
mod shell;
mod skills;
mod ssh;
mod trace;
mod tray;
mod updater;
mod update_signature;
mod web;
mod workspace;

static SESSION_EXIT_LISTENING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static SESSION_EXIT_APPROVED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 session_exit_listening 的单一职责，并返回可供调用方继续处理的结果。
fn session_exit_listening(ready: bool) {
    SESSION_EXIT_LISTENING.store(ready, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
/// 函数级说明（开发者 Jan）：执行 session_exit_ready 的单一职责，并返回可供调用方继续处理的结果。
fn session_exit_ready(app: tauri::AppHandle) {
    SESSION_EXIT_APPROVED.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Tauri 应用入口（开发者 Jan）：注册托管状态、命令、插件与启动钩子。
///
/// 所有后端命令都必须在这里注册，漏注册的命令在运行时才会以「命令未找到」暴露，
/// 因此这里也是「后端对外提供哪些能力」的唯一清单。
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
        if launch_agent::wake_from_args(args.into_iter().skip(1)).is_none() {
            tray::restore_main_window(app);
        } else {
            trace::write("定时唤起遇到已运行客户端，由应用内调度器处理");
        }
    }));
    builder
        .manage(workspace::WorkspaceState::default())
        .manage(pty::PtyManager::default())
        .manage(control::CdpState::default())
        .manage(automation::AutomationSchedulerState::default())
        .manage(model_proxy::ModelProxyState::default())
        .manage(audio_segments::AudioSegmentsState::default())
        .manage(audio_source::AudioSourcesState::default())
        .manage(knowledge::KnowledgeState::default())
        .setup(|app| {
            use tauri::Manager;
            // 埋点：先记下启动现场，之后无论进程怎么消失，日志里都留有「它确实启动过」的证据
            trace::write(&describe_startup());
            let handle = app.handle().clone();
            match launch_agent::wake_task_id() {
                // 等前端恢复会话、计划和模型配置后主动领取，避免初始化时丢失事件。
                Some(task_id) => {
                    trace::write(&format!("启动参数指定待执行任务：{task_id}"));
                    automation::mark_wake(&handle, task_id);
                }
                // 正常启动：清掉指向旧可执行文件路径的残留定时项，随后由前端用当前路径重新注册
                None => launch_agent::prune_stale_agents(),
            }
            automation::start(handle);
            // 托盘图标与「关闭即隐藏」：关窗后进程继续驻留后台跑自动化
            tray::setup(app.handle())?;
            // 托盘与关窗拦截都已装好：若窗口在此之后仍然消失，原因就落在窗口本身
            trace::write(&format!(
                "setup 完成：主窗口存在={}",
                app.get_webview_window(tray::MAIN_WINDOW).is_some()
            ));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            browser_preview::browser_preview_open,
            companion::integration_paths,
            companion::prepare_container,
            companion::companion_start,
            companion::companion_request,
            companion::companion_retire_legacy,
            desktop_api::desktop_api_start,
            desktop_api::desktop_api_status,
            desktop_api::desktop_api_stop,
            desktop_api_history::desktop_api_history_list,
            desktop_api_history::desktop_api_history_read,
            session_exit_listening,
            session_exit_ready,
            knowledge::knowledge_model_status,
            knowledge::knowledge_model_asset,
            knowledge_db::knowledge_request,
            knowledge::knowledge_model_set_enabled,
            knowledge::knowledge_model_download,
            knowledge::knowledge_model_cancel,
            knowledge::knowledge_model_remove,
            cache::cache_default_dir,
            cache::cache_record_location,
            cache::cache_init,
            cache::cache_info,
            cache::cache_write,
            cache::cache_write_atomic,
            cache::cache_read_optional,
            cache::cache_append,
            cache::cache_read,
            cache::cache_clear,
            cache::artifact_write,
            cache::artifact_read,
            cache::artifact_write_bytes,
            cache::artifact_read_bytes,
            cache::artifact_list,
            cache::artifact_prepare_dir,
            cache::artifact_migrate_legacy,
            fileops::workspace_import_files,
            fileops::file_save_as,
            fileops::file_read_bytes,
            fileops::context_read_path,
            fileops::workspace_list_dir,
            session_db::session_db_ensure,
            session_db::session_db_import_legacy,
            session_db::session_db_load,
            session_db::session_db_list,
            session_db::session_db_get,
            session_db::session_db_save,
            session_db::session_db_delete,
            session_db::usage_record,
            session_db::usage_summary,
            client_api::client_default_endpoint,
            client_api::client_probe,
            client_api::client_login,
            client_api::client_models,
            client_api::client_check_update,
            model_proxy::model_stream,
            audio_segments::audio_prepare,
            audio_segments::audio_transcribe_segment,
            audio_segments::audio_release,
            audio_source::audio_inspect,
            audio_source::audio_attachment_import,
            audio_source::audio_stage_create,
            audio_source::audio_stage_append,
            audio_source::audio_stage_finish,
            audio_source::audio_stage_release,
            audio_source::audio_checkpoint_save,
            video::video_download,
            fileops::video_preview_path,
            session_db::video_jobs,
            session_db::video_save_job,
            model_proxy::model_abort,
            model_proxy::model_fetch,
            updater::update_download_and_install,
            updater::update_take_result,
            office::office_render,
            mcp::mcp_list_servers,
            mcp::mcp_save_server,
            mcp::mcp_delete_server,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            ssh::ssh_list_hosts,
            ssh::ssh_host_secret_status,
            ssh::ssh_save_host,
            ssh::ssh_delete_host,
            ssh::ssh_test_connection,
            ssh::ssh_exec,
            ssh::ssh_list_dir,
            ssh::ssh_read_file,
            ssh::ssh_write_file,
            parallel::parallel_list_batches,
            parallel::parallel_save_batch,
            parallel::parallel_delete_batch,
            control::control_open_in_browser,
            control::control_browser_script,
            control::control_computer_script,
            control::control_cdp_launch,
            control::control_cdp_targets,
            control::control_cdp_close,
            control::control_screenshot,
            control::control_computer_click,
            computer::computer_action,
            computer::computer_cancel,
            web::web_fetch,
            shell::run_shell,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_list,
            automation::automation_sync_tasks,
            automation::automation_release,
            automation::automation_take_wake,
            automation::automation_exit,
            launch_agent::launch_agent_install,
            launch_agent::launch_agent_uninstall,
            launch_agent::launch_agent_status,
            launch_agent::launch_agent_prune,
            git::git_repository_info,
            git::git_read_diff,
            git::git_list_worktrees,
            git_handoff::git_handoff,
            review::review_github,
            git::git_create_worktree,
            git::git_remove_worktree,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            skills::scan_skills,
            skills::read_skill,
            skills::create_skill,
            skills::update_skill,
            skills::delete_skill,
            skills::import_skill,
            agents::scan_agents,
            agents::create_agent,
            agents::update_agent,
            agents::delete_agent,
            workspace::workspace_read_file,
            workspace::workspace_write_file,
            workspace::workspace_apply_patch,
            workspace::workspace_search_code,
            workspace::workspace_load_rules,
            workspace::workspace_classify_command,
            workspace::workspace_test_runner,
            workspace::workspace_rollback_checkpoint,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

/// 记录启动现场：进程号、可执行文件、工作目录与启动参数（开发者 Jan）。
///
/// 更新进程重新拉起客户端时，这几个值能直接说明「是哪一份安装被拉起来了」——
/// 更新地址若曾指向旧副本，这里会立刻暴露可执行文件不在预期位置。
fn describe_startup() -> String {
    let exe = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("<取不到：{error}>"));
    let cwd = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("<取不到：{error}>"));
    format!(
        "客户端启动 v{} pid={} exe={exe} cwd={cwd} args={:?}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        std::env::args().skip(1).collect::<Vec<_>>()
    )
}

/// 把退出请求携带的退出码翻译成人可读的出处（开发者 Jan）。
///
/// Tauri 只在「代码主动调用 `app.exit(n)`」时带上退出码，窗口全部关闭后的自然退出不带——
/// 于是这一行就能回答「是哪个环节把它关掉的」：有码说明是我们自己写的退出逻辑，
/// 无码说明是窗口先没了，得回头查窗口。
fn describe_exit_code(code: Option<i32>) -> String {
    match code {
        Some(value) => format!("{value}（代码主动退出）"),
        None => "无（窗口全部关闭后的自然退出）".to_string(),
    }
}

/// 记录运行期事件，用于解释「客户端为什么自己没了」（开发者 Jan）。
///
/// 「窗口被销毁」与「收到退出请求」是自行退出时最直接的证据：Tauri 在既没有存活窗口、
/// 也没有拦截退出请求时会干净地结束进程（退出码 0），正是此前观测到的现象。
/// 这里只记录不干预，避免诊断手段改变原有的退出行为。
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use tauri::{Emitter, Manager, RunEvent, WindowEvent};
    match event {
        RunEvent::Ready => trace::write("应用就绪 Ready"),
        RunEvent::WindowEvent { label, event, .. } => match event {
            WindowEvent::CloseRequested { .. } => {
                trace::write(&format!("窗口[{label}]收到关闭请求，已拦截为隐藏"));
            }
            WindowEvent::Destroyed => {
                trace::write(&format!(
                    "窗口[{label}]已销毁：没有存活窗口时进程会随之退出"
                ));
            }
            WindowEvent::Focused(focused) => {
                trace::write(&format!("窗口[{label}]焦点变化={focused}"));
            }
            _ => {}
        },
        // 退出码是区分「谁发起的退出」的唯一凭据：Some 说明代码里主动调用了
        // app.exit(n)，None 说明只是窗口全部关闭后的自然收敛，两者排查方向完全不同
        RunEvent::ExitRequested { code, api, .. } => {
            trace::write(&format!(
                "收到退出请求 ExitRequested code={}",
                describe_exit_code(code)
            ));
            if SESSION_EXIT_LISTENING.load(std::sync::atomic::Ordering::SeqCst)
                && !SESSION_EXIT_APPROVED.load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
                let _ = app.emit("session-exit-requested", ());
            }
        }
        RunEvent::Exit => {
            companion::stop_children();
            trace::write("进程退出 Exit");
        }
        _ => {}
    }
}
