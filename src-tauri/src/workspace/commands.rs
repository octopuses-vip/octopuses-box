//! Tauri 命令入口：参数验证、异步调度与文件操作编排。
use super::{
    checkpoint::{ensure_checkpoint, rollback_checkpoint, WorkspaceState},
    patch::{apply_hunks, parse_patch},
    paths::{canonical_workspace, display_path, resolve_path},
    policy::{classify_command, CommandDecision, CommandPolicyResult},
    rules::{load_rules, render_rules, RuleSet},
    search::search_dir,
    types::{RollbackResult, SearchMatch, WorkspacePatchResult, WorkspaceWriteResult},
};
use crate::sandbox::SandboxOptions;
use std::{fs, time::Duration};
use tauri::State;

const DEFAULT_READ_LINES: usize = 2000;
const DEFAULT_SEARCH_LIMIT: usize = 100;
const MAX_SEARCH_LIMIT: usize = 500;

/// 读取工作区内某个文本文件的一段（开发者 Jan），按行分页返回带元信息的 file 块。
///
/// 分页的意义在于：大文件一次塞进上下文会挤掉别的内容，因此默认只给
/// DEFAULT_READ_LINES 行，并在末尾附 next_offset 告诉模型如何续读。
/// offset 从 1 开始（与编辑器行号一致），空文件则返回 0-0 的占位行。
#[tauri::command]
pub async fn workspace_read_file(
    project_path: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, target) = resolve_path(&project_path, &path, false)?;
        let text = fs::read_to_string(&target)
            .map_err(|error| format!("读取 {} 失败：{error}", display_path(&root, &target)))?;
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let offset = offset.unwrap_or(1);
        if offset == 0 {
            return Err("offset 必须从 1 开始".to_string());
        }
        let limit = limit.unwrap_or(DEFAULT_READ_LINES);
        if limit == 0 {
            return Err("limit 必须大于 0".to_string());
        }
        let start = offset.saturating_sub(1).min(total);
        let end = start.saturating_add(limit).min(total);
        let body = lines[start..end].join("\n");
        let shown = display_path(&root, &target);
        let more = if end < total {
            format!(" next_offset=\"{}\"", end + 1)
        } else {
            String::new()
        };
        if total == 0 {
            Ok(format!(
                "<file path=\"{shown}\" lines=\"0-0\" total=\"0\">\n（空文件）\n</file>"
            ))
        } else {
            Ok(format!(
                "<file path=\"{shown}\" lines=\"{}-{}\" total=\"{total}\"{more}>\n{body}\n</file>",
                start + 1,
                end
            ))
        }
    })
    .await
    .map_err(|error| format!("读取文件失败：{error}"))?
}

/// 写入工作区内的文件（开发者 Jan），写前先登记检查点。
///
/// threadId / runId 为空时直接拒绝：没有运行标识就无从归属检查点，
/// 也就无法支持「一键撤销本轮修改」。写入前递归补建父目录，
/// 目标路径允许尚不存在（新建文件场景）。
#[tauri::command]
pub async fn workspace_write_file(
    state: State<'_, WorkspaceState>,
    cache_path: String,
    project_path: String,
    thread_id: String,
    run_id: String,
    path: String,
    content: String,
) -> Result<WorkspaceWriteResult, String> {
    if thread_id.trim().is_empty() || run_id.trim().is_empty() {
        return Err("threadId 与 runId 不能为空".to_string());
    }
    let state = state.inner();
    let (root, target) = resolve_path(&project_path, &path, true)?;
    let checkpoint_id = ensure_checkpoint(
        state,
        &cache_path,
        &project_path,
        thread_id.trim(),
        run_id.trim(),
        std::slice::from_ref(&target),
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建目录 {} 失败：{error}", parent.display()))?;
        }
        fs::write(&target, content.as_bytes())
            .map_err(|error| format!("写入 {} 失败：{error}", display_path(&root, &target)))?;
        Ok(WorkspaceWriteResult {
            path: display_path(&root, &target),
            bytes: content.len(),
            checkpoint_id,
        })
    })
    .await
    .map_err(|error| format!("写入文件失败：{error}"))?
}

/// 应用一份 unified diff 补丁（开发者 Jan）。
///
/// 先把全部文件块解析并试算完（含上下文匹配），全部成功后才统一落盘，
/// 避免出现「前几个文件已改、后面文件报错」的半成品状态。
/// 重命名补丁暂不支持（直接报错），删除型补丁（新路径为 /dev/null）走删除分支；
/// 与写入一样，落盘前先为所有涉及文件登记同一份检查点。
#[tauri::command]
pub async fn workspace_apply_patch(
    state: State<'_, WorkspaceState>,
    cache_path: String,
    project_path: String,
    thread_id: String,
    run_id: String,
    patch: String,
) -> Result<WorkspacePatchResult, String> {
    if thread_id.trim().is_empty() || run_id.trim().is_empty() {
        return Err("threadId 与 runId 不能为空".to_string());
    }
    let patches = parse_patch(&patch)?;
    if patches.is_empty() {
        return Err("补丁中没有可应用的文件块".to_string());
    }

    let mut prepared = Vec::new();
    for file_patch in patches {
        let target = file_patch
            .target()
            .ok_or_else(|| "补丁文件块缺少路径".to_string())?;
        if let (Some(old_path), Some(new_path)) = (&file_patch.old_path, &file_patch.new_path) {
            if old_path != new_path {
                return Err(format!("不支持重命名补丁（{old_path} → {new_path}）"));
            }
        }
        let (root, path) = resolve_path(&project_path, target, file_patch.new_path.is_some())?;
        let original = if path.exists() {
            fs::read_to_string(&path)
                .map_err(|error| format!("读取 {} 失败：{error}", display_path(&root, &path)))?
        } else {
            String::new()
        };
        let updated = apply_hunks(&original, &file_patch.hunks, target)?;
        prepared.push((root, path, file_patch.new_path.is_none(), updated));
    }

    let targets = prepared
        .iter()
        .map(|(_, path, _, _)| path.clone())
        .collect::<Vec<_>>();
    let checkpoint_id = ensure_checkpoint(
        state.inner(),
        &cache_path,
        &project_path,
        thread_id.trim(),
        run_id.trim(),
        &targets,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        for (root, path, delete, updated) in prepared {
            let shown = display_path(&root, &path);
            if delete {
                fs::remove_file(&path).map_err(|error| format!("删除 {shown} 失败：{error}"))?;
            } else {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("创建目录 {} 失败：{error}", parent.display()))?;
                }
                fs::write(&path, updated.as_bytes())
                    .map_err(|error| format!("写入 {shown} 失败：{error}"))?;
            }
            files.push(shown);
        }
        Ok(WorkspacePatchResult {
            files,
            checkpoint_id,
        })
    })
    .await
    .map_err(|error| format!("应用补丁失败：{error}"))?
}

/// 在工作区内全文搜索（开发者 Jan），返回命中文件、行号与该行内容。
///
/// 遍历时跳过软链与 IGNORED_DIRS（.git / node_modules / target 等）以避开依赖与产物目录；
/// 读不出文本的二进制文件直接略过。limit 被夹在 1..=MAX_SEARCH_LIMIT 之间，
/// 防止一次搜索把上下文撑爆。
#[tauri::command]
pub async fn workspace_search_code(
    project_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_workspace(&project_path)?;
        let query = query.trim();
        if query.is_empty() {
            return Err("搜索内容不能为空".to_string());
        }
        let limit = limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let mut matches = Vec::new();
        search_dir(&root, &root, query, limit, &mut matches)?;
        Ok(matches)
    })
    .await
    .map_err(|error| format!("搜索代码失败：{error}"))?
}

/// 只做命令分类、不执行（开发者 Jan）：供前端在执行前展示处置档位与理由。
#[tauri::command]
pub fn workspace_classify_command(command: String, trust_read_only: bool) -> CommandPolicyResult {
    classify_command(&command, trust_read_only)
}

/// 在工作区内执行验证命令（开发者 Jan），是模型 test_runner 工具的后端。
///
/// 执行前再判一次策略：Deny 直接拒绝；Ask 且未获用户批准同样拒绝——
/// 即使前端漏了审批，后端也不会放行需确认的命令。
/// 超时夹在 1..=1800 秒；沙箱以规范化后的项目根作为唯一可写白名单，
/// 开关关闭或沙箱不可用时自动退回普通执行。
#[tauri::command]
pub async fn workspace_test_runner(
    project_path: String,
    command: String,
    timeout_secs: Option<u64>,
    trust_read_only: bool,
    approved: bool,
    sandbox_enabled: Option<bool>,
    allow_network: Option<bool>,
) -> Result<crate::shell::ShellResult, String> {
    let policy = classify_command(&command, trust_read_only);
    match policy.decision {
        CommandDecision::Deny => return Err(policy.reason),
        CommandDecision::Ask if !approved => {
            return Err(format!("命令需要用户批准后才能执行：{}", policy.reason));
        }
        CommandDecision::Allow | CommandDecision::Ask => {}
    }
    let root = canonical_workspace(&project_path)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120).clamp(1, 1800));
    // 写入白名单以已解析的项目根为基准；开关关闭或沙箱不可用时自动退回原行为
    let options = SandboxOptions {
        enabled: sandbox_enabled.unwrap_or(true),
        allow_network: allow_network.unwrap_or(true),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::shell::run_sandboxed(&command, Some(&root), timeout, &root, options)
    })
    .await
    .map_err(|error| format!("执行验证命令失败：{error}"))?
}

/// 回滚到某个检查点（开发者 Jan）：把本轮改动过的文件恢复成检查点里的原样。
#[tauri::command]
pub async fn workspace_rollback_checkpoint(
    cache_path: String,
    project_path: String,
    checkpoint_id: String,
) -> Result<RollbackResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rollback_checkpoint(&cache_path, &project_path, &checkpoint_id)
    })
    .await
    .map_err(|error| format!("回滚检查点失败：{error}"))?
}

/// 加载项目规则（开发者 Jan）：target 传入本轮要改的文件路径，
/// 规则按目录层级由浅到深汇总，越靠近该文件的 AGENTS.md 优先级越高。
#[tauri::command]
pub async fn workspace_load_rules(
    project_path: String,
    target: Option<String>,
) -> Result<RuleSet, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_workspace(&project_path)?;
        let files = load_rules(&root, target.as_deref())?;
        let content = render_rules(&files);
        Ok(RuleSet { files, content })
    })
    .await
    .map_err(|error| format!("加载项目规则失败：{error}"))?
}
