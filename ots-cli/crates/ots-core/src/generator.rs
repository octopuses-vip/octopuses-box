//! 模型生成抽象。
//!
//! `ots-core` 只定义 [`Generator`] 契约与流式回调 [`StreamSink`]；
//! 真实的 OpenAI 兼容 HTTP 实现在 `ots-llm`。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::CoreResult;
use crate::message::Message;
use crate::tool::{ToolCall, ToolSpec};

/// 一次生成请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationRequest {
    /// 模型名。
    pub model: String,
    /// 完整消息上下文。
    pub messages: Vec<Message>,
    /// 可用工具。
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    /// 采样温度。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// 最大输出 token。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

/// token 用量。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    /// 输入 token。
    #[serde(default)]
    pub prompt_tokens: u64,
    /// 输出 token。
    #[serde(default)]
    pub completion_tokens: u64,
    /// 合计 token。
    #[serde(default)]
    pub total_tokens: u64,
}

impl TokenUsage {
    /// 累加用量。
    pub fn accumulate(&mut self, other: &Self) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.total_tokens += other.total_tokens;
    }
}

/// 一次生成结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Generation {
    /// 文本内容。
    #[serde(default)]
    pub content: String,
    /// 模型请求的工具调用。
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// token 用量。
    #[serde(default)]
    pub usage: TokenUsage,
    /// 结束原因（如 `stop` / `tool_calls` / `length`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

impl Generation {
    /// 无工具调用的纯文本结果。
    pub fn text(content: impl Into<String>) -> Self {
        Self { content: content.into(), tool_calls: Vec::new(), usage: TokenUsage::default(), finish_reason: Some("stop".into()) }
    }

    /// 携带工具调用的结果。
    pub fn with_tool_calls(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self { content: content.into(), tool_calls, usage: TokenUsage::default(), finish_reason: Some("tool_calls".into()) }
    }
}

/// 流式增量回调。
///
/// 实现必须是 `Send + Sync`，因为生成过程可能在多线程运行时中推进。
pub trait StreamSink: Send + Sync {
    /// 收到一段正文增量。
    fn on_delta(&self, delta: &str);

    /// 收到一段推理（思维链）增量，默认忽略。
    fn on_reasoning(&self, _delta: &str) {}
}

/// 忽略所有增量的空实现。
#[derive(Debug, Clone, Copy, Default)]
pub struct NullSink;

impl StreamSink for NullSink {
    /// 默认的增量回调（开发者 Jan）：不做任何事，让实现方只关心自己需要的回调。
    fn on_delta(&self, _delta: &str) {}
}

/// 模型生成器契约。
#[async_trait]
pub trait Generator: Send + Sync {
    /// 实现名（用于日志与审计）。
    fn name(&self) -> &str;

    /// 模型名。
    fn model(&self) -> &str;

    /// 执行一次生成，过程中通过 `sink` 回调流式增量。
    ///
    /// # Errors
    /// 网络错误、协议错误或服务端返回错误时返回 [`crate::CoreError::Generation`]。
    async fn generate(&self, request: GenerationRequest, sink: &dyn StreamSink) -> CoreResult<Generation>;
}
