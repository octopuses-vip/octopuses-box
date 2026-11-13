//! 会话记录 SQLite 持久化。
//!
//! 会话记录改由缓存目录根部的单个 SQLite 库文件（`octopuses.db`）承载：启动时若库文件
//! 不存在则创建并建表，之后会话、消息与消息片段都写进库，取代原先
//! `sessions/index.json` + `sessions/<id>.json` 的 JSON 文件方案。
//! 流式输出会反复保存同一个会话，因此写入采用「按 id upsert + 删除本次未出现的旧行」，
//! 既保证不重置首次时间戳，也保证行不越积越多。

mod commands;
mod read;
mod schema;
mod types;
mod usage;
mod write;

pub use commands::*;

#[cfg(test)]
mod tests;
