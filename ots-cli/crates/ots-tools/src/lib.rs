//! ots-cli 内置工具集。
//!
//! 每个工具都实现 [`ots_core::Tool`]，且只依赖 [`ots_core::ToolContext`] 提供的
//! 工作区路径、取消令牌与执行守卫，因此与沙箱实现、审批流程完全解耦。
//!
//! 会修改工作区的工具统一在 [`ots_core::ToolResult::data`] 中返回
//! `{ "files": [FileChange, ...] }`，供审批预览与循环统计复用。

pub mod args;
pub mod diff;
pub mod external;
pub mod files;
pub mod patch;
pub mod paths;
pub mod process;
pub mod registry;
pub mod shell;
pub mod skill;
pub mod test_runner;
pub mod verifier;

pub use external::ExternalTool;
pub use files::{ReadFileTool, WriteFileTool};
pub use patch::ApplyPatchTool;
pub use registry::{BUILTIN_TOOL_NAMES, build_registry};
pub use shell::ShellTool;
pub use skill::{SKILLS_DIR_NAME, SKILL_FILE_NAME, UseSkillTool, load_skills, read_skill_body};
pub use test_runner::TestRunnerTool;
pub use verifier::{NoVerifier, TestCommandVerifier};
