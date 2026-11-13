//! 循环事件与事件接收器。
//!
//! 循环内核只负责「产生事件」，如何呈现（结构化日志、单行进度、JSON 流、审计落盘）
//! 完全由 [`EventSink`] 的实现决定，从而实现展示与逻辑解耦。

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::approval::ApprovalStatus;
use crate::generator::TokenUsage;
use crate::looping::TerminationReason;
use crate::policy::{PolicyDecision, RiskLevel};

/// 循环过程中产生的事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LoopEvent {
    /// 循环开始。
    LoopStarted {
        /// 目标描述。
        goal: String,
        /// 最大迭代数。
        max_iterations: u32,
    },
    /// 进入新一轮迭代。
    IterationStarted {
        /// 迭代序号。
        iteration: u32,
    },
    /// 开始调用模型。
    GenerationStarted {
        /// 模型名。
        model: String,
        /// 上下文消息数。
        message_count: usize,
        /// 可用工具数。
        tool_count: usize,
    },
    /// 模型输出增量（正文）。
    GenerationDelta {
        /// 增量文本。
        text: String,
    },
    /// 模型输出增量（推理）。
    ReasoningDelta {
        /// 增量文本。
        text: String,
    },
    /// 模型调用完成。
    GenerationFinished {
        /// 正文长度（字符）。
        content_chars: usize,
        /// 请求的工具调用数量。
        tool_call_count: usize,
        /// 本次 token 用量。
        usage: TokenUsage,
        /// 结束原因。
        finish_reason: Option<String>,
    },
    /// 收到工具调用。
    ToolCallRequested {
        /// 调用 id。
        call_id: String,
        /// 工具名。
        tool: String,
        /// 参数。
        arguments: serde_json::Value,
    },
    /// 策略评估完成。
    PolicyEvaluated {
        /// 调用 id。
        call_id: String,
        /// 工具名。
        tool: String,
        /// 裁决。
        decision: PolicyDecision,
        /// 风险等级。
        risk: RiskLevel,
        /// 理由。
        reason: String,
    },
    /// 发起审批。
    ApprovalRequested {
        /// 请求 id。
        request_id: String,
        /// 工具名。
        tool: String,
        /// 风险等级。
        risk: RiskLevel,
        /// 预览摘要。
        summary: String,
    },
    /// 审批结束。
    ApprovalResolved {
        /// 请求 id。
        request_id: String,
        /// 状态。
        status: ApprovalStatus,
        /// 决策来源。
        decided_by: String,
    },
    /// 工具开始执行。
    ToolStarted {
        /// 调用 id。
        call_id: String,
        /// 工具名。
        tool: String,
    },
    /// 工具执行结束。
    ToolFinished {
        /// 调用 id。
        call_id: String,
        /// 工具名。
        tool: String,
        /// 是否成功。
        ok: bool,
        /// 退出码。
        exit_code: Option<i32>,
        /// 耗时毫秒。
        duration_ms: u64,
        /// 输出是否被截断。
        truncated: bool,
        /// 失败原因摘要。
        error: Option<String>,
    },
    /// 文件被修改。
    FileChanged {
        /// 相对路径。
        path: String,
        /// 变更类型。
        kind: crate::approval::FileChangeKind,
    },
    /// 开始验证。
    VerificationStarted {
        /// 迭代序号。
        iteration: u32,
        /// 验证器名。
        verifier: String,
    },
    /// 验证结束。
    VerificationFinished {
        /// 迭代序号。
        iteration: u32,
        /// 是否通过。
        passed: bool,
        /// 分数。
        score: f64,
        /// 是否因未配置验证手段而跳过（此时 `passed` 无意义）。
        skipped: bool,
        /// 结论。
        summary: String,
    },
    /// 技能被载入（模型调用了 `use_skill`）。
    SkillLoaded {
        /// 技能名。
        name: String,
        /// 该技能声明的允许工具（空表示不约束）。
        allowed_tools: Vec<String>,
        /// 是否已据此收窄本会话的工具范围。
        scope_applied: bool,
    },
    /// 警告。
    Warning {
        /// 内容。
        message: String,
    },
    /// 错误。
    ErrorOccurred {
        /// 内容。
        message: String,
    },
    /// 循环结束。
    LoopFinished {
        /// 终止原因。
        reason: TerminationReason,
        /// 实际迭代数。
        iterations: u32,
        /// 累计 token 用量。
        usage: TokenUsage,
    },
}

impl LoopEvent {
    /// 事件类型名（用于日志字段）。
    pub fn name(&self) -> &'static str {
        match self {
            Self::LoopStarted { .. } => "loop_started",
            Self::IterationStarted { .. } => "iteration_started",
            Self::GenerationStarted { .. } => "generation_started",
            Self::GenerationDelta { .. } => "generation_delta",
            Self::ReasoningDelta { .. } => "reasoning_delta",
            Self::GenerationFinished { .. } => "generation_finished",
            Self::ToolCallRequested { .. } => "tool_call_requested",
            Self::PolicyEvaluated { .. } => "policy_evaluated",
            Self::ApprovalRequested { .. } => "approval_requested",
            Self::ApprovalResolved { .. } => "approval_resolved",
            Self::ToolStarted { .. } => "tool_started",
            Self::ToolFinished { .. } => "tool_finished",
            Self::FileChanged { .. } => "file_changed",
            Self::VerificationStarted { .. } => "verification_started",
            Self::VerificationFinished { .. } => "verification_finished",
            Self::SkillLoaded { .. } => "skill_loaded",
            Self::Warning { .. } => "warning",
            Self::ErrorOccurred { .. } => "error",
            Self::LoopFinished { .. } => "loop_finished",
        }
    }

    /// 是否为高频流式事件（默认不写入审计文件，避免噪声）。
    pub fn is_high_frequency(&self) -> bool {
        matches!(self, Self::GenerationDelta { .. } | Self::ReasoningDelta { .. })
    }
}

/// 带上下文的事件记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRecord {
    /// 事件时间。
    pub timestamp: DateTime<Utc>,
    /// 会话 id。
    pub session_id: String,
    /// 当前迭代序号。
    pub iteration: u32,
    /// 事件本体。
    #[serde(flatten)]
    pub event: LoopEvent,
}

/// 事件接收器。
pub trait EventSink: Send + Sync {
    /// 接收事件。
    fn emit(&self, record: &EventRecord);

    /// 更新单行进度（默认忽略）。
    fn progress(&self, _text: &str) {}

    /// 清空进度行（默认忽略）。
    fn clear_progress(&self) {}
}

/// 丢弃所有事件的接收器。
#[derive(Debug, Clone, Copy, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    /// 丢弃事件（开发者 Jan）：用于「不需要任何输出」的场景，让调用方无需到处判空
    fn emit(&self, _record: &EventRecord) {}
}

/// 记录到内存的接收器，便于测试与断言。
#[derive(Debug, Default)]
pub struct RecordingSink {
    records: Mutex<Vec<EventRecord>>,
    progress: Mutex<Vec<String>>,
}

impl RecordingSink {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 已记录事件的快照。
    pub fn records(&self) -> Vec<EventRecord> {
        self.records.lock().expect("recording sink 锁未中毒").clone()
    }

    /// 已记录的事件名序列。
    pub fn event_names(&self) -> Vec<&'static str> {
        self.records.lock().expect("recording sink 锁未中毒").iter().map(|r| r.event.name()).collect()
    }

    /// 已记录的进度文本。
    pub fn progress_lines(&self) -> Vec<String> {
        self.progress.lock().expect("recording sink 锁未中毒").clone()
    }
}

impl EventSink for RecordingSink {
    /// 记录一条事件（开发者 Jan）：克隆后存进内存，供测试断言事件序列
    fn emit(&self, record: &EventRecord) {
        self.records.lock().expect("recording sink 锁未中毒").push(record.clone());
    }

    /// 记录一条进度文本（开发者 Jan）：与事件分开存，便于分别断言
    fn progress(&self, text: &str) {
        self.progress.lock().expect("recording sink 锁未中毒").push(text.to_string());
    }
}
