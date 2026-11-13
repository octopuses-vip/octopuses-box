//! 工具注册表工厂：把配置翻译成一套可用的工具。

use std::sync::Arc;

use ots_config::{OtsConfig, ToolsConfig};
use ots_core::{CoreResult, SkillRegistry, ToolRegistry};

use crate::external::ExternalTool;
use crate::files::{ReadFileTool, WriteFileTool};
use crate::patch::ApplyPatchTool;
use crate::shell::ShellTool;
use crate::skill::UseSkillTool;
use crate::test_runner::TestRunnerTool;

/// 内置工具名清单。
///
/// 同时作为配置校验时判定「外部工具重名」的依据，避免清单与实现脱节。
pub const BUILTIN_TOOL_NAMES: &[&str] = &[
    ShellTool::NAME,
    ReadFileTool::NAME,
    WriteFileTool::NAME,
    ApplyPatchTool::NAME,
    TestRunnerTool::NAME,
    UseSkillTool::NAME,
];

/// 依据配置组装工具注册表。
///
/// 白名单/黑名单只决定「是否注册」，未注册的工具既不会被模型看到，也无法被调用。
/// `skills` 为已装载的技能；为空时不注册 `use_skill`，模型也就看不到技能能力。
///
/// # Errors
/// 出现重复工具名时返回 [`ots_core::CoreError::Other`]。
pub fn build_registry(config: &OtsConfig, skills: Arc<SkillRegistry>) -> CoreResult<ToolRegistry> {
    let mut registry = ToolRegistry::new();

    if enabled(ShellTool::NAME, &config.tools) {
        registry.register(ShellTool)?;
    }
    if enabled(ReadFileTool::NAME, &config.tools) {
        registry.register(ReadFileTool)?;
    }
    if enabled(WriteFileTool::NAME, &config.tools) {
        registry.register(WriteFileTool)?;
    }
    if enabled(ApplyPatchTool::NAME, &config.tools) {
        registry.register(ApplyPatchTool)?;
    }
    if enabled(TestRunnerTool::NAME, &config.tools) {
        registry.register(TestRunnerTool::new(config.agent.test_command.clone()))?;
    }

    if config.skills.enabled && !skills.is_empty() && enabled(UseSkillTool::NAME, &config.tools) {
        registry.register(UseSkillTool::new(skills, config.skills.max_body_bytes))?;
    }

    for external in &config.tools.external {
        if enabled(&external.name, &config.tools) {
            registry.register(ExternalTool::new(external))?;
        }
    }

    Ok(registry)
}

/// 判断某个工具名是否被配置启用：黑名单优先，白名单为空表示全部启用。
fn enabled(name: &str, tools: &ToolsConfig) -> bool {
    if tools.disabled.iter().any(|item| item == name) {
        return false;
    }
    if tools.enabled.is_empty() {
        return true;
    }
    tools.enabled.iter().any(|item| item == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 含一个技能的最小注册表。
    fn one_skill() -> Arc<SkillRegistry> {
        let mut skills = SkillRegistry::new();
        skills.insert(ots_core::SkillSpec::new(
            "demo",
            "演示技能",
            std::path::PathBuf::from("/tmp/demo/SKILL.md"),
            ots_core::SkillSource::Project,
        ));
        Arc::new(skills)
    }

    #[test]
    fn 默认配置注册全部内置工具() {
        let registry = build_registry(&OtsConfig::default(), one_skill()).expect("构建成功");
        let names = registry.names();
        for expected in BUILTIN_TOOL_NAMES {
            assert!(names.iter().any(|name| name == expected), "缺少 {expected}，实际 {names:?}");
        }
    }

    #[test]
    fn 没有技能时不注册载入工具() {
        let registry = build_registry(&OtsConfig::default(), Arc::new(SkillRegistry::new())).expect("构建成功");
        assert!(!registry.contains(UseSkillTool::NAME));
    }

    #[test]
    fn 技能功能关闭时不注册载入工具() {
        let mut config = OtsConfig::default();
        config.skills.enabled = false;
        let registry = build_registry(&config, one_skill()).expect("构建成功");
        assert!(!registry.contains(UseSkillTool::NAME));
    }

    #[test]
    fn 白名单只保留列出的工具() {
        let mut config = OtsConfig::default();
        config.tools.enabled = vec!["read_file".to_string()];
        let registry = build_registry(&config, one_skill()).expect("构建成功");
        assert_eq!(registry.names(), vec!["read_file".to_string()]);
    }

    #[test]
    fn 黑名单优先于白名单() {
        let mut config = OtsConfig::default();
        config.tools.enabled = vec!["read_file".to_string(), "shell".to_string()];
        config.tools.disabled = vec!["shell".to_string()];
        let registry = build_registry(&config, one_skill()).expect("构建成功");
        assert_eq!(registry.names(), vec!["read_file".to_string()]);
    }

    #[test]
    fn 外部工具按配置注册() {
        let mut config = OtsConfig::default();
        config.tools.external.push(ots_config::ExternalToolConfig {
            name: "lint".to_string(),
            description: "跑 lint".to_string(),
            command: "/bin/echo".to_string(),
            args: vec!["{{file}}".to_string()],
            parameters: serde_json::json!({"type": "object"}),
            risk: ots_core::RiskLevel::Low,
            mutating: false,
            tags: Vec::new(),
            timeout_secs: None,
            env: Default::default(),
        });
        let registry = build_registry(&config, one_skill()).expect("构建成功");
        assert!(registry.contains("lint"));
    }

    #[test]
    fn 外部工具与内置工具重名时报错() {
        let mut config = OtsConfig::default();
        config.tools.external.push(ots_config::ExternalToolConfig {
            name: "shell".to_string(),
            description: "重复".to_string(),
            command: "/bin/echo".to_string(),
            args: Vec::new(),
            parameters: serde_json::json!({"type": "object"}),
            risk: ots_core::RiskLevel::Low,
            mutating: false,
            tags: Vec::new(),
            timeout_secs: None,
            env: Default::default(),
        });
        assert!(build_registry(&config, one_skill()).is_err());
    }

    #[test]
    fn 外部工具不能占用载入工具名() {
        let mut config = OtsConfig::default();
        config.tools.external.push(ots_config::ExternalToolConfig {
            name: UseSkillTool::NAME.to_string(),
            description: "重复".to_string(),
            command: "/bin/echo".to_string(),
            args: Vec::new(),
            parameters: serde_json::json!({"type": "object"}),
            risk: ots_core::RiskLevel::Low,
            mutating: false,
            tags: Vec::new(),
            timeout_secs: None,
            env: Default::default(),
        });
        assert!(build_registry(&config, one_skill()).is_err());
    }
}
