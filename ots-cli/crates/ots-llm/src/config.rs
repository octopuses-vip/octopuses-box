//! 客户端配置。
//!
//! `ots-llm` 刻意不依赖 `ots-config`：配置 schema 属于应用层，
//! 客户端只接收一组扁平的连接参数，由 CLI 这个「组装根」负责映射。
//! 这样本 crate 可以在没有任何配置文件的情况下被独立使用与测试。

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

/// 默认请求超时（含流式读取全过程）。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

/// 建立连接的超时，避免网络不可达时长时间挂起。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// 首次重试前的等待时长。
pub const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// 重试等待的上限。
pub const RETRY_MAX_DELAY: Duration = Duration::from_secs(8);

/// 单条错误信息中保留的响应体长度。
pub const ERROR_BODY_LIMIT: usize = 2048;

/// OpenAI 兼容客户端配置。
#[derive(Debug, Clone)]
pub struct LlmClientConfig {
    /// API 基础地址，不含 `/chat/completions`。
    pub base_url: String,
    /// 模型名。
    pub model: String,
    /// API Key；`None` 表示尚未解析到。
    pub api_key: Option<String>,
    /// API Key 所在的环境变量名，仅在报错提示中使用。
    pub api_key_env: String,
    /// 组织标识，填写后会发送 `OpenAI-Organization`。
    pub organization: Option<String>,
    /// 采样温度。
    pub temperature: Option<f32>,
    /// 最大输出 token。
    pub max_tokens: Option<u32>,
    /// 单次请求超时。
    pub timeout: Duration,
    /// 是否请求流式响应。
    pub stream: bool,
    /// 失败重试次数（不含首次尝试）。
    pub max_retries: u32,
    /// 额外请求头。
    pub extra_headers: BTreeMap<String, String>,
    /// 透传给服务端的额外请求体字段。
    pub extra_body: BTreeMap<String, Value>,
}

impl Default for LlmClientConfig {
    /// 模型客户端默认配置（开发者 Jan）：OpenAI 兼容端点、开启流式、重试 3 次。
    ///
    /// model 留空是刻意的：模型名必须由使用者显式指定，猜一个默认值只会在运行时才暴露问题。
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            model: String::new(),
            api_key: None,
            api_key_env: "OPENAI_API_KEY".to_string(),
            organization: None,
            temperature: None,
            max_tokens: None,
            timeout: DEFAULT_TIMEOUT,
            stream: true,
            max_retries: 3,
            extra_headers: BTreeMap::new(),
            extra_body: BTreeMap::new(),
        }
    }
}

impl LlmClientConfig {
    /// 以基础地址与模型名构造配置，其余字段取默认值。
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self { base_url: base_url.into(), model: model.into(), ..Default::default() }
    }

    /// 指定 API Key。
    #[must_use]
    pub fn with_api_key(mut self, api_key: Option<String>) -> Self {
        self.api_key = api_key;
        self
    }

    /// 指定 API Key 的环境变量名。
    #[must_use]
    pub fn with_api_key_env(mut self, env: impl Into<String>) -> Self {
        self.api_key_env = env.into();
        self
    }

    /// 指定组织标识。
    #[must_use]
    pub fn with_organization(mut self, organization: Option<String>) -> Self {
        self.organization = organization;
        self
    }

    /// 指定采样参数。
    #[must_use]
    pub fn with_sampling(mut self, temperature: Option<f32>, max_tokens: Option<u32>) -> Self {
        self.temperature = temperature;
        self.max_tokens = max_tokens;
        self
    }

    /// 指定超时（秒）。
    #[must_use]
    pub fn with_timeout_secs(mut self, secs: u64) -> Self {
        self.timeout = Duration::from_secs(secs.max(1));
        self
    }

    /// 指定是否使用流式响应。
    #[must_use]
    pub fn with_stream(mut self, stream: bool) -> Self {
        self.stream = stream;
        self
    }

    /// 指定重试次数。
    #[must_use]
    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    /// 指定额外请求头与额外请求体字段。
    #[must_use]
    pub fn with_extras(
        mut self,
        headers: BTreeMap<String, String>,
        body: BTreeMap<String, Value>,
    ) -> Self {
        self.extra_headers = headers;
        self.extra_body = body;
        self
    }

    /// `chat/completions` 端点，自动去掉 `base_url` 末尾多余的 `/`。
    pub fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }

    /// 第 `attempt` 次重试前等待的时长：指数增长并封顶。
    pub fn retry_delay(&self, attempt: u32) -> Duration {
        let factor = 1u32 << attempt.min(5);
        (RETRY_BASE_DELAY * factor).min(RETRY_MAX_DELAY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 端点自动去掉末尾斜杠() {
        assert_eq!(LlmClientConfig::new("https://api.openai.com/v1/", "m").endpoint(), "https://api.openai.com/v1/chat/completions");
        assert_eq!(LlmClientConfig::new("http://127.0.0.1:8080/v1", "m").endpoint(), "http://127.0.0.1:8080/v1/chat/completions");
    }

    #[test]
    fn 重试等待呈指数增长且封顶() {
        let config = LlmClientConfig::default();
        assert_eq!(config.retry_delay(0), RETRY_BASE_DELAY);
        assert_eq!(config.retry_delay(1), RETRY_BASE_DELAY * 2);
        assert_eq!(config.retry_delay(2), RETRY_BASE_DELAY * 4);
        assert_eq!(config.retry_delay(20), RETRY_MAX_DELAY);
    }

    #[test]
    fn 超时至少一秒() {
        assert_eq!(LlmClientConfig::default().with_timeout_secs(0).timeout, Duration::from_secs(1));
    }
}
