//! `shell` 工具：在工作区内执行一条 shell 命令。

use std::collections::BTreeMap;

use async_trait::async_trait;
use ots_core::{Access, RiskLevel, Tool, ToolContext, ToolError, ToolInvocation, ToolResult, ToolSpec};
use serde_json::json;

use crate::args;
use crate::paths;
use crate::process;

/// 工作区内执行 shell 命令。
#[derive(Debug, Clone, Copy, Default)]
pub struct ShellTool;

impl ShellTool {
    /// 工具名。
    pub const NAME: &'static str = "shell";
}

#[async_trait]
impl Tool for ShellTool {
    /// 工具声明（开发者 Jan）：说明里点明命令会先过沙箱与审批，让模型知道失败可能是策略拦截
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            Self::NAME,
            "在工作区内执行一条 shell 命令，返回标准输出、标准错误与退出码。\
             适用于构建、运行测试、调用 git 等操作。命令会先经过沙箱与审批策略校验；\
             读取文件请优先使用 read_file。",
            json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的完整 shell 命令"
                    },
                    "cwd": {
                        "type": "string",
                        "description": "相对工作区的执行目录，省略则使用工作区根目录"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "本次调用的超时秒数，省略则使用全局配置"
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            RiskLevel::High,
            true,
        )
        .with_tags(["shell", "exec"])
    }

    /// 执行命令（开发者 Jan）。
    ///
    /// 执行前先过 ctx.guard 的命令校验：模型给的命令与用户在终端里敲的不同，
    /// 必须经策略判定后才允许运行。工作目录可显式指定，未指定时落在工作区根。
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let command = args::required_str(&invocation.arguments, "command")?;
        ctx.guard.check_command(&command)?;

        let cwd = match args::optional_str(&invocation.arguments, "cwd")? {
            Some(dir) => paths::resolve(ctx, &dir, Access::Read)?,
            None => ctx.workspace.clone(),
        };
        let timeout = args::timeout(&invocation.arguments, ctx)?;

        let spec = process::shell_spec(ctx.guard.as_ref(), command.clone(), cwd, &BTreeMap::new(), timeout);
        let outcome = process::run(spec, &ctx.cancel).await?;
        if outcome.timed_out {
            return Err(ToolError::Timeout);
        }
        if outcome.cancelled {
            return Err(ToolError::Cancelled);
        }

        Ok(outcome.into_result(json!({ "command": command })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::{ToolInvocation, ToolRuntime, ToolRegistry, ToolLimits};
    use serde_json::json;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn context(workspace: &std::path::Path) -> ToolContext {
        ToolContext::permissive(workspace, CancellationToken::new())
    }

    fn runtime() -> ToolRuntime {
        let mut registry = ToolRegistry::new();
        registry.register(ShellTool).expect("注册成功");
        ToolRuntime::new(registry, ToolLimits::default())
    }

    #[tokio::test]
    async fn 执行命令并返回输出() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "shell", json!({"command": "printf 'ok'"})), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(result.stdout, "ok");
        assert_eq!(result.exit_code, Some(0));
    }

    #[tokio::test]
    async fn 非零退出码保留输出() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "shell", json!({"command": "echo bad >&2; exit 2"})), &ctx)
            .await;
        assert!(!result.ok);
        assert_eq!(result.exit_code, Some(2));
        assert!(result.stderr.contains("bad"));
    }

    #[tokio::test]
    async fn 工作目录以工作区为基准() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::create_dir(dir.path().join("sub")).expect("建目录");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "shell", json!({"command": "pwd", "cwd": "sub"})), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        let printed = std::fs::canonicalize(result.stdout.trim()).expect("路径存在");
        let expected = std::fs::canonicalize(dir.path().join("sub")).expect("路径存在");
        assert_eq!(printed, expected);
    }

    #[tokio::test]
    async fn 缺少命令参数时报参数错误() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = context(dir.path());
        let result = runtime()
            .execute(ToolInvocation::new("1", "shell", json!({})), &ctx)
            .await;
        assert_eq!(result.error_kind, Some(ots_core::ToolErrorKind::InvalidArguments));
    }

    #[tokio::test]
    async fn 守卫拒绝命令时返回拒绝分类() {
        struct DenyGuard;

        impl ots_core::ExecGuard for DenyGuard {
            fn resolve_path(&self, path: &std::path::Path, _access: Access) -> ots_core::CoreResult<std::path::PathBuf> {
                Ok(path.to_path_buf())
            }

            fn check_command(&self, _program: &str) -> ots_core::CoreResult<()> {
                Err(ots_core::CoreError::PolicyDenied("命中禁止规则".to_string()))
            }

            fn env_overrides(&self) -> BTreeMap<String, String> {
                std::env::vars().collect()
            }

            fn describe(&self) -> String {
                "测试用拒绝守卫".to_string()
            }
        }

        let dir = tempfile::tempdir().expect("临时目录");
        let mut ctx = context(dir.path());
        ctx.guard = Arc::new(DenyGuard);
        let result = runtime()
            .execute(ToolInvocation::new("1", "shell", json!({"command": "rm -rf /"})), &ctx)
            .await;
        assert!(!result.ok);
        assert_eq!(result.error_kind, Some(ots_core::ToolErrorKind::Denied));
    }
}
