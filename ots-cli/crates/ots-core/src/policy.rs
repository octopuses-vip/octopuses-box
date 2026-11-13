//! 权限策略模型。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 风险等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// 只读、无副作用。
    Low,
    /// 有副作用但影响范围明确。
    Medium,
    /// 影响范围较大或不可逆。
    High,
    /// 可能破坏系统、泄露凭据或跨出工作区。
    Critical,
}

impl RiskLevel {
    /// 中文名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Low => "低",
            Self::Medium => "中",
            Self::High => "高",
            Self::Critical => "严重",
        }
    }
}

/// 权限模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// 只读：任何写操作直接拒绝。
    ReadOnly,
    /// 自动：低风险放行，其余进入审批。
    Auto,
    /// 完全放行：跳过审批（仍受沙箱硬性规则约束）。
    FullAccess,
}

impl PermissionMode {
    /// 配置/命令行可接受的字面量。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::Auto => "auto",
            Self::FullAccess => "full-access",
        }
    }
}

/// 策略裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyDecision {
    /// 直接执行。
    Allow,
    /// 需要人工审批。
    Ask,
    /// 直接拒绝。
    Deny,
}

/// 策略评估结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyEvaluation {
    /// 裁决。
    pub decision: PolicyDecision,
    /// 风险等级。
    pub risk: RiskLevel,
    /// 裁决理由（面向用户）。
    pub reason: String,
    /// 命中的规则名，便于排查与审计。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
}

impl PolicyEvaluation {
    /// 构造裁决结果。
    pub fn new(decision: PolicyDecision, risk: RiskLevel, reason: impl Into<String>) -> Self {
        Self { decision, risk, reason: reason.into(), matched_rule: None }
    }

    /// 记录命中规则。
    #[must_use]
    pub fn with_rule(mut self, rule: impl Into<String>) -> Self {
        self.matched_rule = Some(rule.into());
        self
    }
}

/// 策略查询入参。
#[derive(Debug, Clone, Copy)]
pub struct PolicyQuery<'a> {
    /// 工具名。
    pub tool: &'a str,
    /// 调用参数。
    pub arguments: &'a Value,
    /// 工作区根目录。
    pub cwd: &'a Path,
}

impl<'a> PolicyQuery<'a> {
    /// 构造查询。
    pub fn new(tool: &'a str, arguments: &'a Value, cwd: &'a Path) -> Self {
        Self { tool, arguments, cwd }
    }
}

/// 策略引擎契约。
pub trait PolicyEngine: Send + Sync {
    /// 当前权限模式。
    fn mode(&self) -> PermissionMode;

    /// 评估一次工具调用。
    fn evaluate(&self, query: &PolicyQuery<'_>) -> PolicyEvaluation;
}
