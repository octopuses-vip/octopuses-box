//! 统一 diff 的生成与行数统计。
//!
//! 审批预览、工具结果与循环统计都依赖同一套 diff 输出，集中在此保证口径一致。

use similar::{ChangeTag, TextDiff};

/// diff 文本的默认上限（字节）。超出部分会被截断，避免把上下文窗口撑爆。
pub const DEFAULT_MAX_DIFF_BYTES: usize = 16 * 1024;

/// 统计新旧文本之间的新增、删除行数。
pub fn counts(old: &str, new: &str) -> (u64, u64) {
    let diff = TextDiff::from_lines(old, new);
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }
    (additions, deletions)
}

/// 生成针对单个路径的统一 diff（`a/<path>` → `b/<path>`），并按 `max_bytes` 截断。
pub fn unified_for_path(old: &str, new: &str, path: &str, max_bytes: usize) -> String {
    let diff = TextDiff::from_lines(old, new);
    let text = diff
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string();
    truncate(&text, max_bytes)
}

/// 按字节截断文本，且不破坏 UTF-8 字符边界。
fn truncate(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = text[..end].to_string();
    out.push_str("\n…（diff 过长，已截断）\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 统计新增与删除行数() {
        let (additions, deletions) = counts("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(additions, 1);
        assert_eq!(deletions, 1);
    }

    #[test]
    fn 新建文件全部计为新增() {
        let (additions, deletions) = counts("", "x\ny\n");
        assert_eq!(additions, 2);
        assert_eq!(deletions, 0);
    }

    #[test]
    fn 生成的标准diff带有文件头与hunk() {
        let text = unified_for_path("a\n", "a\nb\n", "src/main.rs", DEFAULT_MAX_DIFF_BYTES);
        assert!(text.contains("--- a/src/main.rs"));
        assert!(text.contains("+++ b/src/main.rs"));
        assert!(text.contains("@@"));
        assert!(text.contains("+b"));
    }

    #[test]
    fn 超长diff会被截断() {
        let old = String::new();
        let new = "中".repeat(10_000);
        let text = unified_for_path(&old, &new, "big.txt", 256);
        assert!(text.ends_with("已截断）\n"));
        assert!(text.len() < 400);
    }
}
