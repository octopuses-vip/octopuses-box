//! 领域层错误类型。
//!
//! 领域层统一使用 [`CoreError`]，外层 crate 可用 `anyhow` 包装为应用级错误。

use thiserror::Error;

/// 领域层错误。
#[derive(Debug, Error)]
pub enum CoreError {
    /// 请求了未注册的工具。
    #[error("工具未注册: {0}")]
    UnknownTool(String),

    /// 工具参数未通过 JSON Schema 校验。
    #[error("工具 {tool} 参数校验失败: {reason}")]
    InvalidArguments {
        /// 工具名。
        tool: String,
        /// 校验失败原因。
        reason: String,
    },

    /// 工具执行失败。
    #[error("工具 {tool} 执行失败: {reason}")]
    ToolFailure {
        /// 工具名。
        tool: String,
        /// 失败原因。
        reason: String,
    },

    /// 工具执行超时。
    #[error("工具 {tool} 执行超时（{timeout_ms} ms）")]
    ToolTimeout {
        /// 工具名。
        tool: String,
        /// 超时毫秒数。
        timeout_ms: u64,
    },

    /// 模型调用失败（临时故障，重试可能成功）。
    #[error("模型调用失败: {0}")]
    Generation(String),

    /// 模型调用失败且重试无意义（鉴权失败、请求参数非法、协议不兼容等）。
    #[error("模型调用失败（不可重试）: {0}")]
    GenerationRefused(String),

    /// 策略或沙箱拒绝该操作。
    #[error("操作被策略拒绝: {0}")]
    PolicyDenied(String),

    /// 人工审批拒绝该操作。
    #[error("操作未获审批: {0}")]
    ApprovalDenied(String),

    /// 操作被用户取消。
    #[error("操作已取消")]
    Cancelled,

    /// 配置非法。
    #[error("配置错误: {0}")]
    Config(String),

    /// JSON 处理失败。
    #[error("JSON 处理失败: {0}")]
    Json(#[from] serde_json::Error),

    /// 其它未归类错误。
    #[error("{0}")]
    Other(String),
}

impl CoreError {
    /// 便捷构造 [`CoreError::Other`]。
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }

    /// 是否为「取消」类错误。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }

    /// 该错误是否值得重试。
    ///
    /// 只有「外部环境的临时故障」值得重试；参数非法、鉴权失败、策略与审批拒绝、
    /// 用户取消都属于确定性结果，重试只会白白浪费时间并掩盖真正的原因。
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::ToolTimeout { .. } | Self::Generation(_) | Self::Json(_) | Self::Other(_) => true,
            Self::UnknownTool(_)
            | Self::InvalidArguments { .. }
            | Self::ToolFailure { .. }
            | Self::GenerationRefused(_)
            | Self::PolicyDenied(_)
            | Self::ApprovalDenied(_)
            | Self::Cancelled
            | Self::Config(_) => false,
        }
    }
}

/// 领域层结果别名。
pub type CoreResult<T> = Result<T, CoreError>;
