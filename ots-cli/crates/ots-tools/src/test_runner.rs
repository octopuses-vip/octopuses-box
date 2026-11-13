//! `test_runner` 工具：执行验证命令并给出通过/失败判定。

use std::collections::BTreeMap;

use async_trait::async_trait;
use ots_core::{RiskLevel, Tool, ToolContext, ToolError, ToolInvocation, ToolResult, ToolSpec};
use serde_json::json;

use crate::args;
use crate::process;

/// 执行测试/验证命令。
///
/// 默认命令来自配置 `agent.test_command`，调用时可用 `command` 参数覆盖。
#[derive(Debug, Clone, Default)]
pub struct TestRunnerTool {
    default_command: Option<String>,
}

impl TestRunnerTool {
    /// 工具名。
    pub const NAME: &'static str = "test_runner";

    /// 以配置中的默认测试命令构造。
    pub fn new(default_command: Option<String>) -> Self {
        Self { default_command: default_command.filter(|command| !command.trim().is_empty()) }
    }
}

#[async_trait]
impl Tool for TestRunnerTool {
    /// 工具声明（开发者 Jan）：描述里带上配置的默认命令，让模型知道不传 command 时会跑什么
    fn spec(&self) -> ToolSpec {
        let description = match &self.default_command {
            Some(command) => format!(
                "在工作区根目录执行验证命令并返回结果，退出码为 0 视为通过。\
                 省略 `command` 时使用配置中的测试命令：`{command}`。"
            ),
            None => "在工作区根目录执行验证命令并返回结果，退出码为 0 视为通过。\
                     当前未配置默认测试命令，调用时必须提供 `command`。"
                .to_string(),
        };
        ToolSpec::new(
            Self::NAME,
            description,
            json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的验证命令，省略则使用配置中的 agent.test_command"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "本次调用的超时秒数，省略则使用全局配置"
                    }
                },
                "additionalProperties": false
            }),
            RiskLevel::Medium,
            false,
        )
        .with_tags(["verify", "test"])
        .as_config_verifier()
    }

    /// 执行验证命令（开发者 Jan）：未传 command 时用配置的默认命令；
    /// 既没传也没配默认值时给出可读错误，而不是静默什么都不做。
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let command = match args::optional_str(&invocation.arguments, "command")? {
            Some(command) => command,
            None => self.default_command.clone().ok_or_else(|| {
                ToolError::Invalid(
                    "未提供 `command`，且配置中没有 `agent.test_command`；请在参数或配置中指定验证命令".to_string(),
                )
            })?,
        };
        ctx.guard.check_command(&command)?;
        let timeout = args::timeout(&invocation.arguments, ctx)?;

        let spec = process::shell_spec(
            ctx.guard.as_ref(),
            command.clone(),
            ctx.workspace.clone(),
            &BTreeMap::new(),
            timeout,
        );
        let outcome = process::run(spec, &ctx.cancel).await?;
        if outcome.timed_out {
            return Err(ToolError::Timeout);
        }
        if outcome.cancelled {
            return Err(ToolError::Cancelled);
        }

        let passed = outcome.is_success();
        let exit_code = outcome.exit_code;
        let data = json!({ "command": command, "passed": passed, "exit_code": exit_code });
        let mut result = outcome.into_result(data);

        let headline = if passed {
            "验证通过（退出码 0）".to_string()
        } else {
            match exit_code {
                Some(code) => format!("验证未通过（退出码 {code}）"),
                None => "验证未通过（进程被终止）".to_string(),
            }
        };
        result.stdout = if result.stdout.trim().is_empty() {
            format!("{headline}\n")
        } else {
            format!("{headline}\n--- 输出 ---\n{}", result.stdout)
        };
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::{ToolInvocation, ToolLimits, ToolRegistry, ToolRuntime};
    use tokio_util::sync::CancellationToken;

    fn runtime(default: Option<&str>) -> ToolRuntime {
        let mut registry = ToolRegistry::new();
        registry.register(TestRunnerTool::new(default.map(str::to_string))).expect("注册成功");
        ToolRuntime::new(registry, ToolLimits::default())
    }

    #[tokio::test]
    async fn 使用默认命令并通过() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = ToolContext::permissive(dir.path(), CancellationToken::new());
        let result = runtime(Some("exit 0"))
            .execute(ToolInvocation::new("1", "test_runner", json!({})), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert!(result.stdout.contains("验证通过"));
    }

    #[tokio::test]
    async fn 命令失败时判定未通过() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = ToolContext::permissive(dir.path(), CancellationToken::new());
        let result = runtime(Some("exit 1"))
            .execute(ToolInvocation::new("1", "test_runner", json!({})), &ctx)
            .await;
        assert!(!result.ok);
        assert!(result.stdout.contains("验证未通过"));
        assert_eq!(result.data.as_ref().and_then(|d| d.get("passed")).and_then(|v| v.as_bool()), Some(false));
    }

    #[tokio::test]
    async fn 参数覆盖默认命令() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = ToolContext::permissive(dir.path(), CancellationToken::new());
        let result = runtime(None)
            .execute(ToolInvocation::new("1", "test_runner", json!({"command": "exit 0"})), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
    }

    #[tokio::test]
    async fn 未配置且未提供命令时报参数错误() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = ToolContext::permissive(dir.path(), CancellationToken::new());
        let result = runtime(None)
            .execute(ToolInvocation::new("1", "test_runner", json!({})), &ctx)
            .await;
        assert_eq!(result.error_kind, Some(ots_core::ToolErrorKind::InvalidArguments));
    }
}
