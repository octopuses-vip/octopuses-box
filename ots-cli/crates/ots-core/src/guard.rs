//! 执行守卫（沙箱在领域层的抽象）。
//!
//! `ots-core` 只定义契约，具体实现（逻辑沙箱 + macOS Seatbelt）位于 `ots-sandbox`。
//! 工具在执行前必须通过守卫解析路径与校验命令，从而实现「低耦合高内聚」。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::CoreResult;

/// 路径访问意图。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// 读取。
    Read,
    /// 写入（含创建、修改、删除）。
    Write,
}

/// 执行守卫契约。
pub trait ExecGuard: Send + Sync {
    /// 校验并解析一个用户/模型给定的路径，越界时返回错误。
    ///
    /// # Errors
    /// 路径越界、命中拒绝规则或无法规范化时返回 [`CoreError::PolicyDenied`]。
    fn resolve_path(&self, path: &Path, access: Access) -> CoreResult<PathBuf>;

    /// 校验一条待执行的 shell 命令，命中禁止规则时返回错误。
    ///
    /// # Errors
    /// 命令命中硬性禁止规则时返回 [`CoreError::PolicyDenied`]。
    fn check_command(&self, program: &str) -> CoreResult<()>;

    /// 执行子进程时注入的环境变量（白名单 + 沙箱补充）。
    ///
    /// 工具会以「清空环境 + 注入本映射」的方式启动子进程，因此实现方必须返回
    /// 完整的可执行环境（至少包含 `PATH`），否则子进程将无法找到可执行文件。
    fn env_overrides(&self) -> BTreeMap<String, String>;

    /// 包装即将执行的程序与参数，默认不改变任何内容。
    ///
    /// 供需要注入外层执行器的后端使用（例如 macOS Seatbelt 会改写为
    /// `sandbox-exec -f <profile> <program> <args...>`）。工具必须在启动子进程前
    /// 调用本方法，从而不必感知任何具体沙箱实现。
    fn wrap_command(&self, program: String, args: Vec<String>) -> (String, Vec<String>) {
        (program, args)
    }

    /// 人类可读的守卫描述，用于日志与审计。
    fn describe(&self) -> String;

    /// 是否处于「完全放行」状态（用于审计标注）。
    fn is_permissive(&self) -> bool {
        false
    }
}

/// 一个不做任何限制的守卫，用于测试与显式 `--dangerously-disable-sandbox` 场景。
#[derive(Debug, Clone, Default)]
pub struct PermissiveGuard;

impl ExecGuard for PermissiveGuard {
/// 函数级说明（开发者 Jan）：执行 resolve_path 的单一职责，并返回可供调用方继续处理的结果。
    fn resolve_path(&self, path: &Path, _access: Access) -> CoreResult<PathBuf> {
        Ok(path.to_path_buf())
    }

/// 函数级说明（开发者 Jan）：执行 check_command 的单一职责，并返回可供调用方继续处理的结果。
    fn check_command(&self, _program: &str) -> CoreResult<()> {
        Ok(())
    }

/// 函数级说明（开发者 Jan）：执行 env_overrides 的单一职责，并返回可供调用方继续处理的结果。
    fn env_overrides(&self) -> BTreeMap<String, String> {
        // 「不做任何限制」意味着子进程继承当前进程的完整环境；
        // 工具以「清空 + 注入」的方式启动子进程，这里必须显式给出全部变量。
        std::env::vars().collect()
    }

/// 函数级说明（开发者 Jan）：执行 describe 的单一职责，并返回可供调用方继续处理的结果。
    fn describe(&self) -> String {
        "沙箱已禁用（无任何路径与命令限制）".to_string()
    }

/// 函数级说明（开发者 Jan）：执行 is_permissive 的单一职责，并返回可供调用方继续处理的结果。
    fn is_permissive(&self) -> bool {
        true
    }
}
