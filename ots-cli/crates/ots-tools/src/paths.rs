//! 路径解析与文件变更描述的公共逻辑。
//!
//! 所有工具对路径的处理口径必须一致：相对路径以工作区为基准，绝对路径原样使用，
//! 但无一例外都要经过 [`ots_core::ExecGuard::resolve_path`] 的策略判定。

use std::path::{Path, PathBuf};

use ots_core::{Access, FileChange, FileChangeKind, ToolContext, ToolError};

use crate::diff;

/// 把参数中的路径锚定为绝对路径并交给守卫做策略校验。
///
/// # Errors
/// 路径为空返回 [`ToolError::Invalid`]；被策略拒绝返回 [`ToolError::Denied`]。
pub fn resolve(ctx: &ToolContext, raw: &str, access: Access) -> Result<PathBuf, ToolError> {
    if raw.trim().is_empty() {
        return Err(ToolError::Invalid("路径不能为空".to_string()));
    }
    let candidate = anchor(&ctx.workspace, Path::new(raw));
    Ok(ctx.guard.resolve_path(&candidate, access)?)
}

/// 相对路径以工作区为基准，绝对路径原样使用。
pub fn anchor(workspace: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    }
}

/// 渲染为相对工作区的展示路径；工作区之外的路径保持原样。
pub fn display(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// 读取文本文件，不存在时返回 `None`。
///
/// # Errors
/// 读取失败或内容不是 UTF-8 文本时返回 [`ToolError::Failed`]。
pub async fn read_text_if_exists(path: &Path) -> Result<Option<String>, ToolError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Ok(Some(text)),
            Err(_) => Err(ToolError::Failed(format!("{} 不是 UTF-8 文本文件，无法按文本处理", path.display()))),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(ToolError::Failed(format!("读取 {} 失败: {err}", path.display()))),
    }
}

/// 构造一条文件变更记录，自动计算增删行数与 diff。
pub fn change(
    display_path: String,
    kind: FileChangeKind,
    old: &str,
    new: &str,
    max_diff_bytes: usize,
) -> FileChange {
    let (additions, deletions) = diff::counts(old, new);
    let text = diff::unified_for_path(old, new, &display_path, max_diff_bytes);
    FileChange { path: display_path, kind, additions, deletions, diff: Some(text) }
}

/// 把文件变更列表序列化为工具结果约定结构 `{ "files": [...] }`。
///
/// 该结构由 [`ots_core::FileChange::list_from_tool_result`] 消费。
pub fn file_changes_data(changes: &[FileChange]) -> serde_json::Value {
    serde_json::json!({ "files": changes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 相对路径锚定到工作区() {
        let anchored = anchor(Path::new("/ws"), Path::new("src/main.rs"));
        assert_eq!(anchored, PathBuf::from("/ws/src/main.rs"));
    }

    #[test]
    fn 绝对路径保持原样() {
        let anchored = anchor(Path::new("/ws"), Path::new("/etc/hosts"));
        assert_eq!(anchored, PathBuf::from("/etc/hosts"));
    }

    #[test]
    fn 展示路径相对工作区() {
        assert_eq!(display(Path::new("/ws"), Path::new("/ws/a/b.rs")), "a/b.rs");
        assert_eq!(display(Path::new("/ws"), Path::new("/other/b.rs")), "/other/b.rs");
    }
}
