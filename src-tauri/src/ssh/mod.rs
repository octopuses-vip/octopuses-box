//! SSH 远程运维（开发者 Jan）。
//!
//! 让 Agent 登录远程 Linux 主机执行命令、读写文件；能力与本地操作同构，
//! 但安全边界更严：任何一次远程调用都必须先经过人工审批（见前端 `useAgentRun`）。
//!
//! 分层设计：
//! - **配置层**：非敏感字段落在 `cache_dir/ssh/hosts.json`，复用 [`crate::json_store`] 的原子写；
//! - **凭据层**：密码与私钥口令只进系统凭据管理器（keyring），绝不落盘、绝不降级为明文；
//! - **连接层**：russh 建连，TOFU 校验主机密钥，采用「一次调用一条连接」的短生命周期模型，
//!   与 MCP 的「一操作一会话」保持一致，不引入长驻连接与心跳状态。
//!
//! 安全约束：
//! - 主机密钥指纹与记录不一致时连接必须失败，不自动覆盖；
//! - [`remote_deny_reason`] 的静态拒绝清单只作纵深防御，不作为放行依据；
//! - 回前端的结构体一律经 [`redact_host`]，不含任何秘密字段。

mod commands;
mod config;
mod connect;
mod exec;
mod guard;
mod secret;
mod sftp;
mod types;

pub use commands::*;

#[cfg(test)]
mod tests;
