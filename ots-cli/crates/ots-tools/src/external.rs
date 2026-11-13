//! 外部工具适配器：把配置里的命令包装成标准 [`Tool`]。
//!
//! 参数通过 `{{参数名}}` 模板映射到命令行：占位符独占一个参数项且取值为数组时按元素展开，
//! 取值为 `null` 时整项省略，嵌在其它文本中时按标量文本替换。

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use ots_config::ExternalToolConfig;
use ots_core::{RiskLevel, Tool, ToolContext, ToolError, ToolInvocation, ToolResult, ToolSpec};
use serde_json::Value;

use crate::args;
use crate::process::{self, ProcessSpec};

/// 由配置驱动的外部工具。
#[derive(Debug, Clone)]
pub struct ExternalTool {
    name: String,
    description: String,
    command: String,
    args: Vec<String>,
    parameters: Value,
    risk: RiskLevel,
    mutating: bool,
    tags: Vec<String>,
    timeout: Option<Duration>,
    env: BTreeMap<String, String>,
}

impl ExternalTool {
    /// 从配置定义构造。
    pub fn new(config: &ExternalToolConfig) -> Self {
        Self {
            name: config.name.clone(),
            description: config.description.clone(),
            command: config.command.clone(),
            args: config.args.clone(),
            parameters: config.parameters.clone(),
            risk: config.risk,
            mutating: config.mutating,
            tags: config.tags.clone(),
            timeout: config.timeout_secs.map(Duration::from_secs),
            env: config.env.clone(),
        }
    }

    /// 渲染命令行参数。
    ///
    /// # Errors
    /// 模板引用了调用未提供的参数、占位符不闭合或把复合类型嵌入文本时返回
    /// [`ToolError::Invalid`]。
    fn render_args(&self, arguments: &Value) -> Result<Vec<String>, ToolError> {
        let mut rendered = Vec::new();
        for template in &self.args {
            rendered.extend(render_template(template, arguments)?);
        }
        Ok(rendered)
    }
}

#[async_trait]
impl Tool for ExternalTool {
    /// 工具声明（开发者 Jan）：完全来自配置（名称、描述、参数 schema、风险与标签），
    /// 因此外部工具无需改代码即可接入模型。
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            self.name.clone(),
            self.description.clone(),
            self.parameters.clone(),
            self.risk,
            self.mutating,
        )
        .with_tags(self.tags.clone())
    }

    /// 执行外部命令（开发者 Jan）：先过守卫的命令校验，再把参数填进模板后运行。
    /// 外部工具本质上仍是「执行一条命令」，因此不能因为来自配置就跳过安全校验。
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        // 外部工具同样是「要执行的命令」，必须经过守卫的命令校验。
        ctx.guard.check_command(&self.command)?;
        let rendered = self.render_args(&invocation.arguments)?;

        let timeout = match self.timeout {
            Some(limit) => args::timeout(&invocation.arguments, ctx)?.min(limit),
            None => args::timeout(&invocation.arguments, ctx)?,
        };
        let spec = ProcessSpec::with_guard(
            ctx.guard.as_ref(),
            self.command.clone(),
            rendered.clone(),
            ctx.workspace.clone(),
            &self.env,
            timeout,
        );

        let outcome = process::run(spec, &ctx.cancel).await?;
        if outcome.timed_out {
            return Err(ToolError::Timeout);
        }
        if outcome.cancelled {
            return Err(ToolError::Cancelled);
        }

        Ok(outcome.into_result(serde_json::json!({
            "command": self.command,
            "args": rendered,
        })))
    }
}

/// 渲染单个参数模板。
fn render_template(template: &str, arguments: &Value) -> Result<Vec<String>, ToolError> {
    if let Some(key) = exact_placeholder(template) {
        let Some(value) = arguments.get(key) else {
            return Err(missing_key(key));
        };
        return match value {
            Value::Null => Ok(Vec::new()),
            Value::Array(items) => items.iter().map(|item| scalar_text(item, key)).collect(),
            other => Ok(vec![scalar_text(other, key)?]),
        };
    }

    let mut output = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return Err(ToolError::Invalid(format!("参数模板 `{template}` 的占位符缺少 `}}}}`")));
        };
        let key = after[..end].trim();
        let Some(value) = arguments.get(key) else {
            return Err(missing_key(key));
        };
        output.push_str(&scalar_text(value, key)?);
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    Ok(vec![output])
}

/// 模板若整体就是一个占位符，返回其中的参数名。
fn exact_placeholder(template: &str) -> Option<&str> {
    let inner = template.strip_prefix("{{")?.strip_suffix("}}")?;
    if inner.contains("{{") || inner.contains("}}") {
        return None;
    }
    let key = inner.trim();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// 把标量取值渲染为命令行文本。
fn scalar_text(value: &Value, key: &str) -> Result<String, ToolError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::Null => Err(ToolError::Invalid(format!(
            "参数 `{key}` 为 null，无法嵌入到参数模板中（只有独占一个参数项时才可省略）"
        ))),
        Value::Array(_) | Value::Object(_) => Err(ToolError::Invalid(format!(
            "参数 `{key}` 是复合类型，只能作为独立参数项（形如 `--x` 之后的 `{{{{{key}}}}}`）传入"
        ))),
    }
}

/// 构造「参数模板引用了未提供的参数」错误（开发者 Jan）：
/// 明确点出是哪个键缺失，让模型能补上参数重试，而不是只看到一句泛泛的失败。
fn missing_key(key: &str) -> ToolError {
    ToolError::Invalid(format!("参数模板引用了 `{key}`，但本次调用没有提供该参数"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_config::ExternalToolConfig;
    use ots_core::{ToolInvocation, ToolLimits, ToolRegistry, ToolRuntime};
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    fn config() -> ExternalToolConfig {
        ExternalToolConfig {
            name: "say".to_string(),
            description: "回显参数".to_string(),
            command: "/bin/echo".to_string(),
            args: vec!["--".to_string(), "{{text}}".to_string()],
            parameters: json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"],
                "additionalProperties": false
            }),
            risk: RiskLevel::Low,
            mutating: false,
            tags: vec!["demo".to_string()],
            timeout_secs: None,
            env: BTreeMap::new(),
        }
    }

    fn runtime() -> ToolRuntime {
        let mut registry = ToolRegistry::new();
        registry.register(ExternalTool::new(&config())).expect("注册成功");
        ToolRuntime::new(registry, ToolLimits::default())
    }

    #[tokio::test]
    async fn 执行外部命令并渲染占位符() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = ToolContext::permissive(dir.path(), CancellationToken::new());
        let result = runtime()
            .execute(ToolInvocation::new("1", "say", json!({"text": "你好"})), &ctx)
            .await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(result.stdout.trim(), "-- 你好");
    }

    #[tokio::test]
    async fn 缺少模板参数时报错() {
        let dir = tempfile::tempdir().expect("临时目录");
        let ctx = ToolContext::permissive(dir.path(), CancellationToken::new());
        let result = runtime()
            .execute(ToolInvocation::new("1", "say", json!({"other": 1})), &ctx)
            .await;
        // 参数 Schema 会先拦截；此处直接调用渲染函数验证提示信息。
        assert!(!result.ok);
        let rendered = ExternalTool::new(&config()).render_args(&json!({"other": 1}));
        assert!(rendered.expect_err("应报错").to_string().contains("text"));
    }

    #[test]
    fn 数组展开为多个参数() {
        let mut config = config();
        config.args = vec!["--".to_string(), "{{items}}".to_string()];
        let tool = ExternalTool::new(&config);
        let rendered = tool.render_args(&json!({"items": ["a", "b"]})).expect("渲染成功");
        assert_eq!(rendered, vec!["--", "a", "b"]);
    }

    #[test]
    fn null取值省略整个参数项() {
        let mut config = config();
        config.args = vec!["--flag".to_string(), "{{maybe}}".to_string()];
        let tool = ExternalTool::new(&config);
        let rendered = tool.render_args(&json!({"maybe": null})).expect("渲染成功");
        assert_eq!(rendered, vec!["--flag"]);
    }

    #[test]
    fn 内嵌占位符按标量替换() {
        let mut config = config();
        config.args = vec!["--path={{path}}".to_string()];
        let tool = ExternalTool::new(&config);
        let rendered = tool.render_args(&json!({"path": "src/main.rs"})).expect("渲染成功");
        assert_eq!(rendered, vec!["--path=src/main.rs"]);
    }
}
