//! 工具抽象与运行时。
//!
//! 一个工具由 [`ToolSpec`]（自描述元数据）与 [`Tool::invoke`]（执行体）组成。
//! [`ToolRuntime`] 负责统一的参数校验、超时、取消、并发与输出截断，
//! 因此具体工具实现只需关心「业务本身」，无需重复处理横切关注点。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, CoreResult};
use crate::guard::ExecGuard;
use crate::policy::RiskLevel;

/// 模型发起的一次工具调用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// 调用 id（由模型给出，用于把结果回灌到对应消息）。
    pub id: String,
    /// 工具名。
    pub name: String,
    /// 参数（已解析为 JSON）。
    pub arguments: Value,
}

impl ToolCall {
    /// 构造一次工具调用。
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: Value) -> Self {
        Self { id: id.into(), name: name.into(), arguments }
    }
}

/// 工具的自描述元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// 工具名（唯一，模型通过它调用）。
    pub name: String,
    /// 面向模型的能力描述。
    pub description: String,
    /// 参数 JSON Schema（draft 2020-12 兼容子集）。
    pub parameters: Value,
    /// 风险等级，供策略引擎与审批分级使用。
    pub risk: RiskLevel,
    /// 是否会修改工作区状态。
    pub mutating: bool,
    /// 分类标签，便于按标签批量启用/禁用。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 该工具是否为「项目配置声明的验证手段」。
    ///
    /// 为 `true` 时，策略引擎可以把「不传参调用」或「恰好等于 `agent.test_command` 的调用」
    /// 直接放行——因为它执行的是项目自己的验证命令，而不是模型临时构造的任意命令。
    #[serde(default)]
    pub config_verified: bool,
}

impl ToolSpec {
    /// 构造一个工具元数据描述。
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
        risk: RiskLevel,
        mutating: bool,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
            risk,
            mutating,
            tags: Vec::new(),
            config_verified: false,
        }
    }

    /// 附加标签。
    #[must_use]
    pub fn with_tags(mut self, tags: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.tags = tags.into_iter().map(Into::into).collect();
        self
    }

    /// 标记该工具是配置声明的验证手段（见 [`Self::config_verified`]）。
    #[must_use]
    pub fn as_config_verifier(mut self) -> Self {
        self.config_verified = true;
        self
    }

    /// 转换为 OpenAI Chat Completions 的 `tools` 元素。
    pub fn to_openai_tool(&self) -> Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        })
    }
}

/// 工具调用请求。
#[derive(Debug, Clone)]
pub struct ToolInvocation {
    /// 调用 id。
    pub call_id: String,
    /// 工具名。
    pub tool: String,
    /// 参数。
    pub arguments: Value,
}

impl ToolInvocation {
    /// 构造调用请求。
    pub fn new(call_id: impl Into<String>, tool: impl Into<String>, arguments: Value) -> Self {
        Self { call_id: call_id.into(), tool: tool.into(), arguments }
    }
}

/// 工具执行上下文：由运行时构造并注入。
#[derive(Clone)]
pub struct ToolContext {
    /// 工作区根目录，所有相对路径以此为基准。
    pub workspace: PathBuf,
    /// 取消令牌，工具应在长耗时循环中检查。
    pub cancel: CancellationToken,
    /// 单次调用超时。
    pub timeout: Duration,
    /// 仅预览不落盘（`apply_patch` / `write_file` 会据此生成 diff 而不写入）。
    pub dry_run: bool,
    /// 沙箱守卫。
    pub guard: Arc<dyn ExecGuard>,
}

impl std::fmt::Debug for ToolContext {
    /// 手写 Debug（开发者 Jan）：guard 是 trait 对象无法 derive，改用它自己的 describe() 摘要
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContext")
            .field("workspace", &self.workspace)
            .field("timeout", &self.timeout)
            .field("dry_run", &self.dry_run)
            .field("guard", &self.guard.describe())
            .finish()
    }
}

impl ToolContext {
    /// 使用宽松守卫构造上下文（测试用）。
    pub fn permissive(workspace: impl Into<PathBuf>, cancel: CancellationToken) -> Self {
        Self {
            workspace: workspace.into(),
            cancel,
            timeout: Duration::from_secs(120),
            dry_run: false,
            guard: Arc::new(crate::guard::PermissiveGuard),
        }
    }
}

/// 工具执行失败的原因分类，用于把结构化错误回灌给模型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolErrorKind {
    /// 参数不合法。
    InvalidArguments,
    /// 工具不存在。
    UnknownTool,
    /// 执行超时。
    Timeout,
    /// 被取消。
    Cancelled,
    /// 被策略或审批拒绝。
    Denied,
    /// 执行过程报错。
    Failed,
}

/// 工具执行错误。
#[derive(Debug, Clone, thiserror::Error)]
pub enum ToolError {
    /// 参数不合法。
    #[error("{0}")]
    Invalid(String),
    /// 执行失败。
    #[error("{0}")]
    Failed(String),
    /// 被策略、沙箱或审批拒绝。
    #[error("{0}")]
    Denied(String),
    /// 超时。
    #[error("执行超时")]
    Timeout,
    /// 被取消。
    #[error("执行被取消")]
    Cancelled,
}

impl ToolError {
    /// 错误分类。
    pub fn kind(&self) -> ToolErrorKind {
        match self {
            Self::Invalid(_) => ToolErrorKind::InvalidArguments,
            Self::Failed(_) => ToolErrorKind::Failed,
            Self::Denied(_) => ToolErrorKind::Denied,
            Self::Timeout => ToolErrorKind::Timeout,
            Self::Cancelled => ToolErrorKind::Cancelled,
        }
    }
}

impl From<CoreError> for ToolError {
/// 函数级说明（开发者 Jan）：执行 from 的单一职责，并返回可供调用方继续处理的结果。
    fn from(value: CoreError) -> Self {
        match value {
            CoreError::Cancelled => Self::Cancelled,
            CoreError::PolicyDenied(reason) => Self::Denied(reason),
            other => Self::Failed(other.to_string()),
        }
    }
}

/// 工具执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    /// 是否成功。
    pub ok: bool,
    /// 标准输出/主结果。
    #[serde(default)]
    pub stdout: String,
    /// 标准错误/失败原因。
    #[serde(default)]
    pub stderr: String,
    /// 退出码（若适用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// 耗时毫秒。
    pub duration_ms: u64,
    /// 输出是否被截断。
    #[serde(default)]
    pub truncated: bool,
    /// 失败分类（成功时为 `None`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<ToolErrorKind>,
    /// 结构化附加数据（如 diff、受影响文件列表）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ToolResult {
    /// 构造成功结果。
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            ok: true,
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 0,
            truncated: false,
            error_kind: None,
            data: None,
        }
    }

    /// 构造失败结果。
    pub fn failure(kind: ToolErrorKind, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            stdout: String::new(),
            stderr: message.into(),
            exit_code: None,
            duration_ms: 0,
            truncated: false,
            error_kind: Some(kind),
            data: None,
        }
    }

    /// 附加结构化数据。
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    /// 设置耗时。
    #[must_use]
    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.duration_ms = duration.as_millis().min(u64::MAX as u128) as u64;
        self
    }

    /// 设置退出码。
    #[must_use]
    pub fn with_exit_code(mut self, code: Option<i32>) -> Self {
        self.exit_code = code;
        self
    }

    /// 渲染为回灌给模型的可读文本。
    pub fn to_model_text(&self) -> String {
        let mut out = String::new();
        if self.ok {
            out.push_str("状态: 成功\n");
        } else {
            let kind = self.error_kind.map(|k| format!("{k:?}")).unwrap_or_else(|| "Failed".to_string());
            out.push_str(&format!("状态: 失败（{kind}）\n"));
        }
        if let Some(code) = self.exit_code {
            out.push_str(&format!("退出码: {code}\n"));
        }
        if !self.stdout.is_empty() {
            out.push_str("--- stdout ---\n");
            out.push_str(&self.stdout);
            if !self.stdout.ends_with('\n') {
                out.push('\n');
            }
        }
        if !self.stderr.is_empty() {
            out.push_str("--- stderr ---\n");
            out.push_str(&self.stderr);
            if !self.stderr.ends_with('\n') {
                out.push('\n');
            }
        }
        if self.truncated {
            out.push_str("（输出已截断）\n");
        }
        out
    }
}

/// 工具契约。
#[async_trait]
pub trait Tool: Send + Sync {
    /// 工具元数据。
    fn spec(&self) -> ToolSpec;

    /// 是否支持「只计算影响、不产生副作用」的预演执行。
    ///
    /// 审批预览只会对返回 `true` 的工具以 `dry_run = true` 执行一次以取得文件变更；
    /// 其余工具（例如真实执行命令的 `shell`）仅做静态展示，**绝不**预演执行。
    fn supports_preview(&self) -> bool {
        false
    }

    /// 执行工具。
    ///
    /// # Errors
    /// 参数非法返回 [`ToolError::Invalid`]，执行失败返回 [`ToolError::Failed`]。
    async fn invoke(&self, invocation: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError>;
}

/// 工具注册表：名称 → 工具实现。
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl std::fmt::Debug for ToolRegistry {
/// 函数级说明（开发者 Jan）：执行 fmt 的单一职责，并返回可供调用方继续处理的结果。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRegistry").field("tools", &self.names()).finish()
    }
}

impl ToolRegistry {
    /// 空注册表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 以任意 [`Tool`] 实现注册。
    ///
    /// # Errors
    /// 若同名工具已存在返回错误，避免静默覆盖。
    pub fn register<T: Tool + 'static>(&mut self, tool: T) -> CoreResult<()> {
        self.insert(Arc::new(tool))
    }

    /// 以 trait 对象注册。
    ///
    /// # Errors
    /// 若同名工具已存在返回错误。
    pub fn insert(&mut self, tool: Arc<dyn Tool>) -> CoreResult<()> {
        let name = tool.spec().name;
        if self.tools.contains_key(&name) {
            return Err(CoreError::Other(format!("工具重复注册: {name}")));
        }
        self.tools.insert(name, tool);
        Ok(())
    }

    /// 查询工具。
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// 是否存在该工具。
    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// 全部工具元数据（按名称排序）。
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.values().map(|t| t.spec()).collect()
    }

    /// 全部工具名（按名称排序）。
    pub fn names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }

    /// 工具数量。
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

/// 运行时限制。
#[derive(Debug, Clone, Copy)]
pub struct ToolLimits {
    /// 单次调用默认超时。
    pub timeout: Duration,
    /// 输出截断阈值（字节）。
    pub max_output_bytes: usize,
}

impl Default for ToolLimits {
/// 函数级说明（开发者 Jan）：执行 default 的单一职责，并返回可供调用方继续处理的结果。
    fn default() -> Self {
        Self { timeout: Duration::from_secs(120), max_output_bytes: 64 * 1024 }
    }
}

/// 工具运行时：统一处理校验、超时、取消与截断。
#[derive(Clone)]
pub struct ToolRuntime {
    registry: ToolRegistry,
    limits: ToolLimits,
}

impl ToolRuntime {
    /// 构造运行时。
    pub fn new(registry: ToolRegistry, limits: ToolLimits) -> Self {
        Self { registry, limits }
    }

    /// 注册表引用。
    pub fn registry(&self) -> &ToolRegistry {
        &self.registry
    }

    /// 限制配置。
    pub fn limits(&self) -> ToolLimits {
        self.limits
    }

    /// 执行一次工具调用。
    ///
    /// 该方法**不会**返回 `Err`：所有失败都被转换成 `ok = false` 的 [`ToolResult`]，
    /// 以便结构化地回灌给模型进行自我纠正。
    pub async fn execute(&self, invocation: ToolInvocation, ctx: &ToolContext) -> ToolResult {
        let started = Instant::now();
        let Some(tool) = self.registry.get(&invocation.tool) else {
            return ToolResult::failure(
                ToolErrorKind::UnknownTool,
                format!("工具 `{}` 未注册，可用工具: {}", invocation.tool, self.registry.names().join(", ")),
            );
        };

        let spec = tool.spec();
        if let Err(errors) = validate_arguments(&spec, &invocation.arguments) {
            return ToolResult::failure(
                ToolErrorKind::InvalidArguments,
                format!("参数校验失败:\n{}", errors.join("\n")),
            );
        }

        if ctx.cancel.is_cancelled() {
            return ToolResult::failure(ToolErrorKind::Cancelled, "操作已取消");
        }

        let outcome = tokio::select! {
            biased;
            () = ctx.cancel.cancelled() => Err(ToolError::Cancelled),
            result = tokio::time::timeout(self.limits.timeout, tool.invoke(invocation.clone(), ctx)) => {
                match result {
                    Ok(Ok(mut value)) => {
                        truncate_result(&mut value, self.limits.max_output_bytes);
                        Ok(value)
                    }
                    Ok(Err(err)) => Err(err),
                    Err(_) => Err(ToolError::Timeout),
                }
            }
        };

        match outcome {
            Ok(mut value) => {
                value.duration_ms = elapsed_ms(started);
                value
            }
            Err(err) => {
                let kind = err.kind();
                let mut result = ToolResult::failure(kind, err.to_string());
                result.duration_ms = elapsed_ms(started);
                result
            }
        }
    }
}

/// 函数级说明（开发者 Jan）：执行 elapsed_ms 的单一职责，并返回可供调用方继续处理的结果。
fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

/// 按 JSON Schema 校验工具参数，返回人类可读的错误列表。
pub fn validate_arguments(spec: &ToolSpec, arguments: &Value) -> Result<(), Vec<String>> {
    let validator = match jsonschema::validator_for(&spec.parameters) {
        Ok(v) => v,
        Err(err) => return Err(vec![format!("工具 `{}` 的参数 Schema 非法: {err}", spec.name)]),
    };
    let errors: Vec<String> = validator
        .iter_errors(arguments)
        .map(|e| format!("- {} (位置: {})", e, e.instance_path()))
        .collect();
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}

/// 函数级说明（开发者 Jan）：执行 truncate_result 的单一职责，并返回可供调用方继续处理的结果。
fn truncate_result(result: &mut ToolResult, max_bytes: usize) {
    let (stdout, t1) = truncate_output(&result.stdout, max_bytes);
    let (stderr, t2) = truncate_output(&result.stderr, max_bytes);
    result.stdout = stdout;
    result.stderr = stderr;
    result.truncated = t1 || t2 || result.truncated;
}

/// 截断超长文本，保留首尾各一半并插入省略标记。
///
/// 返回 `(截断后的文本, 是否发生截断)`，保证不会破坏 UTF-8 字符边界。
pub fn truncate_output(input: &str, max_bytes: usize) -> (String, bool) {
    if input.len() <= max_bytes {
        return (input.to_string(), false);
    }
    if max_bytes == 0 {
        return (String::new(), true);
    }
    let head_budget = max_bytes / 2;
    let tail_budget = max_bytes - head_budget;
    let head_end = floor_char_boundary(input, head_budget);
    let tail_start = ceil_char_boundary(input, input.len() - tail_budget);
    let omitted = tail_start.saturating_sub(head_end);
    let mut out = String::with_capacity(max_bytes + 64);
    out.push_str(&input[..head_end]);
    out.push_str(&format!("\n…[省略 {omitted} 字节]…\n"));
    out.push_str(&input[tail_start..]);
    (out, true)
}

/// 函数级说明（开发者 Jan）：执行 floor_char_boundary 的单一职责，并返回可供调用方继续处理的结果。
fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// 函数级说明（开发者 Jan）：执行 ceil_char_boundary 的单一职责，并返回可供调用方继续处理的结果。
fn ceil_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while index < s.len() && !s.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoTool;

    #[async_trait]
    impl Tool for EchoTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "echo",
                "回显输入",
                serde_json::json!({
                    "type": "object",
                    "properties": { "text": { "type": "string" } },
                    "required": ["text"],
                    "additionalProperties": false
                }),
                RiskLevel::Low,
                false,
            )
        }

        async fn invoke(&self, invocation: ToolInvocation, _ctx: &ToolContext) -> Result<ToolResult, ToolError> {
            let text = invocation.arguments.get("text").and_then(Value::as_str).ok_or_else(|| ToolError::Invalid("缺少 text".into()))?;
            Ok(ToolResult::success(text))
        }
    }

    fn runtime() -> ToolRuntime {
        let mut registry = ToolRegistry::new();
        registry.register(EchoTool).expect("注册成功");
        ToolRuntime::new(registry, ToolLimits::default())
    }

    #[tokio::test]
    async fn 拒绝未注册的工具() {
        let rt = runtime();
        let ctx = ToolContext::permissive(".", CancellationToken::new());
        let result = rt.execute(ToolInvocation::new("1", "nope", serde_json::json!({})), &ctx).await;
        assert!(!result.ok);
        assert_eq!(result.error_kind, Some(ToolErrorKind::UnknownTool));
    }

    #[tokio::test]
    async fn 参数校验失败时结构化回灌() {
        let rt = runtime();
        let ctx = ToolContext::permissive(".", CancellationToken::new());
        let result = rt.execute(ToolInvocation::new("1", "echo", serde_json::json!({ "nope": 1 })), &ctx).await;
        assert!(!result.ok);
        assert_eq!(result.error_kind, Some(ToolErrorKind::InvalidArguments));
        assert!(result.stderr.contains("text"));
    }

    #[tokio::test]
    async fn 正常执行返回结果() {
        let rt = runtime();
        let ctx = ToolContext::permissive(".", CancellationToken::new());
        let result = rt.execute(ToolInvocation::new("1", "echo", serde_json::json!({ "text": "你好" })), &ctx).await;
        assert!(result.ok, "stderr={}", result.stderr);
        assert_eq!(result.stdout, "你好");
    }

    #[test]
    fn 截断保留首尾且不破坏字符边界() {
        let input = "中".repeat(100);
        let (out, truncated) = truncate_output(&input, 30);
        assert!(truncated);
        assert!(out.starts_with('中'));
        assert!(out.contains("省略"));
    }
}
