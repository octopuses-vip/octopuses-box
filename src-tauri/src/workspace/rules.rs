//! 按目录层级收集 AGENTS.md，并限制注入长度。
use super::paths::{canonical_workspace, clean_relative, display_path};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// 项目规则文件名，沿用项目约定 `AGENTS.md`
pub(super) const RULES_FILE: &str = "AGENTS.md";
/// 单个规则文件的注入上限，避免超长规则挤占上下文
const MAX_RULES_BYTES: usize = 32_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFile {
    pub(super) path: String,
    pub(super) body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSet {
    pub(super) files: Vec<RuleFile>,
    pub(super) content: String,
}

/// 按字符边界截断字符串（开发者 Jan）。
///
/// 规则文件按字节数限长，直接切 `&text[..limit]` 可能落在多字节字符中间导致 panic，
/// 这里向前回退到最近的合法字符边界。
fn truncate_on_char_boundary(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// 读取单个目录下的 `AGENTS.md`（开发者 Jan），没有或读不出时返回 `None`。
///
/// 用 `symlink_metadata` + `canonicalize` 双重确认：只接受工作区内的普通文件，
/// 软链与目录一律跳过，避免把工作区外的内容当项目规则注入给模型。
/// 内容超过 [`MAX_RULES_BYTES`] 时截断并附说明，防止超长规则撑爆系统提示。
fn read_rules_file(root: &Path, dir: &Path) -> Option<RuleFile> {
    let candidate = dir.join(RULES_FILE);
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(&candidate).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let text = fs::read_to_string(&canonical).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let body = if text.len() > MAX_RULES_BYTES {
        format!(
            "{}\n…（规则过长，已截断）",
            truncate_on_char_boundary(&text, MAX_RULES_BYTES)
        )
    } else {
        text
    };
    Some(RuleFile {
        path: display_path(root, &canonical),
        body,
    })
}

/// 收集从工作区根到目标路径逐层的目录，越靠后的目录规则优先级越高。
fn collect_rule_dirs(root: &Path, target: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![root.to_path_buf()];
    let raw = match target.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => return Ok(dirs),
    };
    let raw_path = Path::new(raw);
    if raw_path.is_absolute() {
        return Err("规则目标必须是工作区内的相对路径".to_string());
    }
    clean_relative(raw_path)?;
    let mut current = root.to_path_buf();
    for component in raw_path.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        current = current.join(name);
        let Ok(canonical) = fs::canonicalize(&current) else {
            continue;
        };
        if !canonical.starts_with(root) {
            return Err(format!("拒绝工作区外路径：{}", current.display()));
        }
        if canonical.is_dir() {
            dirs.push(canonical);
        }
    }
    Ok(dirs)
}

/// 收集从工作区根到目标路径逐层的规则文件（开发者 Jan）。
///
/// 返回值按目录层级由浅到深排列，[`render_rules`] 依赖这个顺序把「越靠近目标、优先级越高」
/// 的约定讲清楚；根目录本身永远排在第一位。
pub(super) fn load_rules(root: &Path, target: Option<&str>) -> Result<Vec<RuleFile>, String> {
    let root = canonical_workspace(root.to_string_lossy().as_ref())?;
    let dirs = collect_rule_dirs(&root, target)?;
    Ok(dirs
        .iter()
        .filter_map(|dir| read_rules_file(&root, dir))
        .collect())
}

/// 把规则文件拼成注入模型的项目规则文本（开发者 Jan）。
///
/// 没有规则时返回空串，调用方据此完全不注入内容；有规则时先给一句优先级说明，
/// 再按 `<project-rules path="...">` 逐份列出，让模型知道每条规则出自哪个目录。
pub(super) fn render_rules(files: &[RuleFile]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut parts = vec![
        "下面是项目内生效的规则（AGENTS.md），越靠后的文件目录越接近当前目标，优先级更高，请优先遵守："
            .to_string(),
    ];
    for file in files {
        parts.push(format!(
            "<project-rules path=\"{}\">\n{}\n</project-rules>",
            file.path,
            file.body.trim_end()
        ));
    }
    parts.join("\n\n")
}
