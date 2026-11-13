//! 配置层错误。

use std::path::PathBuf;

use thiserror::Error;

/// 配置加载与校验错误。
#[derive(Debug, Error)]
pub enum ConfigError {
    /// 读写配置文件失败。
    #[error("读写配置文件失败 {path}: {source}")]
    Io {
        /// 文件路径。
        path: PathBuf,
        /// 底层错误。
        #[source]
        source: std::io::Error,
    },

    /// 解析配置文件失败。
    #[error("解析配置文件失败 {path}: {reason}")]
    Parse {
        /// 文件路径。
        path: PathBuf,
        /// 原因。
        reason: String,
    },

    /// 环境变量覆盖无法应用。
    #[error("环境变量 {key} 无法应用: {reason}")]
    Env {
        /// 变量名。
        key: String,
        /// 原因。
        reason: String,
    },

    /// 配置内容非法。
    #[error("配置校验失败:\n{}", .0.join("\n"))]
    Invalid(Vec<String>),

    /// JSON 处理失败。
    #[error("JSON 处理失败: {0}")]
    Json(#[from] serde_json::Error),

    /// TOML 序列化失败。
    #[error("TOML 序列化失败: {0}")]
    Toml(String),
}

/// 配置层结果别名。
pub type ConfigResult<T> = Result<T, ConfigError>;
