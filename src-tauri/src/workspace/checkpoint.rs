//! 一轮运行的修改前快照与回滚。
use super::{
    paths::{canonical_workspace, display_path, resolve_path},
    types::RollbackResult,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const CHECKPOINT_DIR: &str = "snapshots/checkpoints";
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct WorkspaceState {
    run_checkpoints: Mutex<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointFile {
    path: String,
    existed: bool,
    bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    id: String,
    thread_id: String,
    run_id: String,
    project_path: String,
    created_at: u64,
    files: Vec<CheckpointFile>,
}

/// 一次运行的检查点键（开发者 Jan）。
///
/// 同一会话的同一轮运行共用一份检查点，从而保证一轮里多次写文件只回滚到
/// 「本轮开始前」的状态，而不是上一次写入前的状态。
fn run_key(thread_id: &str, run_id: &str) -> String {
    format!("{thread_id}:{run_id}")
}

/// 计算检查点文件在缓存目录中的落盘路径（开发者 Jan）。
///
/// id 会拼进文件名，因此只允许 ASCII 字母数字与 `-`，其余一律拒绝；
/// 缓存根同样先规范化，确保检查点始终落在缓存目录内。
fn checkpoint_path(cache_path: &str, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return Err("检查点 ID 不合法".to_string());
    }
    let root = fs::canonicalize(cache_path)
        .map_err(|error| format!("缓存目录不存在或无法访问：{cache_path}（{error}）"))?;
    if !root.is_dir() {
        return Err(format!("缓存路径不是目录：{}", root.display()));
    }
    Ok(root.join(CHECKPOINT_DIR).join(format!("{id}.json")))
}

/// 把一份检查点写成 JSON（开发者 Jan）；目录不存在时先补建。
fn save_checkpoint(cache_path: &str, checkpoint: &Checkpoint) -> Result<(), String> {
    let path = checkpoint_path(cache_path, &checkpoint.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建检查点目录失败：{error}"))?;
    }
    let bytes =
        serde_json::to_vec(checkpoint).map_err(|error| format!("序列化检查点失败：{error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("写入检查点 {} 失败：{error}", path.display()))
}

/// 读回一份检查点（开发者 Jan）：读取或反序列化失败都当作错误上报，不做静默兜底。
fn load_checkpoint(cache_path: &str, id: &str) -> Result<Checkpoint, String> {
    let path = checkpoint_path(cache_path, id)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("读取检查点 {} 失败：{error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析检查点失败：{error}"))
}

/// 取（必要时新建）本轮运行的检查点，并把待改动文件的原内容登记进去（开发者 Jan）。
///
/// 这是「一键撤销本轮修改」的写入口：同一 `(threadId, runId)` 只建一份检查点，
/// 首次写入前抓取原内容；同一轮里重复写同一文件不再重复登记（`files` 里已存在即跳过），
/// 因此回滚的是**本轮开始前**的状态。
///
/// 尚不存在的路径也会登记（`existed = false`），回滚时据此删除本轮新建的文件。
/// 返回检查点 id，随写入结果一起回给前端供撤销按钮使用。
pub(super) fn ensure_checkpoint(
    state: &WorkspaceState,
    cache_path: &str,
    project_path: &str,
    thread_id: &str,
    run_id: &str,
    targets: &[PathBuf],
) -> Result<String, String> {
    let root = canonical_workspace(project_path)?;
    let key = run_key(thread_id, run_id);
    let mut runs = state
        .run_checkpoints
        .lock()
        .map_err(|_| "检查点状态锁已损坏".to_string())?;
    let id = runs.get(&key).cloned().unwrap_or_else(|| {
        format!(
            "cp-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    let mut checkpoint = if runs.contains_key(&key) {
        load_checkpoint(cache_path, &id)?
    } else {
        Checkpoint {
            id: id.clone(),
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            project_path: root.to_string_lossy().to_string(),
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            files: Vec::new(),
        }
    };
    for target in targets {
        let shown = display_path(&root, target);
        if checkpoint.files.iter().any(|file| file.path == shown) {
            continue;
        }
        let existed = target.exists();
        let bytes = if existed {
            fs::read(target).map_err(|error| format!("读取检查点文件 {shown} 失败：{error}"))?
        } else {
            Vec::new()
        };
        checkpoint.files.push(CheckpointFile {
            path: shown,
            existed,
            bytes,
        });
    }
    save_checkpoint(cache_path, &checkpoint)?;
    runs.insert(key, id.clone());
    Ok(id)
}

/// 检查点回滚的实际实现（开发者 Jan）。
///
/// 先校验检查点确实属于当前项目（比对规范化后的项目根），防止把 A 项目的快照
/// 回滚进 B 项目；随后逐文件处理：原本存在的写回原字节，原本不存在的删除。
/// 删除前额外确认目标是普通文件，遇到软链或目录一律拒绝，避免被诱导删掉工作区外的内容。
pub(super) fn rollback_checkpoint(
    cache_path: &str,
    project_path: &str,
    checkpoint_id: &str,
) -> Result<RollbackResult, String> {
    let root = canonical_workspace(project_path)?;
    let checkpoint = load_checkpoint(cache_path, checkpoint_id)?;
    let checkpoint_root = fs::canonicalize(&checkpoint.project_path).map_err(|error| {
        format!(
            "检查点项目目录无法访问：{}（{error}）",
            checkpoint.project_path
        )
    })?;
    if checkpoint_root != root {
        return Err("检查点不属于当前项目".to_string());
    }

    let mut resolved = Vec::new();
    for file in &checkpoint.files {
        let (_, target) = resolve_path(project_path, &file.path, true)?;
        resolved.push((file, target));
    }

    let mut files = Vec::new();
    for (file, target) in resolved {
        if file.existed {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建回滚目录 {} 失败：{error}", parent.display()))?;
            }
            fs::write(&target, &file.bytes)
                .map_err(|error| format!("恢复 {} 失败：{error}", file.path))?;
        } else if target.exists() {
            let metadata = fs::symlink_metadata(&target)
                .map_err(|error| format!("读取 {} 元数据失败：{error}", file.path))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!("拒绝删除非普通文件：{}", file.path));
            }
            fs::remove_file(&target)
                .map_err(|error| format!("删除 {} 失败：{error}", file.path))?;
        }
        files.push(file.path.clone());
    }
    Ok(RollbackResult {
        checkpoint_id: checkpoint.id,
        files,
    })
}
