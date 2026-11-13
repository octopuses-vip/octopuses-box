//! ots-cli 分层配置。
//!
//! 优先级（低 → 高）：
//! 内置默认 → 用户级 `dirs::config_dir()/octopuses/config.toml` → 项目级 `<工作区>/.octopuses/config.toml`
//! → `--config` 显式文件 → 环境变量 `OTS__...` → 命令行参数。

pub mod error;
pub mod loader;
pub mod schema;
pub mod validate;

pub use error::{ConfigError, ConfigResult};
pub use loader::{
    ConfigSource, ConfigSourceKind, LoadOptions, LoadedConfig, deep_merge, load, project_config_path,
    to_toml, user_config_dir, user_config_path,
};
pub use schema::{
    AgentConfig, ApprovalConfig, ExternalToolConfig, LlmConfig, LogFormat, LoggingConfig, OtsConfig,
    ProjectConfig, SandboxBackend, SandboxConfig, SkillsConfig, ToolsConfig, VerifierKind,
};
pub use validate::{ValidationReport, validate};
