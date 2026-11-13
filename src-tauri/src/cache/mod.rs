//! 缓存目录管理。
//!
//! 应用运行过程中产生的文件与临时内容统一写入用户配置的缓存路径，目录结构固定为：
//! `temp/`（运行时临时文件）、`logs/`（运行日志与终端输出）、`sessions/`（会话记录）、
//! `outputs/`（临时会话写出的产物，按天分目录）、`snapshots/`（差异与来源的内部快照），
//! 根目录下另有 `manifest.json` 记录创建信息。

mod artifacts;
mod base64;
mod commands;
mod layout;

pub(crate) use artifacts::artifact_path;
pub(crate) use base64::base64_encode;
pub use commands::*;

#[cfg(test)]
mod tests;
