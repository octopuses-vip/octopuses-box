//! SSE 行解析与流式增量累积。
//!
//! 只依赖「按行分割」这一条 SSE 基础规则（OpenAI 的每条事件都在单行内），
//! 因此不引入通用 SSE 库：解析逻辑可以完全用纯函数测试。

use ots_core::{Generation, StreamSink, ToolCall};
use serde_json::Value;

use crate::error::LlmError;
use crate::wire::parse_usage;

/// 流结束标记。
pub const DONE_MARKER: &str = "[DONE]";

/// 从一行文本中取出 `data:` 载荷。
///
/// 返回 `None` 表示该行不是数据行（空行、`:` 注释、`event:` 字段等）。
pub fn data_payload(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\n', '\r']);
    let rest = line.strip_prefix("data:")?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// 流式累积中的工具调用分片。
///
/// OpenAI 会按 `index` 分片下发同一个调用：`id` 与 `name` 通常只在首个分片出现，
/// `arguments` 则是逐段拼接的 JSON 文本。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartialToolCall {
    /// 分片序号。
    pub index: u64,
    /// 调用 id。
    pub id: String,
    /// 工具名。
    pub name: String,
    /// 尚未解析的参数片段。
    pub arguments: String,
}

/// 流式增量累积器。
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    /// 正文。
    pub content: String,
    /// 推理（思维链）文本。
    pub reasoning: String,
    /// 工具调用分片。
    pub tool_calls: Vec<PartialToolCall>,
    /// 用量。
    pub usage: ots_core::TokenUsage,
    /// 结束原因。
    pub finish_reason: Option<String>,
    /// 是否已经产生过任何增量（用于判断是否还能安全重试）。
    pub has_output: bool,
}

impl StreamAccumulator {
    /// 新建空累积器。
    pub fn new() -> Self {
        Self::default()
    }

    /// 消费一个流式数据块，并把增量回调给 `sink`。
    ///
    /// # Errors
    /// 数据块不是合法的 Chat Completions 分片时返回 [`LlmError::Protocol`]。
    pub fn apply(&mut self, chunk: &Value, sink: &dyn StreamSink) -> Result<(), LlmError> {
        if let Some(error) = chunk.get("error").filter(|value| !value.is_null()) {
            return Err(LlmError::Protocol(format!("服务端返回错误块: {error}")));
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            self.usage = parse_usage(usage);
        }
        let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
            return Err(LlmError::Protocol(format!("缺少 choices 字段: {chunk}")));
        };
        // 仅携带 usage 的收尾分片，choices 为空数组。
        let Some(choice) = choices.first() else {
            return Ok(());
        };

        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    self.content.push_str(text);
                    self.has_output = true;
                    sink.on_delta(text);
                }
            }
            let reasoning = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str);
            if let Some(text) = reasoning {
                if !text.is_empty() {
                    self.reasoning.push_str(text);
                    self.has_output = true;
                    sink.on_reasoning(text);
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.merge_tool_call(call);
                }
                self.has_output = true;
            }
        }

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        Ok(())
    }

    /// 按 `index` 合并一个工具调用分片。
    pub fn merge_tool_call(&mut self, value: &Value) {
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(self.tool_calls.len() as u64);
        if self.tool_calls.iter().all(|call| call.index != index) {
            self.tool_calls.push(PartialToolCall { index, ..PartialToolCall::default() });
        }
        let Some(slot) = self.tool_calls.iter_mut().find(|call| call.index == index) else {
            return;
        };
        if slot.id.is_empty() {
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                slot.id = id.to_string();
            }
        }
        if let Some(function) = value.get("function") {
            if slot.name.is_empty() {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    slot.name = name.to_string();
                }
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                slot.arguments.push_str(arguments);
            }
        }
    }

    /// 收束为一次完整的生成结果。
    ///
    /// # Errors
    /// 工具调用缺少名称，或参数片段不是合法 JSON 时返回 [`LlmError::Protocol`]。
    pub fn into_generation(self) -> Result<Generation, LlmError> {
        let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
        for (position, partial) in self.tool_calls.into_iter().enumerate() {
            if partial.name.trim().is_empty() {
                return Err(LlmError::Protocol(format!(
                    "第 {} 个工具调用缺少 function.name（原始参数: {}）",
                    position + 1,
                    partial.arguments
                )));
            }
            let arguments = if partial.arguments.trim().is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str(&partial.arguments).map_err(|err| {
                    LlmError::Protocol(format!(
                        "工具 `{}` 的参数不是合法 JSON（{err}）: {}",
                        partial.name, partial.arguments
                    ))
                })?
            };
            let id = if partial.id.is_empty() { format!("call_{position}") } else { partial.id };
            tool_calls.push(ToolCall::new(id, partial.name, arguments));
        }

        Ok(Generation { content: self.content, tool_calls, usage: self.usage, finish_reason: self.finish_reason })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct CapturingSink {
        deltas: Mutex<String>,
        reasoning: Mutex<String>,
    }

    impl StreamSink for CapturingSink {
        fn on_delta(&self, delta: &str) {
            self.deltas.lock().expect("锁未中毒").push_str(delta);
        }

        fn on_reasoning(&self, delta: &str) {
            self.reasoning.lock().expect("锁未中毒").push_str(delta);
        }
    }

    #[test]
    fn 解析data前缀与中英文() {
        assert_eq!(data_payload("data: {\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(data_payload("data:{\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(data_payload("data: [DONE]"), Some("[DONE]"));
        assert_eq!(data_payload(": keep-alive"), None);
        assert_eq!(data_payload("event: message"), None);
        assert_eq!(data_payload(""), None);
    }

    #[test]
    fn 正文增量累积并回调() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        accumulator
            .apply(&serde_json::json!({ "choices": [{ "delta": { "content": "你" } }] }), &sink)
            .expect("解析成功");
        accumulator
            .apply(&serde_json::json!({ "choices": [{ "delta": { "content": "好" } }] }), &sink)
            .expect("解析成功");
        assert_eq!(sink.deltas.lock().expect("锁未中毒").as_str(), "你好");
        assert!(accumulator.has_output);
        let generation = accumulator.into_generation().expect("收束成功");
        assert_eq!(generation.content, "你好");
        assert!(generation.tool_calls.is_empty());
    }

    #[test]
    fn 推理增量走单独回调() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        accumulator
            .apply(&serde_json::json!({ "choices": [{ "delta": { "reasoning_content": "先看" } }] }), &sink)
            .expect("解析成功");
        assert_eq!(sink.reasoning.lock().expect("锁未中毒").as_str(), "先看");
        assert!(accumulator.content.is_empty());
    }

    #[test]
    fn 工具调用按index拼接参数() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        for chunk in [
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "id": "call_1", "type": "function", "function": { "name": "shell", "arguments": "" } }
            ] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "{\"comm" } }
            ] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "and\":\"ls\"}" } }
            ] } }] }),
        ] {
            accumulator.apply(&chunk, &sink).expect("解析成功");
        }
        let generation = accumulator.into_generation().expect("收束成功");
        assert_eq!(generation.tool_calls.len(), 1);
        assert_eq!(generation.tool_calls[0].id, "call_1");
        assert_eq!(generation.tool_calls[0].name, "shell");
        assert_eq!(generation.tool_calls[0].arguments, serde_json::json!({ "command": "ls" }));
    }

    #[test]
    fn 多个工具调用按index各自独立() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        accumulator
            .apply(
                &serde_json::json!({ "choices": [{ "delta": { "tool_calls": [
                    { "index": 0, "id": "a", "function": { "name": "read_file", "arguments": "{}" } },
                    { "index": 1, "id": "b", "function": { "name": "shell", "arguments": "{\"command\":\"pwd\"}" } }
                ] } }] }),
                &sink,
            )
            .expect("解析成功");
        let generation = accumulator.into_generation().expect("收束成功");
        assert_eq!(generation.tool_calls.len(), 2);
        assert_eq!(generation.tool_calls[1].name, "shell");
        assert_eq!(generation.tool_calls[1].arguments["command"], "pwd");
    }

    #[test]
    fn 收尾分片携带用量与结束原因() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        accumulator
            .apply(
                &serde_json::json!({ "choices": [], "usage": { "prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10 } }),
                &sink,
            )
            .expect("解析成功");
        accumulator
            .apply(
                &serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
                &sink,
            )
            .expect("解析成功");
        let generation = accumulator.into_generation().expect("收束成功");
        assert_eq!(generation.usage.total_tokens, 10);
        assert_eq!(generation.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn 缺少choices时视为协议错误() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        let err = accumulator.apply(&serde_json::json!({ "foo": 1 }), &sink).expect_err("应报错");
        assert!(matches!(err, LlmError::Protocol(_)));
    }

    #[test]
    fn 参数不是合法json时收束失败() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        accumulator
            .apply(
                &serde_json::json!({ "choices": [{ "delta": { "tool_calls": [
                    { "index": 0, "id": "a", "function": { "name": "shell", "arguments": "{不是 JSON" } }
                ] } }] }),
                &sink,
            )
            .expect("解析成功");
        let err = accumulator.into_generation().expect_err("应报错");
        assert!(err.to_string().contains("不是合法 JSON"), "{err}");
    }

    #[test]
    fn 缺少工具名时收束失败() {
        let mut accumulator = StreamAccumulator::new();
        let sink = CapturingSink::default();
        accumulator
            .apply(
                &serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{}" } }] } }] }),
                &sink,
            )
            .expect("解析成功");
        let err = accumulator.into_generation().expect_err("应报错");
        assert!(err.to_string().contains("缺少 function.name"), "{err}");
    }
}
