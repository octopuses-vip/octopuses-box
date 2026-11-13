//! OpenAI 兼容的 Chat Completions 客户端。
//!
//! 只实现「真正跑得起来」的接入路径：HTTP 请求、SSE 流式解析、增量回调、
//! 用量统计与指数退避重试。不提供任何模拟实现——`cargo test` 全离线可用，
//! 需要真实模型时由用户配置 `llm.base_url` / API Key 即可。

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use futures_util::StreamExt;
use ots_core::{CoreResult, Generation, GenerationRequest, Generator, StreamSink, ToolCall};
use serde_json::{json, Map, Value};

use crate::config::{LlmClientConfig, CONNECT_TIMEOUT, ERROR_BODY_LIMIT};
use crate::error::LlmError;
use crate::sse::{data_payload, StreamAccumulator, DONE_MARKER};
use crate::wire::{messages_to_wire, parse_usage, tools_to_wire};

/// 基于 OpenAI Chat Completions 协议的生成器。
pub struct OpenAiCompatGenerator {
    client: reqwest::Client,
    config: LlmClientConfig,
}

impl OpenAiCompatGenerator {
    /// 以配置构造生成器。
    pub fn new(config: LlmClientConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self { client, config }
    }

    /// 当前配置。
    pub fn config(&self) -> &LlmClientConfig {
        &self.config
    }

    /// 构造请求体。
    ///
    /// 该方法是纯函数，便于在不发请求的前提下验证报文结构。
    pub fn build_request_body(&self, request: &GenerationRequest) -> Value {
        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(request.model.clone()));
        body.insert("messages".to_string(), messages_to_wire(&request.messages));
        body.insert("stream".to_string(), Value::Bool(self.config.stream));
        if self.config.stream {
            // 流式响应默认不返回用量，必须显式索取。
            body.insert("stream_options".to_string(), json!({ "include_usage": true }));
        }
        if let Some(tools) = tools_to_wire(request) {
            body.insert("tools".to_string(), tools);
            body.insert("tool_choice".to_string(), Value::String("auto".to_string()));
        }
        if let Some(temperature) = request.temperature.or(self.config.temperature).filter(|value| value.is_finite()) {
            body.insert("temperature".to_string(), json_number_f32(temperature));
        }
        if let Some(max_tokens) = request.max_tokens.or(self.config.max_tokens) {
            body.insert("max_tokens".to_string(), json!(max_tokens));
        }
        for (key, value) in &self.config.extra_body {
            body.insert(key.clone(), value.clone());
        }
        Value::Object(body)
    }

    /// 构造一次请求（开发者 Jan）：带上鉴权、组织与额外请求头。
    ///
    /// 密钥按「显式配置优先、其次读环境变量」取；取不到就报错而不是发一个无鉴权请求，
    /// 后者只会得到一个含义模糊的 401，不如在本地就把原因讲清楚。
    fn build_request(&self, body: &Value) -> Result<reqwest::RequestBuilder, LlmError> {
        let api_key = self
            .config
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| LlmError::MissingApiKey(self.config.api_key_env.clone()))?;

        let mut builder = self
            .client
            .post(self.config.endpoint())
            .header("authorization", format!("Bearer {api_key}"))
            .json(body);
        if let Some(organization) = &self.config.organization {
            builder = builder.header("openai-organization", organization.as_str());
        }
        for (key, value) in &self.config.extra_headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
        Ok(builder)
    }

    /// 发起一次请求并解析响应（不含重试）。
    async fn attempt(&self, body: &Value, sink: &dyn StreamSink, emitted: &AtomicBool) -> Result<Generation, LlmError> {
        let response = self
            .build_request(body)?
            .send()
            .await
            .map_err(|err| LlmError::Transport(err.to_string()))?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(LlmError::Status { status: status.as_u16(), body: truncate(&text, ERROR_BODY_LIMIT) });
        }

        // 有些网关会忽略 stream 参数直接返回整段 JSON，此时按非流式解析，
        // 既不必重发请求，也不会把 JSON 误当成 SSE。
        let is_event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/event-stream"));

        if self.config.stream && is_event_stream {
            self.read_stream(response, sink, emitted).await
        } else {
            let text = response.text().await.map_err(|err| LlmError::Transport(err.to_string()))?;
            read_blocking(&text, sink)
        }
    }

    /// 逐行读取 SSE 响应。
    async fn read_stream(
        &self,
        response: reqwest::Response,
        sink: &dyn StreamSink,
        emitted: &AtomicBool,
    ) -> Result<Generation, LlmError> {
        let mut accumulator = StreamAccumulator::new();
        let mut buffer: Vec<u8> = Vec::new();
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| LlmError::Transport(err.to_string()))?;
            buffer.extend_from_slice(&chunk);
            // 按字节寻找换行：多字节字符被网络分片截断时，剩余字节会留在缓冲区里等下一片补齐。
            while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = buffer.drain(..=position).collect();
                if absorb_line(&String::from_utf8_lossy(&line), &mut accumulator, sink, emitted)? {
                    return accumulator.into_generation();
                }
            }
        }
        if !buffer.is_empty() {
            let tail = String::from_utf8_lossy(&buffer).to_string();
            absorb_line(&tail, &mut accumulator, sink, emitted)?;
        }
        accumulator.into_generation()
    }
}

#[async_trait]
impl Generator for OpenAiCompatGenerator {
    /// 提供方标识（开发者 Jan）：固定为 openai-compatible，对应 OpenAI 风格的 chat/completions 协议
    fn name(&self) -> &str {
        "openai-compatible"
    }

    /// 当前使用的模型名（开发者 Jan）：来自配置，用于日志与事件记录
    fn model(&self) -> &str {
        &self.config.model
    }

    /// 发起一次生成（开发者 Jan），带失败重试。
    ///
    /// 重试前先看 emitted 标志：若已经向前端推过增量内容再重试，
    /// 用户会看到重复或交错的正文，因此这种情况不再重试，直接把错误抛出去。
    /// 重试次数取自配置的 max_retries，每次失败都记录原因，便于排查是限流还是网络问题。
    async fn generate(&self, request: GenerationRequest, sink: &dyn StreamSink) -> CoreResult<Generation> {
        let body = self.build_request_body(&request);
        let mut attempt: u32 = 0;
        loop {
            let emitted = AtomicBool::new(false);
            match self.attempt(&body, sink, &emitted).await {
                Ok(generation) => return Ok(generation),
                Err(err) => {
                    let partial = emitted.load(Ordering::Relaxed);
                    if attempt >= self.config.max_retries || !err.is_retryable() || partial {
                        if partial && err.is_retryable() {
                            tracing::warn!("已向终端输出部分内容，不再重试: {err}");
                        }
                        return Err(err.into());
                    }
                    let delay = self.config.retry_delay(attempt);
                    attempt += 1;
                    tracing::warn!("模型请求失败，第 {attempt} 次重试（{} ms 后）: {err}", delay.as_millis());
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
}

/// 处理一行 SSE 文本，返回是否遇到 `[DONE]`。
fn absorb_line(
    line: &str,
    accumulator: &mut StreamAccumulator,
    sink: &dyn StreamSink,
    emitted: &AtomicBool,
) -> Result<bool, LlmError> {
    let Some(payload) = data_payload(line) else {
        return Ok(false);
    };
    let payload = payload.trim();
    if payload.is_empty() {
        return Ok(false);
    }
    if payload == DONE_MARKER {
        return Ok(true);
    }
    let value: Value = serde_json::from_str(payload)
        .map_err(|err| LlmError::Protocol(format!("无法解析数据块（{err}）: {}", truncate(payload, ERROR_BODY_LIMIT))))?;
    accumulator.apply(&value, sink)?;
    if accumulator.has_output {
        emitted.store(true, Ordering::Relaxed);
    }
    Ok(false)
}

/// 解析「服务端忽略 stream 参数」时返回的整段 JSON。
fn read_blocking(text: &str, sink: &dyn StreamSink) -> Result<Generation, LlmError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|err| LlmError::Protocol(format!("无法解析响应（{err}）: {}", truncate(text, ERROR_BODY_LIMIT))))?;
    if let Some(error) = value.get("error").filter(|value| !value.is_null()) {
        return Err(LlmError::Protocol(format!("服务端返回错误: {error}")));
    }

    let null = Value::Null;
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| LlmError::Protocol(format!("响应缺少 choices: {}", truncate(text, ERROR_BODY_LIMIT))))?;
    let message = choice.get("message").unwrap_or(&null);

    let content = message.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
    let reasoning = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut tool_calls = Vec::new();

    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for (position, call) in calls.iter().enumerate() {
            let function = call.get("function").unwrap_or(&null);
            let name = function.get("name").and_then(Value::as_str).unwrap_or_default();
            if name.trim().is_empty() {
                return Err(LlmError::Protocol(format!("第 {} 个工具调用缺少 function.name", position + 1)));
            }
            let raw = match function.get("arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => "{}".to_string(),
            };
            let arguments: Value = serde_json::from_str(&raw)
                .map_err(|err| LlmError::Protocol(format!("工具 `{name}` 的参数不是合法 JSON（{err}）: {raw}")))?;
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{position}"));
            tool_calls.push(ToolCall::new(id, name, arguments));
        }
    }

    if !content.is_empty() {
        sink.on_delta(&content);
    }
    if !reasoning.is_empty() {
        sink.on_reasoning(reasoning);
    }

    Ok(Generation {
        content,
        tool_calls,
        usage: value.get("usage").map(parse_usage).unwrap_or_default(),
        finish_reason: choice.get("finish_reason").and_then(Value::as_str).map(str::to_string),
    })
}

/// 把 f32 采样参数写成 JSON 数字。
///
/// `serde_json` 在编码 f32 时会先提升为 f64，直接转换会写出 `0.20000000298023224`
/// 这类噪声；因此先取 f32 的最短十进制表示再解析回数字，保证报文中就是 `0.2`。
fn json_number_f32(value: f32) -> Value {
    serde_json::from_str::<Value>(&value.to_string()).unwrap_or_else(|_| json!(f64::from(value)))
}

/// 截断过长的错误信息，避免把整个响应体打进日志。
fn truncate(text: &str, limit: usize) -> String {
    ots_core::truncate_output(text, limit).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::{GenerationRequest, Message, RiskLevel, ToolSpec};

    fn generator() -> OpenAiCompatGenerator {
        OpenAiCompatGenerator::new(
            LlmClientConfig::new("http://127.0.0.1:1234/v1", "test-model")
                .with_api_key(Some("sk-test".to_string())),
        )
    }

    fn request() -> GenerationRequest {
        GenerationRequest {
            model: "test-model".to_string(),
            messages: vec![Message::system("你是助手"), Message::user("你好")],
            tools: Vec::new(),
            temperature: Some(0.2),
            max_tokens: Some(128),
        }
    }

    #[test]
    fn 请求体包含流式用量与采样参数() {
        let body = generator().build_request_body(&request());
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(body.get("tools").is_none(), "无工具时不应出现 tools 字段");
    }

    #[test]
    fn 有工具时附带tool_choice() {
        let mut req = request();
        req.tools.push(ToolSpec::new("read_file", "读文件", json!({ "type": "object" }), RiskLevel::Low, false));
        let body = generator().build_request_body(&req);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn 额外请求体字段透传() {
        let mut config = LlmClientConfig::new("http://127.0.0.1:1234/v1", "m");
        config.extra_body.insert("top_p".to_string(), json!(0.9));
        let generator = OpenAiCompatGenerator::new(config);
        let body = generator.build_request_body(&request());
        assert_eq!(body["top_p"], 0.9);
    }

    #[test]
    fn 请求级参数覆盖配置级参数() {
        let mut config = LlmClientConfig::new("http://127.0.0.1:1234/v1", "m");
        config.temperature = Some(0.9);
        let generator = OpenAiCompatGenerator::new(config);
        let body = generator.build_request_body(&request());
        assert_eq!(body["temperature"], 0.2);
    }

    #[tokio::test]
    async fn 缺少api密钥时给出明确错误() {
        let generator = OpenAiCompatGenerator::new(LlmClientConfig::new("http://127.0.0.1:1/v1", "m"));
        let err = generator
            .generate(request(), &ots_core::NullStreamSink)
            .await
            .expect_err("应报错");
        assert!(err.to_string().contains("API Key"), "{err}");
    }

    #[test]
    fn 非流式响应可被解析() {
        let sink = ots_core::NullStreamSink;
        let text = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "完成",
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": { "name": "shell", "arguments": "{\"command\":\"ls\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 4 }
        })
        .to_string();

        let generation = read_blocking(&text, &sink).expect("解析成功");
        assert_eq!(generation.content, "完成");
        assert_eq!(generation.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(generation.usage.total_tokens, 7);
        assert_eq!(generation.tool_calls[0].arguments["command"], "ls");
    }

    #[test]
    fn 非流式错误响应被拒绝() {
        let sink = ots_core::NullStreamSink;
        let err = read_blocking(&json!({ "error": { "message": "rate limited" } }).to_string(), &sink).expect_err("应报错");
        assert!(err.to_string().contains("rate limited"), "{err}");
    }

    #[test]
    fn sse行解析遇到done即结束() {
        let accumulator = StreamAccumulator::new();
        let sink = ots_core::NullStreamSink;
        let emitted = AtomicBool::new(false);
        let mut accumulator = accumulator;
        assert!(absorb_line("data: [DONE]", &mut accumulator, &sink, &emitted).expect("解析成功"));
        assert!(!absorb_line("", &mut accumulator, &sink, &emitted).expect("解析成功"));
        assert!(!absorb_line(": ping", &mut accumulator, &sink, &emitted).expect("解析成功"));
    }
}
