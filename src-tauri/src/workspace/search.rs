//! 跳过软链与构建目录的文本搜索。
use super::{paths::display_path, types::SearchMatch};
use std::{fs, path::Path};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "coverage",
];

/// 递归搜索目录、把命中行累积进 matches（开发者 Jan）。
///
/// 达到 limit 即提前返回，避免在大仓库里白跑；软链一律跳过（防止绕出工作区或成环），
/// 目录名命中 IGNORED_DIRS 时整棵子树都不进（依赖与构建产物里搜出来的结果没有意义）。
pub(super) fn search_dir(
    root: &Path,
    dir: &Path,
    query: &str,
    limit: usize,
    matches: &mut Vec<SearchMatch>,
) -> Result<(), String> {
    if matches.len() >= limit {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|error| format!("读取目录 {} 失败：{error}", dir.display()))?;
    for entry in entries {
        if matches.len() >= limit {
            break;
        }
        let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取文件类型失败：{error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            if IGNORED_DIRS.iter().any(|ignored| name == *ignored) {
                continue;
            }
            search_dir(root, &path, query, limit, matches)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            if line.contains(query) {
                matches.push(SearchMatch {
                    path: display_path(root, &path),
                    line: index + 1,
                    text: line.trim().to_string(),
                });
                if matches.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(())
}
