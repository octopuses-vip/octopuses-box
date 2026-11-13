//! 会话消息模型（对齐 OpenAI Chat Completions 语义）。

use serde::{Deserialize, Serialize};

use crate::tool::ToolCall;

/// 消息角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// 系统提示。
    System,
    /// 用户输入。
    User,
    /// 模型输出。
    Assistant,
    /// 工具执行结果。
    Tool,
}

impl Role {
    /// 角色名。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// 单条会话消息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    /// 角色。
    pub role: Role,
    /// 文本内容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 助手消息携带的工具调用请求。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// `role == Tool` 时对应的调用 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Message {
    /// 系统消息。
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: Role::System, content: Some(content.into()), tool_calls: Vec::new(), tool_call_id: None }
    }

    /// 用户消息。
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: Role::User, content: Some(content.into()), tool_calls: Vec::new(), tool_call_id: None }
    }

    /// 纯文本助手消息。
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: Some(content.into()), tool_calls: Vec::new(), tool_call_id: None }
    }

    /// 携带工具调用的助手消息。
    pub fn assistant_tool_calls(content: Option<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self { role: Role::Assistant, content, tool_calls, tool_call_id: None }
    }

    /// 工具结果消息。
    pub fn tool_result(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self { role: Role::Tool, content: Some(content.into()), tool_calls: Vec::new(), tool_call_id: Some(call_id.into()) }
    }

    /// 是否为携带工具调用的助手消息。
    pub fn has_tool_calls(&self) -> bool {
        !self.tool_calls.is_empty()
    }

    /// 文本内容的借用（无内容时为空串）。
    pub fn text(&self) -> &str {
        self.content.as_deref().unwrap_or("")
    }
}
