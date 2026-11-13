//! 领域消息 → OpenAI Chat Completions 报文。
//!
//! 领域模型 [`ots_core::Message`] 以「结构化 JSON」保存工具调用参数，
//! 而 OpenAI 协议要求 `function.arguments` 是**字符串**。转换集中在本模块，
//! 使循环内核与工具系统都不必感知这一细节。

use ots_core::{GenerationRequest, Message, Role, ToolCall, TokenUsage};
use serde_json::{json, Map, Value};

/// 把消息序列转换为请求体的 `messages` 字段。
pub fn messages_to_wire(messages: &[Message]) -> Value {
    Value::Array(messages.iter().map(message_to_wire).collect())
}

/// 单条消息转换。
pub fn message_to_wire(message: &Message) -> Value {
    let mut object = Map::new();
    object.insert("role".to_string(), Value::String(message.role.as_str().to_string()));
    match message.role {
        Role::Assistant if message.has_tool_calls() => {
            // 协议允许 assistant 消息的 content 为 null。
            object.insert(
                "content".to_string(),
                message.content.clone().map(Value::String).unwrap_or(Value::Null),
            );
            object.insert(
                "tool_calls".to_string(),
                Value::Array(message.tool_calls.iter().map(tool_call_to_wire).collect()),
            );
        }
        Role::Tool => {
            object.insert("content".to_string(), Value::String(message.text().to_string()));
            if let Some(id) = &message.tool_call_id {
                object.insert("tool_call_id".to_string(), Value::String(id.clone()));
            }
        }
        _ => {
            object.insert("content".to_string(), Value::String(message.text().to_string()));
        }
    }
    Value::Object(object)
}

/// 单次工具调用转换：`arguments` 由 JSON 对象序列化为字符串。
pub fn tool_call_to_wire(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": arguments_to_wire(&call.arguments),
        }
    })
}

/// 工具参数序列化为字符串；`null` 归一化为 `{}`，避免服务端解析失败。
pub fn arguments_to_wire(arguments: &Value) -> String {
    if arguments.is_null() {
        return "{}".to_string();
    }
    match arguments {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// 请求体中的 `tools` 字段；无工具时返回 `None`。
pub fn tools_to_wire(request: &GenerationRequest) -> Option<Value> {
    if request.tools.is_empty() {
        return None;
    }
    Some(Value::Array(request.tools.iter().map(|spec| spec.to_openai_tool()).collect()))
}

/// 解析 `usage` 字段；缺失 `total_tokens` 时由输入输出相加补齐。
pub fn parse_usage(value: &Value) -> TokenUsage {
    let mut usage = TokenUsage {
        prompt_tokens: value.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        completion_tokens: value.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        total_tokens: value.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
    };
    if usage.total_tokens == 0 {
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::{RiskLevel, ToolSpec};

    #[test]
    fn 助手工具调用消息的arguments是字符串() {
        let call = ToolCall::new("call_1", "shell", json!({ "command": "ls -a" }));
        let message = Message::assistant_tool_calls(None, vec![call]);
        let wire = message_to_wire(&message);
        assert_eq!(wire["role"], "assistant");
        assert!(wire["content"].is_null());
        assert_eq!(wire["tool_calls"][0]["type"], "function");
        assert_eq!(wire["tool_calls"][0]["function"]["name"], "shell");
        assert_eq!(wire["tool_calls"][0]["function"]["arguments"], r#"{"command":"ls -a"}"#);
        assert!(wire["tool_calls"][0]["function"]["arguments"].is_string());
    }

    #[test]
    fn 工具结果消息携带调用id() {
        let wire = message_to_wire(&Message::tool_result("call_1", "ok"));
        assert_eq!(wire["role"], "tool");
        assert_eq!(wire["tool_call_id"], "call_1");
        assert_eq!(wire["content"], "ok");
    }

    #[test]
    fn 空参数归一化为空对象字符串() {
        assert_eq!(arguments_to_wire(&Value::Null), "{}");
        assert_eq!(arguments_to_wire(&json!({ "a": 1 })), r#"{"a":1}"#);
    }

    #[test]
    fn 无工具时不产生tools字段() {
        let mut request = GenerationRequest {
            model: "m".into(),
            messages: vec![Message::user("hi")],
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
        };
        assert!(tools_to_wire(&request).is_none());
        request.tools.push(ToolSpec::new("read_file", "读文件", json!({ "type": "object" }), RiskLevel::Low, false));
        let wire = tools_to_wire(&request).expect("应包含工具");
        assert_eq!(wire[0]["function"]["name"], "read_file");
    }

    #[test]
    fn 用量缺失总数时自动补齐() {
        let usage = parse_usage(&json!({ "prompt_tokens": 10, "completion_tokens": 5 }));
        assert_eq!(usage.total_tokens, 15);
        let usage = parse_usage(&json!({ "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 99 }));
        assert_eq!(usage.total_tokens, 99);
        assert_eq!(parse_usage(&Value::Null).total_tokens, 0);
    }
}
