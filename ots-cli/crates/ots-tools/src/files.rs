//! 文件读写工具：`read_file` 与 `write_file`。

use async_trait::async_trait;
use ots_core::{
    Access, FileChangeKind, RiskLevel, Tool, ToolContext, ToolError, ToolInvocation, ToolResult, ToolSpec,
};
use serde_json::json;

use crate::args;
use crate::diff;
use crate::paths;

/// `read_file` 单次返回的最大行数。
const DEFAULT_READ_LINES: usize = 2000;

/// 读取工作区内的文本文件。
#[derive(Debug, Clone, Copy, Default)]
pub struct ReadFileTool;

impl ReadFileTool {
    /// 工具名。
    pub const NAME: &'static str = "read_file";
}

#[async_trait]
impl Tool for ReadFileTool {
    /// 工具声明（开发者 Jan）：参数说明里点明分页与 file 标签不计入正文，减少模型的误读
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            Self::NAME,
            "读取工作区内某个文本文件的内容。可用 offset/limit 分页读取大文件；\
             输出中的 <file> 标签带有行号范围与总行数，标签本身不属于文件内容。",
            json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "相对工作区的文件路径，也接受绝对路径"
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "起始行号（从 1 开始），省略则从第 1 行开始"
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "最多读取的行数，省略则最多 2000 行"
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            RiskLevel::Low,
            false,
        )
        .with_tags(["file", "read"])
    }

    /// 读取文件内容（开发者 Jan）。
    ///
    /// 文件不存在时返回「文件不存在」的可读提示而不是抛错：
    /// 模型常常先猜一个路径再看结果，让它拿到明确原因比直接失败更有助于自我纠正。
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let raw_path = args::required_str(&invocation.arguments, "path")?;
        let path = paths::resolve(ctx, &raw_path, Access::Read)?;
        let shown = paths::display(&ctx.workspace, &path);

        let Some(text) = paths::read_text_if_exists(&path).await? else {
            return Err(ToolError::Failed(format!("文件不存在: {shown}")));
        };

        let all_lines: Vec<&str> = text.lines().collect();
        let total = all_lines.len();
        let offset = args::optional_positive_u64(&invocation.arguments, "offset")?.unwrap_or(1) as usize;
        let limit = args::optional_positive_u64(&invocation.arguments, "limit")?
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_READ_LINES);

        let start = offset.saturating_sub(1).min(total);
        let end = start.saturating_add(limit).min(total);
        let body = all_lines[start..end].join("\n");

        let more = if end < total {
            format!(" next_offset=\"{}\"", end + 1)
        } else {
            String::new()
        };
        let rendered = if total == 0 {
            format!("<file path=\"{shown}\" lines=\"0-0\" total=\"0\">\n（空文件）\n</file>")
        } else {
            format!("<file path=\"{shown}\" lines=\"{}-{}\" total=\"{total}\"{more}>\n{body}\n</file>", start + 1, end)
        };

        Ok(ToolResult::success(rendered).with_data(json!({
            "path": shown,
            "start_line": if total == 0 { 0 } else { start + 1 },
            "end_line": end,
            "total_lines": total,
            "has_more": end < total,
        })))
    }
}

/// 写入（覆盖）工作区内的文本文件。
#[derive(Debug, Clone, Copy, Default)]
pub struct WriteFileTool;

impl WriteFileTool {
    /// 工具名。
    pub const NAME: &'static str = "write_file";
}

#[async_trait]
impl Tool for WriteFileTool {
    /// 工具声明（开发者 Jan）：说明里引导模型优先用 apply_patch 做小改动，减少整体重写带来的意外差异
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            Self::NAME,
            "把完整内容写入工作区内的文件（覆盖原有内容），必要时自动创建父目录。\
             小改动请优先使用 apply_patch，以免整体重写带来意外差异。",
            json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "相对工作区的文件路径，也接受绝对路径"
                    },
                    "content": {
                        "type": "string",
                        "description": "写入的完整文件内容"
                    },
                    "create_dirs": {
                        "type": "boolean",
                        "description": "父目录不存在时是否自动创建，默认 true"
                    }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            RiskLevel::Medium,
            true,
        )
        .with_tags(["file", "write"])
    }

    /// 支持操作预览（开发者 Jan）：写入内容在落盘前即可完整展示，便于用户先确认
    fn supports_preview(&self) -> bool {
        true
    }

    /// 写入文件（开发者 Jan）：默认自动创建父目录，避免模型为了写一个新文件还要先建目录
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let raw_path = args::required_str(&invocation.arguments, "path")?;
        let content = args::required_text(&invocation.arguments, "content")?;
        let create_dirs = args::optional_bool(&invocation.arguments, "create_dirs")?.unwrap_or(true);
        let path = paths::resolve(ctx, &raw_path, Access::Write)?;
        let shown = paths::display(&ctx.workspace, &path);

        let previous = paths::read_text_if_exists(&path).await?;
        let kind = if previous.is_some() { FileChangeKind::Modify } else { FileChangeKind::Create };
        let change = paths::change(shown.clone(), kind, previous.as_deref().unwrap_or(""), &content, diff::DEFAULT_MAX_DIFF_BYTES);

        if !ctx.dry_run {
            if create_dirs {
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|err| ToolError::Failed(format!("创建目录 {} 失败: {err}", parent.display())))?;
                }
            }
            tokio::fs::write(&path, content.as_bytes())
                .await
                .map_err(|err| ToolError::Failed(format!("写入 {shown} 失败: {err}")))?;
        }

        let verb = if ctx.dry_run { "预览" } else { "写入" };
        let marker = change.kind.marker();
        let summary = format!(
            "{verb} {shown}（{marker}，+{} -{}）",
            change.additions, change.deletions
        );
        let data = paths::file_changes_data(std::slice::from_ref(&change));

        if ctx.dry_run {
            Ok(ToolResult::success(summary).with_data(data))
        } else {
            Ok(ToolResult::success(format!("已{summary}")).with_data(data))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::{ToolInvocation, ToolLimits, ToolRegistry, ToolRuntime};
    use tokio_util::sync::CancellationToken;

    fn runtime() -> ToolRuntime {
        let mut registry = ToolRegistry::new();
        registry.register(ReadFileTool).expect("注册成功");
        registry.register(WriteFileTool).expect("注册成功");
        ToolRuntime::new(registry, ToolLimits::default())
    }

    fn context(dir: &std::path::Path) -> ToolContext {
        ToolContext::permissive(dir, CancellationToken::new())
    }

    #[tokio::test]
    async fn 读取文件带出行号范围() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a.txt"), "l1\nl2\nl3\n").expect("写入");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "read_file", json!({"path": "a.txt"})), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert!(result.stdout.contains("lines=\"1-3\""));
        assert!(result.stdout.contains("l2"));
    }

    #[tokio::test]
    async fn 分页读取返回后续偏移() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a.txt"), "l1\nl2\nl3\n").expect("写入");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(
                ToolInvocation::new("1", "read_file", json!({"path": "a.txt", "offset": 2, "limit": 1})),
                &ctx,
            )
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert!(result.stdout.contains("lines=\"2-2\""));
        assert!(result.stdout.contains("next_offset=\"3\""));
        assert!(!result.stdout.contains("l1"));
    }

    #[tokio::test]
    async fn 读取不存在的文件失败() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "read_file", json!({"path": "nope.txt"})), &ctx)
            .await;
        assert!(!result.ok);
        assert!(result.stderr.contains("不存在"));
    }

    #[tokio::test]
    async fn 写文件返回变更清单() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(
                ToolInvocation::new("1", "write_file", json!({"path": "sub/a.txt", "content": "hello\n"})),
                &ctx,
            )
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(std::fs::read_to_string(dir.path().join("sub/a.txt")).expect("读回"), "hello\n");

        let changes = ots_core::FileChange::list_from_tool_result(&result).expect("有变更清单");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "sub/a.txt");
        assert_eq!(changes[0].kind, FileChangeKind::Create);
        assert_eq!(changes[0].additions, 1);
    }

    #[tokio::test]
    async fn 预览模式不落盘() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mut ctx = context(dir.path());
        ctx.dry_run = true;
        let result = runtime()
            .execute(
                ToolInvocation::new("1", "write_file", json!({"path": "a.txt", "content": "x"})),
                &ctx,
            )
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert!(!dir.path().join("a.txt").exists());
    }

    #[tokio::test]
    async fn 覆盖已有文件时标记为修改() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a.txt"), "old\n").expect("写入");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(
                ToolInvocation::new("1", "write_file", json!({"path": "a.txt", "content": "new\n"})),
                &ctx,
            )
            .await;
        let changes = ots_core::FileChange::list_from_tool_result(&result).expect("有变更清单");
        assert_eq!(changes[0].kind, FileChangeKind::Modify);
        assert_eq!(changes[0].additions, 1);
        assert_eq!(changes[0].deletions, 1);
    }
}
