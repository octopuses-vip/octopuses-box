//! ots-cli 模型接入层。
//!
//! 本 crate 实现 [`ots_core::Generator`]，把「生成」这一抽象落到真实的
//! OpenAI 兼容 Chat Completions 接口上：
//!
//! - [`client`]：HTTP 请求、SSE 流式读取、重试与用量统计；
//! - [`sse`]：按行的 SSE 解析与增量累积（纯函数，便于离线测试）；
//! - [`wire`]：领域消息与 OpenAI 报文之间的转换；
//! - [`config`]：连接参数（不含任何配置文件的读写，配置由 CLI 组装）。
//!
//! 依赖方向：`ots-llm → ots-core`，不依赖 `ots-config` 与 `ots-tools`。

pub mod client;
pub mod config;
pub mod error;
pub mod sse;
pub mod wire;

pub use client::OpenAiCompatGenerator;
pub use config::{LlmClientConfig, CONNECT_TIMEOUT, DEFAULT_TIMEOUT, RETRY_BASE_DELAY, RETRY_MAX_DELAY};
pub use error::LlmError;
pub use sse::{data_payload, PartialToolCall, StreamAccumulator, DONE_MARKER};
pub use wire::{arguments_to_wire, messages_to_wire, parse_usage, tool_call_to_wire, tools_to_wire};
