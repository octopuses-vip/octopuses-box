//! `apply_patch` 工具：应用统一 diff（unified diff）格式的补丁。
//!
//! 补丁解析与应用是完全自洽的实现：先解析出文件级补丁与 hunk，再按「精确上下文匹配」
//! 定位应用位置（允许在文件中搜索最近匹配，避免因行号漂移而失败），最后写回文件。

use async_trait::async_trait;
use ots_core::{
    Access, FileChange, FileChangeKind, RiskLevel, Tool, ToolContext, ToolError, ToolInvocation, ToolResult,
    ToolSpec,
};
use serde_json::json;

use crate::args;
use crate::diff;
use crate::paths;

/// 补丁中的一行。
#[derive(Debug, Clone, PartialEq, Eq)]
struct PatchLine {
    /// `' '` 上下文、`'-'` 删除、`'+'` 新增。
    kind: char,
    /// 行内容（不含前导标记，也不含换行符）。
    text: String,
}

/// 一个 hunk。
#[derive(Debug, Clone)]
struct Hunk {
    /// 旧文件中的起始行号（1 基；纯新增 hunk 为插入位置的前一行行号）。
    old_start: usize,
    /// hunk 内的全部行。
    lines: Vec<PatchLine>,
}

impl Hunk {
    /// 旧文件中被本 hunk 覆盖的行（上下文 + 删除）。
    fn old_lines(&self) -> Vec<&PatchLine> {
        self.lines.iter().filter(|line| line.kind != '+').collect()
    }

    /// 新文件中由本 hunk 产生的行（上下文 + 新增）。
    fn new_texts(&self) -> Vec<String> {
        self.lines.iter().filter(|line| line.kind != '-').map(|line| line.text.clone()).collect()
    }

    /// 旧行数。
    fn old_count(&self) -> usize {
        self.lines.iter().filter(|line| line.kind != '+').count()
    }

    /// 新行数。
    fn new_count(&self) -> usize {
        self.lines.iter().filter(|line| line.kind != '-').count()
    }
}

/// 单个文件的补丁。
#[derive(Debug, Clone)]
struct FilePatch {
    /// `---` 侧路径；`/dev/null` 表示新建。
    old_path: Option<String>,
    /// `+++` 侧路径；`/dev/null` 表示删除。
    new_path: Option<String>,
    /// 全部 hunk。
    hunks: Vec<Hunk>,
}

impl FilePatch {
    /// 补丁作用的目标路径（删除取旧路径，其余取新路径）。
    fn target(&self) -> Option<&String> {
        self.new_path.as_ref().or(self.old_path.as_ref())
    }
}

/// 应用统一 diff 补丁到工作区文件。
#[derive(Debug, Clone, Copy, Default)]
pub struct ApplyPatchTool;

impl ApplyPatchTool {
    /// 工具名。
    pub const NAME: &'static str = "apply_patch";
}

#[async_trait]
impl Tool for ApplyPatchTool {
    /// 工具声明（开发者 Jan）：说明里强调上下文行必须与文件现状一致，这是补丁能定位成功的前提
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            Self::NAME,
            "以统一 diff（unified diff）格式对工作区文件做精确修改，支持新建、修改与删除。\
             补丁需包含 `---`/`+++` 文件头与 `@@` hunk 头，上下文行必须与文件现有内容一致。\
             相比 write_file，它只改动补丁覆盖的范围，差异更小也更安全。",
            json!({
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "统一 diff 文本，例如：\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n keep"
                    }
                },
                "required": ["patch"],
                "additionalProperties": false
            }),
            RiskLevel::Medium,
            true,
        )
        .with_tags(["file", "patch", "write"])
    }

    /// 支持操作预览（开发者 Jan）：补丁在落盘前就能算出改动范围，适合先给用户看预览
    fn supports_preview(&self) -> bool {
        true
    }

    /// 解析并应用补丁（开发者 Jan）：解析失败或上下文不匹配都返回可读错误，由模型重新生成补丁
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let text = args::required_text(&invocation.arguments, "patch")?;
        let patches = parse_patch(&text)?;
        if patches.is_empty() {
            return Err(ToolError::Invalid("补丁中没有可应用的 `---`/`+++` 文件块".to_string()));
        }

        let mut changes: Vec<FileChange> = Vec::new();
        let mut summary: Vec<String> = Vec::new();

        for patch in &patches {
            let Some(target) = patch.target() else {
                return Err(ToolError::Invalid("补丁文件块缺少 `---` 与 `+++` 路径".to_string()));
            };
            if let (Some(old_path), Some(new_path)) = (&patch.old_path, &patch.new_path) {
                if old_path != new_path {
                    return Err(ToolError::Invalid(format!(
                        "不支持重命名补丁（`{old_path}` → `{new_path}`），请拆分为删除与新建两个补丁"
                    )));
                }
            }

            let access = if patch.new_path.is_none() { Access::Read } else { Access::Write };
            let path = paths::resolve(ctx, target, access)?;
            let shown = paths::display(&ctx.workspace, &path);
            let original = paths::read_text_if_exists(&path).await?.unwrap_or_default();

            let (kind, updated) = if patch.new_path.is_none() {
                apply_hunks(&original, &patch.hunks, &shown)?;
                (FileChangeKind::Delete, String::new())
            } else if patch.old_path.is_none() {
                (FileChangeKind::Create, apply_hunks("", &patch.hunks, &shown)?)
            } else {
                (FileChangeKind::Modify, apply_hunks(&original, &patch.hunks, &shown)?)
            };

            if !ctx.dry_run {
                match kind {
                    FileChangeKind::Delete => {
                        tokio::fs::remove_file(&path)
                            .await
                            .map_err(|err| ToolError::Failed(format!("删除 {shown} 失败: {err}")))?;
                    }
                    _ => {
                        if let Some(parent) = path.parent() {
                            tokio::fs::create_dir_all(parent).await.map_err(|err| {
                                ToolError::Failed(format!("创建目录 {} 失败: {err}", parent.display()))
                            })?;
                        }
                        tokio::fs::write(&path, updated.as_bytes())
                            .await
                            .map_err(|err| ToolError::Failed(format!("写入 {shown} 失败: {err}")))?;
                    }
                }
            }

            let change = paths::change(
                shown.clone(),
                kind,
                &original,
                &updated,
                diff::DEFAULT_MAX_DIFF_BYTES,
            );
            summary.push(format!(
                "  {} {} (+{} -{})",
                change.kind.marker(),
                change.path,
                change.additions,
                change.deletions
            ));
            changes.push(change);
        }

        let verb = if ctx.dry_run { "预览" } else { "已应用" };
        let mut message = format!("{verb}补丁：{} 个文件\n{}", changes.len(), summary.join("\n"));
        message.push('\n');
        Ok(ToolResult::success(message).with_data(paths::file_changes_data(&changes)))
    }
}

/// 解析统一 diff 文本。
///
/// # Errors
/// 格式非法时返回 [`ToolError::Invalid`]，并在信息中给出行号。
fn parse_patch(text: &str) -> Result<Vec<FilePatch>, ToolError> {
    let mut patches: Vec<FilePatch> = Vec::new();
    let mut current: Option<FilePatch> = None;
    let mut hunk: Option<Hunk> = None;

    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;

        if raw.starts_with("@@") {
            let Some(patch) = current.as_mut() else {
                return Err(ToolError::Invalid(format!("第 {line_no} 行的 `@@` 之前缺少 `---`/`+++` 文件头")));
            };
            if let Some(finished) = hunk.take() {
                patch.hunks.push(finished);
            }
            hunk = Some(Hunk { old_start: parse_hunk_header(raw, line_no)?, lines: Vec::new() });
            continue;
        }

        if let Some(pending) = hunk.as_mut() {
            if let Some(line) = parse_hunk_line(raw, line_no)? {
                pending.lines.push(line);
            }
            continue;
        }

        if let Some(rest) = raw.strip_prefix("--- ") {
            if let Some(finished) = current.take() {
                patches.push(finished);
            }
            current = Some(FilePatch { old_path: parse_patch_path(rest), new_path: None, hunks: Vec::new() });
            continue;
        }
        if let Some(rest) = raw.strip_prefix("+++ ") {
            let Some(patch) = current.as_mut() else {
                return Err(ToolError::Invalid(format!("第 {line_no} 行的 `+++` 之前缺少 `---` 行")));
            };
            patch.new_path = parse_patch_path(rest);
            continue;
        }
        // 其余行（如 `diff --git`、`index ...`）视为噪声忽略。
    }

    if let Some(patch) = current.as_mut() {
        if let Some(finished) = hunk.take() {
            patch.hunks.push(finished);
        }
        patches.push(current.take().expect("刚判断过存在"));
    }

    Ok(patches)
}

/// 解析 hunk 头 `@@ -旧起始[,行数] +新起始[,行数] @@`，返回旧文件起始行号。
fn parse_hunk_header(raw: &str, line_no: usize) -> Result<usize, ToolError> {
    let body = raw.trim_start_matches("@@").trim();
    let spec = body.split("@@").next().unwrap_or("").trim();
    let old = spec
        .split_whitespace()
        .next()
        .ok_or_else(|| ToolError::Invalid(format!("第 {line_no} 行的 hunk 头缺少旧文件范围")))?;
    let old = old
        .strip_prefix('-')
        .ok_or_else(|| ToolError::Invalid(format!("第 {line_no} 行的 hunk 头应以 `-起始行号` 开头")))?;
    old.split(',')
        .next()
        .unwrap_or("")
        .parse::<usize>()
        .map_err(|_| ToolError::Invalid(format!("第 {line_no} 行的 hunk 头行号非法: {raw}")))
}

/// 解析一行 hunk 内容；返回 `None` 表示该行需要忽略。
fn parse_hunk_line(raw: &str, line_no: usize) -> Result<Option<PatchLine>, ToolError> {
    let mut chars = raw.chars();
    match chars.next() {
        None => Ok(Some(PatchLine { kind: ' ', text: String::new() })),
        Some('\\') => Ok(None),
        Some(kind @ (' ' | '-' | '+')) => Ok(Some(PatchLine { kind, text: chars.as_str().to_string() })),
        Some(other) => Err(ToolError::Invalid(format!(
            "第 {line_no} 行的 hunk 内容必须以空格、`-` 或 `+` 开头，实际为 `{other}`"
        ))),
    }
}

/// 解析文件头路径，`/dev/null` 返回 `None`，并剥离 git 的 `a/`、`b/` 前缀。
fn parse_patch_path(raw: &str) -> Option<String> {
    let token = raw.split('\t').next().unwrap_or("").trim();
    if token.is_empty() || token == "/dev/null" {
        return None;
    }
    let stripped = token.strip_prefix("a/").or_else(|| token.strip_prefix("b/")).unwrap_or(token);
    Some(stripped.to_string())
}

/// 按顺序应用全部 hunk。
///
/// # Errors
/// 任一处上下文无法匹配时返回 [`ToolError::Failed`]，信息中包含文件路径与 hunk 序号。
fn apply_hunks(original: &str, hunks: &[Hunk], shown: &str) -> Result<String, ToolError> {
    let trailing_newline = original.is_empty() || original.ends_with('\n');
    let mut lines: Vec<String> = original.lines().map(str::to_string).collect();
    let mut offset: i64 = 0;

    for (index, hunk) in hunks.iter().enumerate() {
        let pattern = hunk.old_lines();
        let expected = if pattern.is_empty() {
            hunk.old_start as i64 + offset
        } else {
            hunk.old_start as i64 - 1 + offset
        }
        .max(0) as usize;

        let position = locate(&lines, &pattern, expected).ok_or_else(|| {
            let expected_first = pattern.first().map(|line| line.text.as_str()).unwrap_or("<空>");
            ToolError::Failed(format!(
                "{shown}: 第 {} 个 hunk 无法匹配上下文（期望首行 `{expected_first}`，起始行 {}）。\
                 请先 read_file 确认文件当前内容后重新生成补丁",
                index + 1,
                hunk.old_start
            ))
        })?;

        let replacement = hunk.new_texts();
        lines.splice(position..position + pattern.len(), replacement);
        offset += hunk.new_count() as i64 - hunk.old_count() as i64;
    }

    let mut out = lines.join("\n");
    if trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

/// 定位 hunk 上下文在文件中的落点：优先靠近期望位置，找不到时在全文件范围内搜索。
fn locate(lines: &[String], pattern: &[&PatchLine], expected: usize) -> Option<usize> {
    if pattern.is_empty() {
        return Some(expected.min(lines.len()));
    }
    let max_start = lines.len().checked_sub(pattern.len())?;
    let mut best: Option<usize> = None;
    for start in 0..=max_start {
        let mut matched = true;
        for (index, line) in pattern.iter().enumerate() {
            if lines[start + index] != line.text {
                matched = false;
                break;
            }
        }
        if !matched {
            continue;
        }
        match best {
            Some(current) if current.abs_diff(expected) <= start.abs_diff(expected) => {}
            _ => best = Some(start),
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::{ToolInvocation, ToolLimits, ToolRegistry, ToolRuntime};
    use tokio_util::sync::CancellationToken;

    fn runtime() -> ToolRuntime {
        let mut registry = ToolRegistry::new();
        registry.register(ApplyPatchTool).expect("注册成功");
        ToolRuntime::new(registry, ToolLimits::default())
    }

    fn context(dir: &std::path::Path) -> ToolContext {
        ToolContext::permissive(dir, CancellationToken::new())
    }

    #[tokio::test]
    async fn 修改文件片段() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").expect("写入");
        let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "apply_patch", json!({ "patch": patch })), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).expect("读回"), "one\nTWO\nthree\n");
        let changes = FileChange::list_from_tool_result(&result).expect("有变更清单");
        assert_eq!(changes[0].kind, FileChangeKind::Modify);
        assert_eq!((changes[0].additions, changes[0].deletions), (1, 1));
    }

    #[tokio::test]
    async fn 新建文件() {
        let dir = tempfile::tempdir().expect("临时目录");
        let patch = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n";
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "apply_patch", json!({ "patch": patch })), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(std::fs::read_to_string(dir.path().join("new.txt")).expect("读回"), "hello\nworld\n");
        let changes = FileChange::list_from_tool_result(&result).expect("有变更清单");
        assert_eq!(changes[0].kind, FileChangeKind::Create);
    }

    #[tokio::test]
    async fn 删除文件() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("gone.txt"), "a\nb\n").expect("写入");
        let patch = "--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "apply_patch", json!({ "patch": patch })), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert!(!dir.path().join("gone.txt").exists());
        let changes = FileChange::list_from_tool_result(&result).expect("有变更清单");
        assert_eq!(changes[0].kind, FileChangeKind::Delete);
    }

    #[tokio::test]
    async fn 上下文不匹配时报错且不修改文件() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").expect("写入");
        let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-xxx\n+yyy\n";
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "apply_patch", json!({ "patch": patch })), &ctx)
            .await;
        assert!(!result.ok);
        assert!(result.stderr.contains("无法匹配上下文"), "stderr={}", result.stderr);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).expect("读回"), "one\ntwo\n");
    }

    #[tokio::test]
    async fn 行号漂移时仍能按上下文定位() {
        let original = "head\none\ntwo\nthree\n";
        let patch = "--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@\n one\n-two\n+TWO\n three\n";
        let parsed = parse_patch(patch).expect("解析成功");
        let updated = apply_hunks(original, &parsed[0].hunks, "x").expect("应用成功");
        assert_eq!(updated, "head\none\nTWO\nthree\n");
    }

    #[tokio::test]
    async fn 预览模式不落盘() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("写入");
        let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n";
        let mut ctx = context(dir.path());
        ctx.dry_run = true;
        let result = runtime()
            .execute(ToolInvocation::new("1", "apply_patch", json!({ "patch": patch })), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).expect("读回"), "one\n");
    }

    #[test]
    fn 拒绝重命名补丁() {
        let patch = "--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        let parsed = parse_patch(patch).expect("解析成功");
        assert_eq!(parsed.len(), 1);
        assert_ne!(parsed[0].old_path, parsed[0].new_path);
    }

    #[test]
    fn 解析缺失文件头时报错() {
        let err = parse_patch("@@ -1,1 +1,1 @@\n-a\n+b\n").expect_err("应报错");
        assert!(err.to_string().contains("缺少"));
    }
}
