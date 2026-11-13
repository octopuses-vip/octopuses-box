//! 配置校验。
//!
//! 校验分两级：`errors` 表示配置无法使用；`warnings` 表示可以运行但可能不符合预期。

use std::collections::BTreeSet;

use globset::Glob;

use crate::schema::{OtsConfig, SandboxBackend, VerifierKind};

/// 校验报告。
#[derive(Debug, Clone, Default)]
pub struct ValidationReport {
    /// 致命问题。
    pub errors: Vec<String>,
    /// 提醒项。
    pub warnings: Vec<String>,
}

impl ValidationReport {
    /// 是否通过。
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }

    /// 追加一条错误。
    pub fn error(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }

    /// 追加一条警告。
    pub fn warn(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }
}

/// 校验配置。
///
/// `builtin_tools` 为已注册的内置工具名，用于检测外部工具重名。
pub fn validate(config: &OtsConfig, builtin_tools: &[&str]) -> ValidationReport {
    let mut report = ValidationReport::default();

    if config.llm.provider != "openai-compatible" {
        report.error(format!(
            "llm.provider 目前只支持 `openai-compatible`，当前为 `{}`",
            config.llm.provider
        ));
    }
    if !(config.llm.base_url.starts_with("http://") || config.llm.base_url.starts_with("https://")) {
        report.error(format!("llm.base_url 必须是 http(s) 地址，当前为 `{}`", config.llm.base_url));
    }
    if config.llm.model.trim().is_empty() {
        report.error("llm.model 不能为空，可通过 `OTS__LLM__MODEL` 或 `--model` 指定");
    }
    if config.llm.api_key_env.trim().is_empty() && config.llm.api_key.is_none() {
        report.error("llm.api_key_env 与 llm.api_key 至少需要一个");
    }
    if config.llm.timeout_secs == 0 {
        report.error("llm.timeout_secs 必须大于 0");
    }
    if let Some(temperature) = config.llm.temperature {
        if !(0.0..=2.0).contains(&temperature) {
            report.error(format!("llm.temperature 应在 0~2 之间，当前为 {temperature}"));
        }
    }

    if config.agent.max_iterations == 0 {
        report.error("agent.max_iterations 必须大于 0");
    }
    if !(0.0..=1.0).contains(&config.agent.quality_threshold) {
        report.error(format!("agent.quality_threshold 应在 0~1 之间，当前为 {}", config.agent.quality_threshold));
    }
    if config.agent.max_tool_concurrency == 0 {
        report.error("agent.max_tool_concurrency 必须大于 0");
    }
    if config.agent.tool_timeout_secs == 0 {
        report.error("agent.tool_timeout_secs 必须大于 0");
    }
    if config.agent.verifier == VerifierKind::TestCommand
        && config.agent.test_command.as_deref().map(str::trim).unwrap_or("").is_empty()
    {
        report.warn(
            "agent.test_command 未配置，验证器将跳过客观验证（模型停止调用工具即视为完成）；\
             可设置 `agent.test_command` 或 `agent.verifier = \"none\"` 消除此提醒",
        );
    }
    if config.agent.continue_prompt.trim().is_empty() {
        report.error("agent.continue_prompt 不能为空");
    } else if !config.agent.continue_prompt.contains("{summary}") && !config.agent.continue_prompt.contains("{details}") {
        report.warn("agent.continue_prompt 未包含 `{summary}` 或 `{details}` 占位符，模型将看不到失败原因");
    }
    if config.agent.max_duration_secs == Some(0) {
        report.error("agent.max_duration_secs 为 0 会导致循环立即终止");
    }
    if config.agent.max_total_tokens == Some(0) {
        report.error("agent.max_total_tokens 为 0 会导致循环立即终止");
    }
    for file in &config.agent.instructions_files {
        if file.trim().is_empty() {
            report.warn("agent.instructions_files 中存在空文件名，已忽略");
        }
    }

    if config.tools.max_output_bytes < 1024 {
        report.error("tools.max_output_bytes 过小（至少 1024），否则模型无法读到有效信息");
    }
    let enabled: BTreeSet<&String> = config.tools.enabled.iter().collect();
    for name in &config.tools.disabled {
        if enabled.contains(name) {
            report.warn(format!("工具 `{name}` 同时出现在 tools.enabled 与 tools.disabled，按禁用处理"));
        }
    }
    let mut seen: BTreeSet<&str> = builtin_tools.iter().copied().collect();
    for external in &config.tools.external {
        if external.name.trim().is_empty() {
            report.error("tools.external[].name 不能为空");
            continue;
        }
        if external.command.trim().is_empty() {
            report.error(format!("外部工具 `{}` 的 command 不能为空", external.name));
        }
        if !seen.insert(external.name.as_str()) {
            report.error(format!("工具名重复: `{}`", external.name));
        }
        if !external.parameters.is_object() {
            report.error(format!("外部工具 `{}` 的 parameters 必须是 JSON Schema 对象", external.name));
        }
        if let Some(timeout) = external.timeout_secs {
            if timeout == 0 {
                report.error(format!("外部工具 `{}` 的 timeout_secs 必须大于 0", external.name));
            }
        }
    }

    if config.skills.max_body_bytes < 1024 {
        report.error("skills.max_body_bytes 过小（至少 1024），否则技能正文会被截断到无法执行");
    }
    for path in &config.skills.paths {
        if path.as_os_str().is_empty() {
            report.warn("skills.paths 中存在空路径，已忽略");
        }
    }
    for name in &config.skills.disabled {
        if name.trim().is_empty() {
            report.warn("skills.disabled 中存在空字符串，已忽略");
        }
    }

    for (field, patterns) in [
        ("approval.allow_paths", &config.approval.allow_paths),
        ("approval.deny_paths", &config.approval.deny_paths),
        ("sandbox.writable_paths", &config.sandbox.writable_paths),
        ("sandbox.readable_paths", &config.sandbox.readable_paths),
    ] {
        for pattern in patterns {
            if let Err(err) = Glob::new(pattern) {
                report.error(format!("{field} 中的 glob `{pattern}` 非法: {err}"));
            }
        }
    }
    if config.approval.elevated_phrase.trim().is_empty() {
        report.error("approval.elevated_phrase 不能为空，强化确认需要它作为确认短语");
    }
    if config.approval.deferred_wait_secs == 0 {
        report.error("approval.deferred_wait_secs 必须大于 0");
    }
    for command in &config.approval.allow_commands {
        if command.trim().is_empty() {
            report.warn("approval.allow_commands 中存在空字符串，已忽略");
        }
    }
    for command in &config.approval.deny_commands {
        if command.trim().is_empty() {
            report.warn("approval.deny_commands 中存在空字符串，已忽略");
        }
    }

    if config.sandbox.backend == SandboxBackend::Seatbelt && !cfg!(target_os = "macos") {
        report.error("sandbox.backend = \"seatbelt\" 仅在 macOS 上可用，请改用 \"logical\"");
    }
    if config.sandbox.backend == SandboxBackend::None {
        report.warn("sandbox.backend = \"none\" 会关闭所有路径与命令限制，请确认这是有意为之");
    }
    if !config.sandbox.enabled && config.sandbox.backend != SandboxBackend::None {
        report.warn("sandbox.enabled = false 时 backend 配置不会生效");
    }

    if config.logging.level.trim().is_empty() {
        report.error("logging.level 不能为空");
    } else if !is_valid_level(&config.logging.level) {
        report.warn(format!(
            "logging.level `{}` 不是常见级别（trace/debug/info/warn/error），将按 tracing 过滤器直接解析",
            config.logging.level
        ));
    }

    if let Some(workspace) = &config.project.workspace {
        if workspace.as_os_str().is_empty() {
            report.error("project.workspace 不能为空字符串");
        }
    }

    report
}

/// 校验日志级别是否合法（开发者 Jan）：大小写不敏感，只认 tracing 支持的那几档。
fn is_valid_level(level: &str) -> bool {
    matches!(level.to_ascii_lowercase().as_str(), "trace" | "debug" | "info" | "warn" | "error" | "off")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认配置在补齐模型与测试命令后通过校验() {
        let mut config = OtsConfig::default();
        config.llm.model = "gpt-4o".to_string();
        config.agent.test_command = Some("cargo test".to_string());
        let report = validate(&config, &["shell"]);
        assert!(report.is_ok(), "errors={:?}", report.errors);
    }

    #[test]
    fn 缺少模型时报错() {
        let config = OtsConfig::default();
        let report = validate(&config, &[]);
        assert!(report.errors.iter().any(|e| e.contains("llm.model")));
    }

    #[test]
    fn 外部工具与内置工具重名时报错() {
        let mut config = OtsConfig::default();
        config.llm.model = "gpt-4o".to_string();
        config.tools.external.push(crate::schema::ExternalToolConfig {
            name: "shell".to_string(),
            description: "重复".to_string(),
            command: "echo".to_string(),
            args: Vec::new(),
            parameters: serde_json::json!({ "type": "object" }),
            risk: ots_core::RiskLevel::Low,
            mutating: false,
            tags: Vec::new(),
            timeout_secs: None,
            env: Default::default(),
        });
        let report = validate(&config, &["shell"]);
        assert!(report.errors.iter().any(|e| e.contains("工具名重复")));
    }

    #[test]
    fn 技能正文上限过小时报错() {
        let mut config = OtsConfig::default();
        config.llm.model = "gpt-4o".to_string();
        config.skills.max_body_bytes = 16;
        let report = validate(&config, &["shell"]);
        assert!(report.errors.iter().any(|e| e.contains("skills.max_body_bytes")));
    }

    #[test]
    fn 技能配置中的空值只提示不报错() {
        let mut config = OtsConfig::default();
        config.llm.model = "gpt-4o".to_string();
        config.agent.test_command = Some("cargo test".to_string());
        config.skills.paths = vec![std::path::PathBuf::from("")];
        config.skills.disabled = vec!["  ".to_string()];
        let report = validate(&config, &["shell"]);
        assert!(report.is_ok(), "errors={:?}", report.errors);
        assert_eq!(report.warnings.len(), 2);
    }
}
