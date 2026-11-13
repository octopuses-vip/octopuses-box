//! 审批模型：请求、预览、决策与分级。

use std::collections::BTreeMap;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::CoreResult;
use crate::policy::RiskLevel;

/// 文件变更类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeKind {
    /// 新建。
    Create,
    /// 修改。
    Modify,
    /// 删除。
    Delete,
}

impl FileChangeKind {
    /// 单字符标记，用于紧凑展示。
    pub fn marker(&self) -> &'static str {
        match self {
            Self::Create => "A",
            Self::Modify => "M",
            Self::Delete => "D",
        }
    }
}

/// 单个文件的变更预览。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    /// 相对工作区的路径。
    pub path: String,
    /// 变更类型。
    pub kind: FileChangeKind,
    /// 新增行数。
    pub additions: u64,
    /// 删除行数。
    pub deletions: u64,
    /// 统一 diff 文本（可能因体积被省略）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

/// 影响范围汇总。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImpactSummary {
    /// 受影响文件数。
    pub files: u64,
    /// 新增行数。
    pub additions: u64,
    /// 删除行数。
    pub deletions: u64,
}

impl FileChange {
    /// 从工具结果的结构化数据中解析文件变更列表。
    ///
    /// 约定：会修改工作区的工具在 [`crate::ToolResult::data`] 中返回
    /// `{ "files": [ { "path", "kind", "additions", "deletions", "diff" } ] }`。
    /// 该约定由 `ots-tools` 与 `ots-sandbox` 共同遵守，循环据此统计改动。
    pub fn list_from_tool_result(result: &crate::tool::ToolResult) -> Option<Vec<FileChange>> {
        let files = result.data.as_ref()?.get("files")?.as_array()?;
        let changes: Vec<FileChange> = files
            .iter()
            .filter_map(|value| serde_json::from_value::<FileChange>(value.clone()).ok())
            .collect();
        if changes.is_empty() { None } else { Some(changes) }
    }
}

/// 操作影响预览：让人在批准前看清「会发生什么」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OperationPreview {
    /// 一句话概述。
    pub summary: String,
    /// 将要执行的命令。
    #[serde(default)]
    pub commands: Vec<String>,
    /// 将要发生的文件变更。
    #[serde(default)]
    pub file_changes: Vec<FileChange>,
    /// 越出工作区或被规则标记的路径。
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    /// 其它提示（如命中危险命令模式）。
    #[serde(default)]
    pub notes: Vec<String>,
}

impl OperationPreview {
    /// 构造预览。
    pub fn new(summary: impl Into<String>) -> Self {
        Self { summary: summary.into(), ..Default::default() }
    }

    /// 汇总影响范围。
    pub fn impact(&self) -> ImpactSummary {
        ImpactSummary {
            files: self.file_changes.len() as u64,
            additions: self.file_changes.iter().map(|c| c.additions).sum(),
            deletions: self.file_changes.iter().map(|c| c.deletions).sum(),
        }
    }

    /// 是否为空预览（无可展示内容）。
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty() && self.file_changes.is_empty() && self.out_of_scope.is_empty() && self.notes.is_empty()
    }
}

/// 审批状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    /// 等待决策。
    Pending,
    /// 已批准。
    Approved,
    /// 已拒绝。
    Denied,
    /// 等待超时。
    Expired,
    /// 被取消。
    Cancelled,
}

impl ApprovalStatus {
    /// 是否为终态。
    pub fn is_final(&self) -> bool {
        !matches!(self, Self::Pending)
    }
}

/// 审批分级：由风险等级推导出所需的确认强度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalLevel {
    /// 无需人工确认。
    Automatic,
    /// 常规确认（y/N）。
    Standard,
    /// 强化确认（需要输入指定短语）。
    Elevated,
    /// 受限：默认拒绝，仅当显式放开后仍需强化确认。
    Restricted,
}

impl ApprovalLevel {
    /// 由风险等级映射分级，规则集中在此，避免散落硬编码。
    pub fn from_risk(risk: RiskLevel) -> Self {
        match risk {
            RiskLevel::Low => Self::Automatic,
            RiskLevel::Medium => Self::Standard,
            RiskLevel::High => Self::Elevated,
            RiskLevel::Critical => Self::Restricted,
        }
    }

    /// 中文名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Automatic => "自动",
            Self::Standard => "常规确认",
            Self::Elevated => "强化确认",
            Self::Restricted => "受限操作",
        }
    }
}

/// 审批决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// 批准本次。
    Approve,
    /// 批准本次，并在本会话内记住同类操作。
    ApproveForSession,
    /// 拒绝本次。
    Deny,
    /// 拒绝并终止整个循环。
    Abort,
}

impl ApprovalDecision {
    /// 是否放行。
    pub fn is_approved(&self) -> bool {
        matches!(self, Self::Approve | Self::ApproveForSession)
    }

    /// 决策对应的审批状态，供审批记录落盘与回放使用。
    pub fn status(&self) -> ApprovalStatus {
        match self {
            Self::Approve | Self::ApproveForSession => ApprovalStatus::Approved,
            Self::Deny | Self::Abort => ApprovalStatus::Denied,
        }
    }
}

/// 审批请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    /// 请求 id（`ots approvals approve <id>` 使用）。
    pub id: String,
    /// 会话 id。
    pub session_id: String,
    /// 发起时间。
    pub created_at: DateTime<Utc>,
    /// 工具名。
    pub tool: String,
    /// 原始参数。
    pub arguments: Value,
    /// 风险等级。
    pub risk: RiskLevel,
    /// 所需确认分级。
    pub level: ApprovalLevel,
    /// 策略给出的理由。
    pub reason: String,
    /// 命中的策略规则。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    /// 操作预览。
    pub preview: OperationPreview,
    /// 当前状态。
    pub status: ApprovalStatus,
    /// 决策时间。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<DateTime<Utc>>,
    /// 决策来源（`interactive` / `store` / `auto`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    /// 拒绝理由。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ApprovalRequest {
    /// 由策略评估结果构造请求。
    pub fn new(
        session_id: impl Into<String>,
        tool: impl Into<String>,
        arguments: Value,
        risk: RiskLevel,
        reason: impl Into<String>,
        matched_rule: Option<String>,
        preview: OperationPreview,
    ) -> Self {
        Self {
            id: new_id(),
            session_id: session_id.into(),
            created_at: Utc::now(),
            tool: tool.into(),
            arguments,
            risk,
            level: ApprovalLevel::from_risk(risk),
            reason: reason.into(),
            matched_rule,
            preview,
            status: ApprovalStatus::Pending,
            decided_at: None,
            decided_by: None,
            note: None,
        }
    }

    /// 渲染为人类可读的多行摘要。
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("审批请求 {}\n", self.id));
        out.push_str(&format!("  工具     : {}\n", self.tool));
        out.push_str(&format!("  风险     : {}（{}）\n", self.risk.label(), self.level.label()));
        out.push_str(&format!("  理由     : {}\n", self.reason));
        if let Some(rule) = &self.matched_rule {
            out.push_str(&format!("  命中规则 : {rule}\n"));
        }
        let impact = self.preview.impact();
        out.push_str(&format!(
            "  影响范围 : {} 个文件，+{} / -{} 行\n",
            impact.files, impact.additions, impact.deletions
        ));
        if !self.preview.commands.is_empty() {
            out.push_str("  待执行命令:\n");
            for cmd in &self.preview.commands {
                out.push_str(&format!("    $ {cmd}\n"));
            }
        }
        for change in &self.preview.file_changes {
            out.push_str(&format!("  [{}] {} (+{} / -{})\n", change.kind.marker(), change.path, change.additions, change.deletions));
        }
        for path in &self.preview.out_of_scope {
            out.push_str(&format!("  ⚠ 越界路径: {path}\n"));
        }
        for note in &self.preview.notes {
            out.push_str(&format!("  · {note}\n"));
        }
        out
    }
}

/// 生成短 id（前 8 位十六进制，便于人工输入）。
pub fn new_id() -> String {
    let full = uuid::Uuid::new_v4().simple().to_string();
    full[..8].to_string()
}

/// 审批代理契约。
///
/// 由 CLI 层提供实现：交互式终端提示，或基于磁盘存储的「另开终端审批」模式。
#[async_trait]
pub trait ApprovalBroker: Send + Sync {
    /// 生成操作预览。
    ///
    /// # Errors
    /// 无法读取工作区内容以计算 diff 时返回错误。
    async fn preview(&self, tool: &str, arguments: &Value, cwd: &std::path::Path) -> CoreResult<OperationPreview>;

    /// 提交审批请求并等待决策。
    ///
    /// # Errors
    /// 等待过程被取消或超时返回错误。
    async fn request(&self, request: &ApprovalRequest) -> CoreResult<ApprovalDecision>;

    /// 会话内已记住的批准（工具名 → 是否长期放行），用于跳过重复审批。
    fn session_grants(&self) -> BTreeMap<String, bool> {
        BTreeMap::new()
    }

    /// 记录一次「本会话内记住」的批准。
    fn grant_for_session(&self, _tool: &str) {}

    /// 代理名，用于审计。
    fn name(&self) -> &str;
}

/// 一个总是批准/总是拒绝的代理，用于 `--yes` 与测试。
#[derive(Debug, Clone, Copy)]
pub struct FixedBroker {
    /// 是否批准。
    pub approve: bool,
    /// 是否回填空预览。
    pub with_preview: bool,
}

impl FixedBroker {
    /// 总是批准。
    pub fn approve_all() -> Self {
        Self { approve: true, with_preview: false }
    }

    /// 总是拒绝。
    pub fn deny_all() -> Self {
        Self { approve: false, with_preview: false }
    }
}

#[async_trait]
impl ApprovalBroker for FixedBroker {
    /// 生成操作预览（开发者 Jan）：固定代理不做真实预览，仅回一句说明当前模式
    async fn preview(&self, tool: &str, _arguments: &Value, _cwd: &std::path::Path) -> CoreResult<OperationPreview> {
        if self.with_preview {
            Ok(OperationPreview::new(format!("自动批准模式：{tool}")))
        } else {
            Ok(OperationPreview::new(tool.to_string()))
        }
    }

    /// 按构造时的固定结论返回（开发者 Jan）：不询问任何人，用于无人值守或测试场景
    async fn request(&self, _request: &ApprovalRequest) -> CoreResult<ApprovalDecision> {
        Ok(if self.approve { ApprovalDecision::Approve } else { ApprovalDecision::Deny })
    }

    /// 代理标识（开发者 Jan）：固定为 fixed，表明决策与请求内容无关
    fn name(&self) -> &str {
        "fixed"
    }
}
