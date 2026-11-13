//! ots-cli 审批沙箱。
//!
//! 本 crate 把「谁能做什么」落成可执行的机制，分三层：
//!
//! | 层 | 模块 | 职责 |
//! |----|------|------|
//! | 策略 | [`policy`] | 把配置翻译成单次调用的裁决（放行 / 审批 / 拒绝） |
//! | 审批 | [`approval`] | 操作预览、审批记录持久化、交互式与跨进程审批 |
//! | 隔离 | [`guard`] | 逻辑沙箱（路径越界 + 命令黑名单 + 环境白名单）与 macOS Seatbelt |
//!
//! 三层的判定口径统一由 [`rules`] 提供，避免出现「策略放行、守卫又拦截」这类矛盾结论。

pub mod approval;
pub mod guard;
pub mod policy;
pub mod preview;
pub mod rules;

pub use approval::{
    default_store_path, ApprovalEntry, ApprovalStore, DeferredBroker, InteractiveBroker, Prompter,
    StdioPrompter, DEFAULT_STORE_DIR, DEFAULT_STORE_FILE,
};
pub use guard::{build_guard, seatbelt_profile, LogicalGuard, SANDBOX_EXEC};
pub use policy::SandboxPolicyEngine;
pub use preview::PreviewBuilder;
pub use rules::{
    collect_strings, command_matches_any, command_matches_prefix, is_within, normalize,
    resolve_argument_path, PathGlobs, ScopeSets, COMMAND_KEYS, PATH_KEYS,
};

#[cfg(target_os = "macos")]
pub use guard::SeatbeltGuard;
