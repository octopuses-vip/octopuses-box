//! 工作区路径边界与展示路径。
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// 把项目路径解析成规范化的绝对目录（开发者 Jan）。
///
/// 后续所有越界判断都以它返回的根为基准，因此这里必须走 `canonicalize` 把软链展开，
/// 否则「软链指向工作区外」这类路径会绕过边界校验。
pub(super) fn canonical_workspace(project_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(project_path)
        .map_err(|error| format!("项目目录不存在或无法访问：{project_path}（{error}）"))?;
    if !root.is_dir() {
        return Err(format!("项目路径不是目录：{}", root.display()));
    }
    Ok(root)
}

/// 拒绝带 `..` / 根前缀的相对路径（开发者 Jan）。
///
/// 相对路径会先与工作区根拼接再校验，拼接前先把这类成分挡掉，
/// 避免 `../../etc/passwd` 在拼接阶段就被解析到工作区之外。
pub(super) fn clean_relative(path: &Path) -> Result<(), String> {
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("拒绝工作区外路径：{}", path.display()));
        }
    }
    Ok(())
}

/// 把路径解析到工作区内（`pub(crate)`：`fileops` 的导入/另存为复用同一套校验）
pub(crate) fn resolve_path(
    project_path: &str,
    raw_path: &str,
    allow_missing: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_workspace(project_path)?;
    let raw = Path::new(raw_path.trim());
    if raw.as_os_str().is_empty() {
        return Err("文件路径不能为空".to_string());
    }

    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        clean_relative(raw)?;
        root.join(raw)
    };

    if candidate.exists() {
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("无法解析路径 {}：{error}", candidate.display()))?;
        if !canonical.starts_with(&root) {
            return Err(format!("拒绝工作区外路径：{}", candidate.display()));
        }
        return Ok((root, canonical));
    }
    if !allow_missing {
        return Err(format!("文件不存在：{}", candidate.display()));
    }

    let mut ancestor = candidate.parent();
    while let Some(path) = ancestor {
        if path.exists() {
            let canonical = fs::canonicalize(path)
                .map_err(|error| format!("无法解析父目录 {}：{error}", path.display()))?;
            if !canonical.starts_with(&root) {
                return Err(format!("拒绝工作区外路径：{}", candidate.display()));
            }
            let suffix = candidate
                .strip_prefix(path)
                .map_err(|_| format!("无法解析缺失路径：{}", candidate.display()))?;
            let resolved = canonical.join(suffix);
            if !resolved.starts_with(&root) {
                return Err(format!("拒绝工作区外路径：{}", candidate.display()));
            }
            return Ok((root, resolved));
        }
        ancestor = path.parent();
    }
    Err(format!("无法解析路径父目录：{}", candidate.display()))
}

/// 展示用路径：相对工作区、统一正斜杠（`pub(crate)`：`fileops` 沿用它回传导入结果）
pub(crate) fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
