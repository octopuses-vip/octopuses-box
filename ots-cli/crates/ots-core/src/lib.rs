//! ots-cli 领域层。
//!
//! 本 crate 只包含纯领域模型与抽象（trait），不直接执行 IO：
//! 网络、文件系统、进程等副作用全部由外层 crate 通过 trait 实现注入。
//! 依赖方向严格单向：其它 crate 依赖 `ots-core`，`ots-core` 不依赖任何 ots-cli crate。

pub mod approval;
pub mod error;
pub mod event;
pub mod generator;
pub mod guard;
pub mod looping;
pub mod message;
pub mod policy;
pub mod prompt;
pub mod skill;
pub mod tool;
pub mod verifier;

pub use approval::{
    ApprovalBroker, ApprovalDecision, ApprovalLevel, ApprovalRequest, ApprovalStatus, FileChange,
    FileChangeKind, FixedBroker, ImpactSummary, OperationPreview, new_id,
};
pub use error::{CoreError, CoreResult};
pub use event::{EventRecord, EventSink, LoopEvent, NullSink, RecordingSink};
pub use generator::{
    Generation, GenerationRequest, Generator, NullSink as NullStreamSink, StreamSink, TokenUsage,
};
pub use guard::{Access, ExecGuard, PermissiveGuard};
pub use looping::{AgentLoop, LoopConfig, LoopOutcome, LoopPolicy, TerminationReason};
pub use message::{Message, Role};
pub use policy::{PermissionMode, PolicyDecision, PolicyEngine, PolicyEvaluation, PolicyQuery, RiskLevel};
pub use prompt::{AgentInstructions, build_system_prompt};
pub use skill::{
    SkillIndexEntry, SkillRegistry, SkillSource, SkillSpec, USE_SKILL_TOOL_NAME, narrow_scope,
};
pub use tool::{
    Tool, ToolCall, ToolContext, ToolError, ToolErrorKind, ToolInvocation, ToolLimits,
    ToolRegistry, ToolResult, ToolRuntime, ToolSpec, truncate_output, validate_arguments,
};
pub use verifier::{Verification, VerificationContext, Verifier};

/// ots-cli 版本号，与 workspace 保持一致。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
