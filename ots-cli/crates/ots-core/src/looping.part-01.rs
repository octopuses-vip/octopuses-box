
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::approval::{ApprovalBroker, ApprovalDecision, ApprovalRequest, ApprovalStatus, FileChange};
use crate::error::{CoreError, CoreResult};
use crate::event::{EventRecord, EventSink, LoopEvent};
use crate::generator::{Generation, GenerationRequest, Generator, StreamSink, TokenUsage};
use crate::guard::ExecGuard;
use crate::message::Message;
use crate::policy::{PolicyDecision, PolicyEngine, PolicyQuery};
use crate::skill::{USE_SKILL_TOOL_NAME, narrow_scope};
use crate::tool::{ToolCall, ToolContext, ToolErrorKind, ToolInvocation, ToolResult, ToolRuntime, ToolSpec};
use crate::verifier::{Verification, VerificationContext, Verifier};

/// 循环终止条件集合（可组合）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopPolicy {
    /// 最大迭代轮数，必须大于 0。
    pub max_iterations: u32,
    /// 质量阈值，验证分数达到即终止。
    pub quality_threshold: f64,
    /// 验证通过即终止。
    pub stop_on_verification_pass: bool,
    /// 总时长预算（秒），`None` 表示不限制。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_duration_secs: Option<u64>,
    /// 累计 token 预算，`None` 表示不限制。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_total_tokens: Option<u64>,
    /// 连续无进展轮数上限，达到即终止；`0` 表示禁用该条件。
    pub stall_patience: u32,
    /// 验证未通过时注入给模型的消息模板。
    pub continue_prompt: String,
}

impl Default for LoopPolicy {
    /// 运行预算默认值（开发者 Jan）：8 轮 / 30 分钟 / token 不限，与桌面端默认档位对齐。
    ///
    /// 时长上限用来兜住「跑飞了」，token 默认不限以免在长任务里误伤。
    fn default() -> Self {
        Self {
            max_iterations: 8,
            quality_threshold: 0.9,
            stop_on_verification_pass: true,
            max_duration_secs: Some(1800),
            max_total_tokens: None,
            stall_patience: 2,
            continue_prompt: DEFAULT_CONTINUE_PROMPT.to_string(),
        }
    }
}

/// 默认的「继续」提示模板，占位符：`{iteration}` `{score}` `{summary}` `{details}`。
pub const DEFAULT_CONTINUE_PROMPT: &str = "\
验证未通过（第 {iteration} 轮，得分 {score}）。
结论：{summary}
{details}
请阅读上述信息，修正问题后继续，不要重复之前失败的相同改动。";

/// 循环终止原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminationReason {
    /// 达到最大迭代数。
    MaxIterations,
    /// 模型声明完成，且未配置客观验证手段。
    Completed,
    /// 验证通过。
    VerificationPassed,
    /// 达到质量阈值。
    QualityThresholdMet,
    /// 时间预算耗尽。
    TimeBudgetExhausted,
    /// token 预算耗尽。
    TokenBudgetExhausted,
    /// 连续多轮无进展。
    NoProgress,
    /// 用户中断。
    UserInterrupted,
    /// 发生不可恢复错误。
    FatalError,
}

impl TerminationReason {
    /// 是否为成功终止。
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Completed | Self::VerificationPassed | Self::QualityThresholdMet)
    }

    /// 中文描述。
    pub fn label(&self) -> &'static str {
        match self {
            Self::MaxIterations => "达到最大迭代数",
            Self::Completed => "模型声明完成",
            Self::VerificationPassed => "验证通过",
            Self::QualityThresholdMet => "达到质量阈值",
            Self::TimeBudgetExhausted => "时间预算耗尽",
            Self::TokenBudgetExhausted => "token 预算耗尽",
            Self::NoProgress => "连续多轮无进展",
            Self::UserInterrupted => "用户中断",
            Self::FatalError => "发生错误",
        }
    }
}

/// 循环配置。
#[derive(Clone)]
pub struct LoopConfig {
    /// 终止条件。
    pub policy: LoopPolicy,
    /// 模型名。
    pub model: String,
    /// 采样温度。
    pub temperature: Option<f32>,
    /// 最大输出 token。
    pub max_tokens: Option<u32>,
    /// 工作区根目录。
    pub workspace: PathBuf,
    /// 系统提示词。
    pub system_prompt: String,
    /// 工具并发上限。
    pub max_tool_concurrency: usize,
    /// 模型调用重试次数。
    pub generation_retries: u32,
    /// 单次工具调用超时。
    pub tool_timeout: Duration,
    /// 执行守卫（沙箱），由调用方注入，循环本身不构造具体沙箱。
    pub guard: Arc<dyn ExecGuard>,
    /// 是否按技能声明的 `allowed_tools` 收窄本会话可用工具。
    ///
    /// 关闭后技能正文照常加载，但不再限制可用工具（`--no-skill-scope`）。
    pub skill_scope: bool,
}

impl std::fmt::Debug for LoopConfig {
    /// 手写 Debug（开发者 Jan）：guard 是 trait 对象无法 derive，改用它自己的 describe() 摘要
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopConfig")
            .field("policy", &self.policy)
            .field("model", &self.model)
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("workspace", &self.workspace)
            .field("max_tool_concurrency", &self.max_tool_concurrency)
            .field("generation_retries", &self.generation_retries)
            .field("tool_timeout", &self.tool_timeout)
            .field("skill_scope", &self.skill_scope)
            .field("guard", &self.guard.describe())
            .finish()
    }
}

impl LoopConfig {
    /// 以工作区与系统提示构造配置。
    pub fn new(workspace: impl Into<PathBuf>, model: impl Into<String>, system_prompt: impl Into<String>) -> Self {
        Self {
            policy: LoopPolicy::default(),
            model: model.into(),
            temperature: None,
            max_tokens: None,
            workspace: workspace.into(),
            system_prompt: system_prompt.into(),
            max_tool_concurrency: 4,
            generation_retries: 2,
            tool_timeout: Duration::from_secs(120),
            guard: Arc::new(crate::guard::PermissiveGuard),
            skill_scope: true,
        }
    }

    /// 指定执行守卫。
    #[must_use]
    pub fn with_guard(mut self, guard: Arc<dyn ExecGuard>) -> Self {
        self.guard = guard;
        self
    }

    /// 关闭/开启按技能收窄工具范围。
    #[must_use]
    pub fn with_skill_scope(mut self, enabled: bool) -> Self {
        self.skill_scope = enabled;
        self
    }
}

/// 循环最终结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopOutcome {
    /// 会话 id。
    pub session_id: String,
    /// 实际迭代轮数。
    pub iterations: u32,
    /// 终止原因。
    pub reason: TerminationReason,
    /// 最后一次验证结果。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<Verification>,
    /// 最终文本输出。
    pub final_message: String,
    /// 累计 token 用量。
    pub usage: TokenUsage,
    /// 被改动过的文件。
    #[serde(default)]
    pub changed_files: Vec<String>,
    /// 错误信息（`FatalError` 时存在）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 耗时毫秒。
    pub duration_ms: u64,
}

impl LoopOutcome {
    /// 是否成功。
    pub fn is_success(&self) -> bool {
        self.reason.is_success()
    }
}

/// Agent 循环。
pub struct AgentLoop {
    generator: Arc<dyn Generator>,
    verifier: Arc<dyn Verifier>,
    policy: Arc<dyn PolicyEngine>,
    broker: Arc<dyn ApprovalBroker>,
    runtime: Arc<ToolRuntime>,
    sink: Arc<dyn EventSink>,
    config: LoopConfig,
}

