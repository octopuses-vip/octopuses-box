//! 策略引擎：把「权限模式 + 路径规则 + 命令规则」翻译成单次调用的裁决。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ots_config::OtsConfig;
use ots_core::{
    CoreResult, PermissionMode, PolicyDecision, PolicyEngine, PolicyEvaluation, PolicyQuery, RiskLevel, ToolSpec,
};

use crate::rules::{
    collect_strings, command_matches_any, is_within, resolve_argument_path, PathGlobs, ScopeSets, COMMAND_KEYS, PATH_KEYS,
};

/// 基于配置的策略引擎。
///
/// 裁决优先级（从高到低）：硬性拒绝规则 → 只读模式 → 完全放行 → 显式放行规则
/// → 越界路径判定 → 严重风险兜底 → 按风险等级与模式判定。
pub struct SandboxPolicyEngine {
    mode: PermissionMode,
    allow_paths: PathGlobs,
    deny_paths: PathGlobs,
    scope: ScopeSets,
    allow_commands: Vec<String>,
    deny_commands: Vec<String>,
    allow_critical: bool,
    test_command: Option<String>,
    specs: BTreeMap<String, ToolSpec>,
}

impl SandboxPolicyEngine {
    /// 依据配置与已注册工具元数据构造引擎。
    ///
    /// # Errors
    /// 配置中的 glob 非法时返回 [`ots_core::CoreError::Config`]。
    pub fn new(config: &OtsConfig, specs: &[ToolSpec]) -> CoreResult<Self> {
        let approval = &config.approval;
        Ok(Self {
            mode: approval.mode,
            allow_paths: PathGlobs::compile(&approval.allow_paths, "approval.allow_paths")?,
            deny_paths: PathGlobs::compile(&approval.deny_paths, "approval.deny_paths")?,
            scope: ScopeSets::from_config(&config.sandbox)?,
            allow_commands: approval.allow_commands.clone(),
            deny_commands: approval.deny_commands.clone(),
            allow_critical: approval.allow_critical,
            test_command: config
                .agent
                .test_command
                .clone()
                .filter(|command| !command.trim().is_empty()),
            specs: specs.iter().map(|spec| (spec.name.clone(), spec.clone())).collect(),
        })
    }
}

impl PolicyEngine for SandboxPolicyEngine {
    /// 当前权限档位（开发者 Jan）：由配置传入，决定后续评估的严格程度。
    fn mode(&self) -> PermissionMode {
        self.mode
    }

    /// 评估一次工具调用（开发者 Jan）：按「硬性拒绝 → 路径规则 → 命令规则 → 模式兜底」的顺序给出结论。
    ///
    /// 顺序不可调换：硬性拒绝（如 rm -rf /）必须先于任何放行判断，
    /// 否则用户配置的 allow 规则就能绕过它。
    fn evaluate(&self, query: &PolicyQuery<'_>) -> PolicyEvaluation {
        let spec = self.specs.get(query.tool);
        let mut risk = spec.map_or(RiskLevel::Medium, |spec| spec.risk);
        let mutating = spec.is_none_or(|spec| spec.mutating);

        let commands = collect_strings(query.arguments, COMMAND_KEYS);
        let raw_paths = collect_strings(query.arguments, PATH_KEYS);
        let paths: Vec<PathBuf> = raw_paths.iter().map(|raw| resolve_argument_path(query.cwd, raw)).collect();

        // 1. 硬性拒绝：无论何种模式都必须遵守。
        for command in &commands {
            if let Some(rule) = command_matches_any(command, &self.deny_commands) {
                return PolicyEvaluation::new(
                    PolicyDecision::Deny,
                    RiskLevel::Critical,
                    format!("命令命中禁止规则 `{rule}`"),
                )
                .with_rule("approval.deny_commands");
            }
        }
        for path in &paths {
            if self.deny_paths.is_match(path, query.cwd) {
                return PolicyEvaluation::new(
                    PolicyDecision::Deny,
                    RiskLevel::High,
                    format!("路径 `{}` 命中禁止规则", display(path, query.cwd)),
                )
                .with_rule("approval.deny_paths");
            }
        }

        // 2. 只读模式：任何会改动工作区的操作都直接拒绝。
        if self.mode == PermissionMode::ReadOnly && mutating {
            return PolicyEvaluation::new(
                PolicyDecision::Deny,
                risk,
                "当前为只读模式（read-only），禁止修改工作区的操作",
            )
            .with_rule("approval.mode");
        }

        // 3. 完全放行：跳过审批，但仍受上方的硬性规则约束。
        if self.mode == PermissionMode::FullAccess {
            return PolicyEvaluation::new(PolicyDecision::Allow, risk, "当前为完全放行模式（full-access）")
                .with_rule("approval.mode");
        }

        // 4. 显式放行：项目自己声明的验证命令。
        //
        // 判定依据是「这次调用实际会跑什么」：既包括显式传入且恰好等于配置值的命令，
        // 也包括声明了 `config_verified` 的工具在不传参时回退到配置值的情形。
        if let Some(configured) = &self.test_command {
            let configured = configured.trim();
            let is_config_verifier = spec.is_some_and(|spec| spec.config_verified);
            let runs_configured =
                (is_config_verifier && commands.is_empty()) || commands.iter().any(|command| command.trim() == configured);
            if runs_configured {
                return PolicyEvaluation::new(PolicyDecision::Allow, RiskLevel::Low, "这是配置中声明的验证命令")
                    .with_rule("agent.test_command");
            }
        }
        for command in &commands {
            if let Some(rule) = command_matches_any(command, &self.allow_commands) {
                return PolicyEvaluation::new(PolicyDecision::Allow, RiskLevel::Low, format!("命令命中放行规则 `{rule}`"))
                    .with_rule("approval.allow_commands");
            }
        }
        for path in &paths {
            if self.allow_paths.is_match(path, query.cwd) {
                return PolicyEvaluation::new(
                    PolicyDecision::Allow,
                    RiskLevel::Low,
                    format!("路径 `{}` 命中放行规则", display(path, query.cwd)),
                )
                .with_rule("approval.allow_paths");
            }
        }

        // 5. 越出工作区的路径：必须先被显式声明，然后再人工确认。
        if paths.iter().any(|path| !is_within(query.cwd, path)) {
            let undeclared: Vec<String> = paths
                .iter()
                .filter(|path| !is_within(query.cwd, path) && !self.scope.declares(path, query.cwd, mutating))
                .map(|path| path.to_string_lossy().to_string())
                .collect();
            if !undeclared.is_empty() {
                return PolicyEvaluation::new(
                    PolicyDecision::Deny,
                    RiskLevel::High,
                    format!(
                        "工作区之外的路径必须先在 sandbox.readable_paths（读）或 sandbox.writable_paths（写）中声明: {}",
                        undeclared.join("、")
                    ),
                )
                .with_rule("sandbox.scope");
            }
            risk = risk.max(RiskLevel::High);
            return PolicyEvaluation::new(
                PolicyDecision::Ask,
                risk,
                format!("操作涉及工作区之外的已声明路径: {}", display_prefix(query.cwd, &paths)),
            )
            .with_rule("sandbox.scope");
        }

        // 6. 严重风险兜底。
        if risk == RiskLevel::Critical && !self.allow_critical {
            return PolicyEvaluation::new(
                PolicyDecision::Deny,
                risk,
                "该操作属于严重风险，需在配置中显式设置 approval.allow_critical = true 才可执行",
            )
            .with_rule("approval.allow_critical");
        }

        // 7. 按模式与风险等级判定。
        match self.mode {
            PermissionMode::Auto if risk == RiskLevel::Low && !mutating => {
                PolicyEvaluation::new(PolicyDecision::Allow, risk, "低风险只读操作自动放行").with_rule("approval.mode")
            }
            PermissionMode::ReadOnly => {
                PolicyEvaluation::new(PolicyDecision::Allow, risk, "只读操作自动放行").with_rule("approval.mode")
            }
            _ => PolicyEvaluation::new(
                PolicyDecision::Ask,
                risk,
                format!("风险等级为「{}」，需要人工确认", risk.label()),
            )
            .with_rule("approval.mode"),
        }
    }
}

/// 渲染为相对工作区的展示路径。
fn display(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// 渲染越界路径列表（只显示工作区之外的项）。
fn display_prefix(cwd: &Path, paths: &[PathBuf]) -> String {
    let outside: Vec<String> = paths
        .iter()
        .filter(|path| !is_within(cwd, path))
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    outside.join("、")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::ToolSpec;
    use serde_json::{json, Value};

    fn specs() -> Vec<ToolSpec> {
        vec![
            ToolSpec::new("shell", "执行命令", json!({}), RiskLevel::High, true),
            ToolSpec::new("read_file", "读文件", json!({}), RiskLevel::Low, false),
            ToolSpec::new("write_file", "写文件", json!({}), RiskLevel::Medium, true),
            ToolSpec::new("test_runner", "跑测试", json!({}), RiskLevel::Medium, false).as_config_verifier(),
        ]
    }

    fn engine(config: &OtsConfig) -> SandboxPolicyEngine {
        SandboxPolicyEngine::new(config, &specs()).expect("构造成功")
    }

    fn evaluate(engine: &SandboxPolicyEngine, tool: &str, arguments: Value) -> PolicyEvaluation {
        engine.evaluate(&PolicyQuery::new(tool, &arguments, Path::new("/ws")))
    }

    #[test]
    fn 低风险只读操作自动放行() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "read_file", json!({"path": "src/main.rs"}));
        assert_eq!(evaluation.decision, PolicyDecision::Allow);
    }

    #[test]
    fn 写入操作需要审批() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "write_file", json!({"path": "src/main.rs"}));
        assert_eq!(evaluation.decision, PolicyDecision::Ask);
        assert_eq!(evaluation.risk, RiskLevel::Medium);
    }

    #[test]
    fn 只读模式拒绝写入() {
        let mut config = OtsConfig::default();
        config.approval.mode = PermissionMode::ReadOnly;
        let evaluation = evaluate(&engine(&config), "write_file", json!({"path": "a.txt"}));
        assert_eq!(evaluation.decision, PolicyDecision::Deny);
    }

    #[test]
    fn 完全放行模式跳过审批() {
        let mut config = OtsConfig::default();
        config.approval.mode = PermissionMode::FullAccess;
        let evaluation = evaluate(&engine(&config), "shell", json!({"command": "cargo build"}));
        assert_eq!(evaluation.decision, PolicyDecision::Allow);
    }

    #[test]
    fn 禁止命令在完全放行模式下仍被拒绝() {
        let mut config = OtsConfig::default();
        config.approval.mode = PermissionMode::FullAccess;
        let evaluation = evaluate(&engine(&config), "shell", json!({"command": "sudo rm -rf /"}));
        assert_eq!(evaluation.decision, PolicyDecision::Deny);
        assert_eq!(evaluation.matched_rule.as_deref(), Some("approval.deny_commands"));
    }

    #[test]
    fn 放行命令前缀生效() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "shell", json!({"command": "git status -s"}));
        assert_eq!(evaluation.decision, PolicyDecision::Allow);
        assert_eq!(evaluation.matched_rule.as_deref(), Some("approval.allow_commands"));
    }

    #[test]
    fn 未声明的工作区外路径直接拒绝() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "write_file", json!({"path": "/etc/hosts"}));
        assert_eq!(evaluation.decision, PolicyDecision::Deny);
        assert_eq!(evaluation.matched_rule.as_deref(), Some("sandbox.scope"));
    }

    #[test]
    fn 已声明的工作区外路径要求确认() {
        let mut config = OtsConfig::default();
        config.sandbox.writable_paths = vec!["/etc/**".to_string()];
        let evaluation = evaluate(&engine(&config), "write_file", json!({"path": "/etc/hosts"}));
        assert_eq!(evaluation.decision, PolicyDecision::Ask);
        assert_eq!(evaluation.risk, RiskLevel::High);
    }

    #[test]
    fn 相对路径的越界尝试同样被拦截() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "write_file", json!({"path": "../outside.txt"}));
        assert_eq!(evaluation.decision, PolicyDecision::Deny);
    }

    #[test]
    fn 禁止路径直接拒绝() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "write_file", json!({"path": ".env"}));
        assert_eq!(evaluation.decision, PolicyDecision::Deny);
        assert_eq!(evaluation.matched_rule.as_deref(), Some("approval.deny_paths"));
    }

    #[test]
    fn 配置的验证命令自动放行() {
        let mut config = OtsConfig::default();
        config.agent.test_command = Some("cargo test".to_string());
        let evaluation = evaluate(&engine(&config), "test_runner", json!({}));
        assert_eq!(evaluation.decision, PolicyDecision::Allow);
        assert_eq!(evaluation.matched_rule.as_deref(), Some("agent.test_command"));
    }

    #[test]
    fn 未配置的验证命令仍需确认() {
        let mut config = OtsConfig::default();
        config.agent.test_command = Some("cargo test".to_string());
        let evaluation = evaluate(&engine(&config), "test_runner", json!({"command": "cargo publish"}));
        assert_eq!(evaluation.decision, PolicyDecision::Ask);
    }

    #[test]
    fn 严重风险在未放开时被拒绝() {
        let mut config = OtsConfig::default();
        config.agent.test_command = None;
        let mut specs = specs();
        specs.push(ToolSpec::new("deploy", "部署", json!({}), RiskLevel::Critical, true));
        let engine = SandboxPolicyEngine::new(&config, &specs).expect("构造成功");
        let evaluation = evaluate(&engine, "deploy", json!({}));
        assert_eq!(evaluation.decision, PolicyDecision::Deny);
        assert_eq!(evaluation.matched_rule.as_deref(), Some("approval.allow_critical"));
    }

    #[test]
    fn 未注册工具按中等风险处理() {
        let config = OtsConfig::default();
        let evaluation = evaluate(&engine(&config), "unknown_tool", json!({}));
        assert_eq!(evaluation.decision, PolicyDecision::Ask);
    }
}
