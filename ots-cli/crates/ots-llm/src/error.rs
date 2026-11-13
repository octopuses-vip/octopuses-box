//! 模型接入层错误。

use ots_core::CoreError;
use thiserror::Error;

/// 模型接入错误。
#[derive(Debug, Error)]
pub enum LlmError {
    /// 缺少 API Key。
    #[error("缺少 API Key：请设置环境变量 {0}，或在配置中填写 llm.api_key")]
    MissingApiKey(String),

    /// 请求体构造失败。
    #[error("请求构造失败: {0}")]
    Request(String),

    /// 传输层失败（连接失败、超时、读取中断）。
    #[error("网络请求失败: {0}")]
    Transport(String),

    /// 服务端返回非 2xx。
    #[error("服务端返回 {status}: {body}")]
    Status {
        /// HTTP 状态码。
        status: u16,
        /// 响应体（已截断）。
        body: String,
    },

    /// 响应不符合 OpenAI Chat Completions 协议。
    #[error("响应格式错误: {0}")]
    Protocol(String),
}

impl LlmError {
    /// 是否值得重试：网络抖动、限流与服务端临时故障。
    ///
    /// 4xx 中的参数错误、鉴权失败等不会因为重试而好转，因此明确排除。
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Status { status, .. } => matches!(*status, 408 | 409 | 425 | 429 | 500..=599),
            Self::MissingApiKey(_) | Self::Request(_) | Self::Protocol(_) => false,
        }
    }
}

impl From<LlmError> for CoreError {
    /// 转换时保留「可否重试」这一信息，避免上层（循环）对确定性失败反复重试。
    fn from(value: LlmError) -> Self {
        if value.is_retryable() {
            CoreError::Generation(value.to_string())
        } else {
            CoreError::GenerationRefused(value.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 网络与服务端故障可重试() {
        assert!(LlmError::Transport("连接被重置".into()).is_retryable());
        assert!(LlmError::Status { status: 429, body: String::new() }.is_retryable());
        assert!(LlmError::Status { status: 503, body: String::new() }.is_retryable());
    }

    #[test]
    fn 参数与鉴权错误不重试() {
        assert!(!LlmError::Status { status: 400, body: String::new() }.is_retryable());
        assert!(!LlmError::Status { status: 401, body: String::new() }.is_retryable());
        assert!(!LlmError::MissingApiKey("OPENAI_API_KEY".into()).is_retryable());
        assert!(!LlmError::Protocol("缺少 choices".into()).is_retryable());
    }

    #[test]
    fn 转换为领域错误时保留信息() {
        let err: CoreError = LlmError::Status { status: 401, body: "invalid key".into() }.into();
        assert!(err.to_string().contains("401"));
        assert!(matches!(err, CoreError::GenerationRefused(_)));
    }

    #[test]
    fn 转换后仍然区分可否重试() {
        let retryable: CoreError = LlmError::Transport("连接被重置".into()).into();
        assert!(retryable.is_retryable());
        let fatal: CoreError = LlmError::MissingApiKey("OPENAI_API_KEY".into()).into();
        assert!(!fatal.is_retryable());
    }
}
