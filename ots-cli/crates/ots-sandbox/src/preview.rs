//! 操作预览：在不产生副作用的前提下，算出一次工具调用「会发生什么」。
//!
//! 预览由三部分构成：
//! 1. **静态分析**：从参数里取出命令与路径，交给执行守卫判断是否越界；
//! 2. **干跑（dry-run）**：仅对声明了 [`ots_core::Tool::supports_preview`] 的工具
//!    以 `dry_run = true` 执行一次，取得真实文件差异；
//! 3. **备注**：把「不做预演执行」等限制明确告诉用户，避免把静态分析误当成实际影响。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ots_core::{Access, ExecGuard, FileChange, OperationPreview, ToolContext, ToolInvocation, ToolRuntime};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::rules::{collect_strings, resolve_argument_path, COMMAND_KEYS, PATH_KEYS};

/// 预览工具调用时使用的调用 id。
const PREVIEW_CALL_ID: &str = "preview";

/// 操作预览构造器。
pub struct PreviewBuilder {
    runtime: Arc<ToolRuntime>,
    guard: Arc<dyn ExecGuard>,
    workspace: PathBuf,
}

impl PreviewBuilder {
    /// 构造预览器。
    pub fn new(runtime: Arc<ToolRuntime>, guard: Arc<dyn ExecGuard>, workspace: impl Into<PathBuf>) -> Self {
        Self { runtime, guard, workspace: workspace.into() }
    }

    /// 生成一次调用的操作预览。
    ///
    /// 本方法不会失败：任何无法确定的因素都会以 `notes` 的形式呈现，
    /// 让人在信息不完整时也能看到「为什么不确定」。
    pub async fn build(&self, tool: &str, arguments: &Value, cwd: &Path) -> OperationPreview {
        let spec = self.runtime.registry().get(tool).map(|implementation| implementation.spec());
        let mut preview = OperationPreview::new(String::new());
        preview.commands = collect_strings(arguments, COMMAND_KEYS);

        let access = if spec.as_ref().is_some_and(|spec| spec.mutating) { Access::Write } else { Access::Read };
        for raw in collect_strings(arguments, PATH_KEYS) {
            let path = resolve_argument_path(cwd, &raw);
            if let Err(err) = self.guard.resolve_path(&path, access) {
                preview.out_of_scope.push(format!("{} —— {err}", display(&path, cwd)));
            }
        }

        match self.runtime.registry().get(tool) {
            None => preview.notes.push(format!("工具 `{tool}` 未注册，无法预演，也无法执行")),
            Some(implementation) if implementation.supports_preview() => {
                self.run_dry(&mut preview, tool, arguments).await;
            }
            Some(_) => preview.notes.push(
                "该工具不支持预演执行，以上内容为静态分析；它的真实副作用只会在批准之后产生".to_string(),
            ),
        }

        preview.summary = summarize(tool, &preview);
        preview
    }

    /// 以 `dry_run = true` 执行一次工具，收集文件变更。
    async fn run_dry(&self, preview: &mut OperationPreview, tool: &str, arguments: &Value) {
        let context = ToolContext {
            workspace: self.workspace.clone(),
            cancel: CancellationToken::new(),
            timeout: self.runtime.limits().timeout,
            dry_run: true,
            guard: Arc::clone(&self.guard),
        };
        let result = self
            .runtime
            .execute(ToolInvocation::new(PREVIEW_CALL_ID, tool, arguments.clone()), &context)
            .await;
        if !result.ok {
            preview.notes.push(format!("预演失败：{}", result.stderr.trim()));
            return;
        }
        match FileChange::list_from_tool_result(&result) {
            Some(changes) => preview.file_changes = changes,
            None => preview.notes.push("预演执行未产生任何文件变更".to_string()),
        }
    }
}

/// 渲染预览的一行摘要。
fn summarize(tool: &str, preview: &OperationPreview) -> String {
    let impact = preview.impact();
    let mut parts: Vec<String> = Vec::new();
    if impact.files > 0 {
        parts.push(format!("改动 {} 个文件（+{} / -{}）", impact.files, impact.additions, impact.deletions));
    }
    if !preview.commands.is_empty() {
        parts.push(format!("执行 {} 条命令", preview.commands.len()));
    }
    if !preview.out_of_scope.is_empty() {
        parts.push(format!("涉及 {} 个越界路径", preview.out_of_scope.len()));
    }
    if parts.is_empty() {
        format!("调用工具 `{tool}`，无法预估影响范围")
    } else {
        format!("{tool}：{}", parts.join("，"))
    }
}

/// 渲染为相对工作区的展示路径。
fn display(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_config::OtsConfig;
    use ots_core::{SkillRegistry, ToolLimits};
    use ots_tools::build_registry;
    use serde_json::json;

    fn builder(workspace: &Path) -> PreviewBuilder {
        let config = OtsConfig::default();
        let runtime = Arc::new(ToolRuntime::new(
            build_registry(&config, Arc::new(SkillRegistry::new())).expect("构造成功"),
            ToolLimits::default(),
        ));
        let guard = crate::guard::build_guard(&config, workspace).expect("构造成功");
        PreviewBuilder::new(runtime, guard, workspace)
    }

    #[tokio::test]
    async fn 写入类工具给出文件差异且不落盘() {
        let dir = tempfile::tempdir().expect("临时目录");
        let preview = builder(dir.path())
            .build("write_file", &json!({ "path": "a.txt", "content": "hello\n" }), dir.path())
            .await;
        assert_eq!(preview.file_changes.len(), 1);
        assert_eq!(preview.file_changes[0].path, "a.txt");
        assert_eq!(preview.file_changes[0].additions, 1);
        assert!(preview.summary.contains("改动 1 个文件"));
        assert!(!dir.path().join("a.txt").exists(), "预演不得落盘");
    }

    #[tokio::test]
    async fn 命令类工具只做静态展示不执行() {
        let dir = tempfile::tempdir().expect("临时目录");
        let preview = builder(dir.path())
            .build("shell", &json!({ "command": "touch 预演不应创建.txt" }), dir.path())
            .await;
        assert_eq!(preview.commands, vec!["touch 预演不应创建.txt".to_string()]);
        assert!(preview.notes.iter().any(|note| note.contains("不支持预演执行")));
        assert!(!dir.path().join("预演不应创建.txt").exists(), "预演不得执行命令");
    }

    #[tokio::test]
    async fn 越界路径被标记为超出范围() {
        let dir = tempfile::tempdir().expect("临时目录");
        let preview = builder(dir.path())
            .build("write_file", &json!({ "path": "/etc/hosts", "content": "x" }), dir.path())
            .await;
        assert_eq!(preview.out_of_scope.len(), 1);
        assert!(preview.summary.contains("越界路径"));
    }

    #[tokio::test]
    async fn 未注册工具给出说明性备注() {
        let dir = tempfile::tempdir().expect("临时目录");
        let preview = builder(dir.path()).build("nope", &json!({}), dir.path()).await;
        assert!(preview.notes.iter().any(|note| note.contains("未注册")));
        assert!(preview.summary.contains("nope"));
    }

    #[tokio::test]
    async fn 预演不会真实改动工作区() {
        let dir = tempfile::tempdir().expect("临时目录");
        let target = dir.path().join("a.txt");
        std::fs::write(&target, "old\n").expect("写入初始内容");
        let preview = builder(dir.path())
            .build(
                "apply_patch",
                &json!({ "patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n" }),
                dir.path(),
            )
            .await;
        assert_eq!(preview.file_changes.len(), 1);
        assert_eq!(std::fs::read_to_string(&target).expect("读回"), "old\n");
    }
}
