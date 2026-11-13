//! 执行守卫实现：逻辑沙箱与 macOS Seatbelt。
//!
//! 逻辑沙箱负责「路径越界拦截 + 命令黑名单 + 环境变量白名单」；
//! Seatbelt 在其之上再叠加一层由 `sandbox-exec` 强制执行的系统级隔离。
//! 两者都实现了 [`ots_core::ExecGuard`]，对工具完全透明。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ots_config::{OtsConfig, SandboxBackend, SandboxConfig};
use ots_core::{Access, CoreError, CoreResult, ExecGuard, PermissionMode, PermissiveGuard};

use crate::rules::{command_matches_any, is_within, normalize, PathGlobs, ScopeSets};

/// 仅做逻辑隔离的守卫。
pub struct LogicalGuard {
    workspace: PathBuf,
    readonly: bool,
    deny_paths: PathGlobs,
    deny_commands: Vec<String>,
    scope: ScopeSets,
    env: BTreeMap<String, String>,
}

impl LogicalGuard {
    /// 依据配置构造守卫。
    ///
    /// # Errors
    /// 配置中的 glob 非法时返回 [`CoreError::Config`]。
    pub fn new(config: &OtsConfig, workspace: &Path) -> CoreResult<Self> {
        let workspace = normalize(workspace);
        let env: BTreeMap<String, String> = std::env::vars()
            .filter(|(key, _)| config.tools.env_allowlist.iter().any(|allowed| allowed == key))
            .collect();
        if !env.contains_key("PATH") {
            tracing::warn!(
                "tools.env_allowlist 未包含 PATH，子进程将无法找到可执行文件；如需执行命令请加入 PATH"
            );
        }

        Ok(Self {
            workspace,
            readonly: config.approval.mode == PermissionMode::ReadOnly,
            deny_paths: PathGlobs::compile(&config.approval.deny_paths, "approval.deny_paths")?,
            deny_commands: config.approval.deny_commands.clone(),
            scope: ScopeSets::from_config(&config.sandbox)?,
            env,
        })
    }

    /// 工作区根目录。
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

impl ExecGuard for LogicalGuard {
    /// 校验并规范化一个待访问路径（开发者 Jan）。
    ///
    /// 顺序是「先规范化、再匹配禁止规则、最后判读写」：先规范化是为了让 a/../b
    /// 这类写法无法绕过规则匹配；命中 deny_paths 直接拒绝；
    /// readonly 模式下所有写访问一律拒绝，这是沙箱的最后一道逻辑闸门。
    fn resolve_path(&self, path: &Path, access: Access) -> CoreResult<PathBuf> {
        let normalized = normalize(path);
        if self.deny_paths.is_match(&normalized, &self.workspace) {
            return Err(CoreError::PolicyDenied(format!("路径 `{}` 命中禁止规则", normalized.display())));
        }
        if self.readonly && access == Access::Write {
            return Err(CoreError::PolicyDenied("当前为只读模式（read-only），禁止写入操作".to_string()));
        }
        if is_within(&self.workspace, &normalized) {
            return Ok(normalized);
        }
        let allowed = match access {
            Access::Read => self.scope.allows_read(&normalized, &self.workspace),
            Access::Write => self.scope.allows_write(&normalized, &self.workspace),
        };
        if allowed {
            Ok(normalized)
        } else {
            Err(CoreError::PolicyDenied(format!(
                "`{}` 位于工作区之外，需先在 sandbox.readable_paths / sandbox.writable_paths 中声明",
                normalized.display()
            )))
        }
    }

    /// 校验一条待执行的命令（开发者 Jan）：命中 deny_commands 即拒绝，并把命中的规则名写进原因，
    /// 让用户知道是被哪条规则挡下的，而不是只看到一句泛泛的拒绝。
    fn check_command(&self, program: &str) -> CoreResult<()> {
        match command_matches_any(program, &self.deny_commands) {
            Some(rule) => Err(CoreError::PolicyDenied(format!("命令命中禁止规则 `{rule}`"))),
            None => Ok(()),
        }
    }

    /// 返回要注入子进程的环境变量（开发者 Jan）：由白名单筛出，不整份继承父进程环境，
    /// 避免把密钥、令牌之类的变量顺手透传给模型可调用的子进程。
    fn env_overrides(&self) -> BTreeMap<String, String> {
        self.env.clone()
    }

/// 函数级说明（开发者 Jan）：执行 describe 的单一职责，并返回可供调用方继续处理的结果。
    fn describe(&self) -> String {
        format!(
            "逻辑沙箱（工作区 {}，只读 {}，环境变量白名单 {} 项）",
            self.workspace.display(),
            self.readonly,
            self.env.len()
        )
    }
}

/// 逻辑沙箱 + macOS Seatbelt。
#[cfg(target_os = "macos")]
pub struct SeatbeltGuard {
    inner: LogicalGuard,
    profile: String,
}

#[cfg(target_os = "macos")]
impl SeatbeltGuard {
    /// 依据沙箱配置构造守卫。
    ///
    /// # Errors
    /// 内部逻辑守卫构造失败时返回错误。
    pub fn new(config: &OtsConfig, workspace: &Path) -> CoreResult<Self> {
        Ok(Self {
            inner: LogicalGuard::new(config, workspace)?,
            profile: seatbelt_profile(workspace, &config.sandbox),
        })
    }

    /// 生成的 Seatbelt profile 文本（便于 `ots sandbox preview` 展示）。
    pub fn profile(&self) -> &str {
        &self.profile
    }
}

#[cfg(target_os = "macos")]
impl ExecGuard for SeatbeltGuard {
    /// 路径校验（开发者 Jan）：委托给内层逻辑沙箱，先过逻辑规则再由内核规则兜底
    fn resolve_path(&self, path: &Path, access: Access) -> CoreResult<PathBuf> {
        self.inner.resolve_path(path, access)
    }

    /// 校验命令（开发者 Jan）：委托给内层逻辑沙箱，Seatbelt 只负责追加内核级写隔离
    fn check_command(&self, program: &str) -> CoreResult<()> {
        self.inner.check_command(program)
    }

    /// 环境变量白名单（开发者 Jan）：同样委托内层，两种后端共用同一套白名单口径
    fn env_overrides(&self) -> BTreeMap<String, String> {
        self.inner.env_overrides()
    }

/// 函数级说明（开发者 Jan）：执行 wrap_command 的单一职责，并返回可供调用方继续处理的结果。
    fn wrap_command(&self, program: String, args: Vec<String>) -> (String, Vec<String>) {
        let mut wrapped = vec!["-p".to_string(), self.profile.clone(), program];
        wrapped.extend(args);
        (SANDBOX_EXEC.to_string(), wrapped)
    }

/// 函数级说明（开发者 Jan）：执行 describe 的单一职责，并返回可供调用方继续处理的结果。
    fn describe(&self) -> String {
        format!("{} + macOS Seatbelt", self.inner.describe())
    }
}

/// macOS 提供的沙箱执行器。
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// 生成 Seatbelt profile 文本。
///
/// 采用「默认放行 + 收回写权限 + 按需放开」的写法：读操作保持宽松以免破坏编译器等工具链，
/// 写操作只允许工作区、显式声明的目录与系统临时目录。
pub fn seatbelt_profile(workspace: &Path, config: &SandboxConfig) -> String {
    let mut writable: Vec<String> = vec![resolve_profile_path(workspace)];
    for path in config.writable_paths.iter().chain(config.writable_system_paths.iter()) {
        let candidate = Path::new(path);
        let resolved = if candidate.is_absolute() { candidate.to_path_buf() } else { workspace.join(candidate) };
        writable.push(resolve_profile_path(&resolved));
    }
    writable.push(resolve_profile_path(&std::env::temp_dir()));

    let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
    for path in writable {
        profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_profile_path(&path)));
    }
    // 设备文件与标准流的写入不能拦，否则绝大多数命令都会立刻失败。
    profile.push_str("(allow file-write* (subpath \"/dev\"))\n");
    if !config.allow_network {
        profile.push_str("(deny network*)\n");
    }
    if let Some(extra) = &config.seatbelt_profile_extra {
        profile.push_str(extra);
        profile.push('\n');
    }
    profile
}

/// 取路径的真实形态用于写入 profile。
///
/// Seatbelt 匹配的是内核眼中的真实路径，而 macOS 上 `/var`、`/tmp` 等都是指向
/// `/private/...` 的软链：若按字面路径下发规则，工作区内的写入会被判为越界。
/// 路径尚未创建时无法解析软链，此时退回字面路径。
fn resolve_profile_path(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    resolved.to_string_lossy().to_string()
}

/// 转义 profile 字符串中的特殊字符。
fn escape_profile_path(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 依据配置构造执行守卫。
///
/// # Errors
/// 配置中的 glob 非法时返回 [`CoreError::Config`]。
pub fn build_guard(config: &OtsConfig, workspace: &Path) -> CoreResult<Arc<dyn ExecGuard>> {
    if !config.sandbox.enabled || config.sandbox.backend == SandboxBackend::None {
        return Ok(Arc::new(PermissiveGuard));
    }
    match config.sandbox.backend {
        SandboxBackend::Logical => Ok(Arc::new(LogicalGuard::new(config, workspace)?)),
        SandboxBackend::Seatbelt => build_seatbelt(config, workspace),
        SandboxBackend::None => Ok(Arc::new(PermissiveGuard)),
    }
}

#[cfg(target_os = "macos")]
/// 函数级说明（开发者 Jan）：执行 build_seatbelt 的单一职责，并返回可供调用方继续处理的结果。
fn build_seatbelt(config: &OtsConfig, workspace: &Path) -> CoreResult<Arc<dyn ExecGuard>> {
    Ok(Arc::new(SeatbeltGuard::new(config, workspace)?))
}

#[cfg(not(target_os = "macos"))]
/// 函数级说明（开发者 Jan）：执行 build_seatbelt 的单一职责，并返回可供调用方继续处理的结果。
fn build_seatbelt(config: &OtsConfig, workspace: &Path) -> CoreResult<Arc<dyn ExecGuard>> {
    tracing::warn!("sandbox.backend = seatbelt 仅在 macOS 上可用，已回退为逻辑沙箱");
    Ok(Arc::new(LogicalGuard::new(config, workspace)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn config() -> OtsConfig {
        OtsConfig::default()
    }

    #[test]
    fn 工作区内的路径放行() {
        let guard = LogicalGuard::new(&config(), Path::new("/ws")).expect("构造成功");
        let resolved = guard.resolve_path(Path::new("/ws/a/../b.txt"), Access::Write).expect("放行");
        assert_eq!(resolved, PathBuf::from("/ws/b.txt"));
    }

    #[test]
    fn 工作区外的路径被拦截() {
        let guard = LogicalGuard::new(&config(), Path::new("/ws")).expect("构造成功");
        let err = guard.resolve_path(Path::new("/etc/hosts"), Access::Read).expect_err("应拦截");
        assert!(matches!(err, CoreError::PolicyDenied(_)));
    }

    #[test]
    fn 声明的可写路径放行() {
        let mut config = config();
        config.sandbox.writable_paths = vec!["/out/**".to_string()];
        let guard = LogicalGuard::new(&config, Path::new("/ws")).expect("构造成功");
        assert!(guard.resolve_path(Path::new("/out/a.txt"), Access::Write).is_ok());
        assert!(guard.resolve_path(Path::new("/out/a.txt"), Access::Read).is_ok());
    }

    #[test]
    fn 禁止路径被拦截() {
        let guard = LogicalGuard::new(&config(), Path::new("/ws")).expect("构造成功");
        let err = guard.resolve_path(Path::new("/ws/.env"), Access::Write).expect_err("应拦截");
        assert!(err.to_string().contains("禁止规则"));
    }

    #[test]
    fn 只读模式禁止写入() {
        let mut config = config();
        config.approval.mode = PermissionMode::ReadOnly;
        let guard = LogicalGuard::new(&config, Path::new("/ws")).expect("构造成功");
        assert!(guard.resolve_path(Path::new("/ws/a.txt"), Access::Read).is_ok());
        assert!(guard.resolve_path(Path::new("/ws/a.txt"), Access::Write).is_err());
    }

    #[test]
    fn 禁止命令被拦截() {
        let guard = LogicalGuard::new(&config(), Path::new("/ws")).expect("构造成功");
        assert!(guard.check_command("git status").is_ok());
        assert!(guard.check_command("sudo rm -rf /").is_err());
    }

    #[test]
    fn 环境变量按白名单过滤() {
        let mut config = config();
        config.tools.env_allowlist = vec!["PATH".to_string()];
        let guard = LogicalGuard::new(&config, Path::new("/ws")).expect("构造成功");
        let env = guard.env_overrides();
        assert!(env.keys().all(|key| key == "PATH"));
    }

    #[test]
    fn 沙箱关闭时使用宽松守卫() {
        let mut config = config();
        config.sandbox.enabled = false;
        let guard = build_guard(&config, Path::new("/ws")).expect("构造成功");
        assert!(guard.is_permissive());
    }

    #[test]
    fn profile包含工作区与设备写入规则() {
        let config = SandboxConfig {
            writable_system_paths: vec!["/private/tmp".to_string()],
            allow_network: false,
            ..SandboxConfig::default()
        };
        let profile = seatbelt_profile(Path::new("/ws"), &config);
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(subpath \"/ws\")"));
        assert!(profile.contains("(subpath \"/private/tmp\")"));
        assert!(profile.contains("(subpath \"/dev\")"));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn profile使用真实路径以覆盖软链() {
        let dir = tempfile::tempdir().expect("临时目录");
        let profile = seatbelt_profile(dir.path(), &SandboxConfig::default());
        let canonical = dir.path().canonicalize().expect("可解析真实路径");
        assert!(
            profile.contains(&canonical.to_string_lossy().to_string()),
            "profile 必须使用真实路径，否则 macOS 上 /var → /private/var 会让工作区写入被判越界: {profile}"
        );
    }

    /// 构造一个「在沙箱允许范围之外、但当前用户确实可写」的目标路径。
    ///
    /// 不能用 `tempfile::tempdir()`：它位于 `TMPDIR` 之内，而 `TMPDIR` 是沙箱刻意放开
    /// 的目录（编译器需要它），拿它当反例只会得到「写入成功」的假失败。
    #[cfg(target_os = "macos")]
    fn outside_target() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间不应早于 Unix 纪元")
            .as_nanos();
        PathBuf::from("/private/var/tmp").join(format!("ots-sandbox-{}-{stamp}.txt", std::process::id()))
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn seatbelt实际拦截越界写入() {
        // sandbox-exec 在部分 macOS 版本上不可用（返回非 0），此时跳过断言。
        if !Path::new(SANDBOX_EXEC).exists() {
            return;
        }
        let dir = tempfile::tempdir().expect("临时目录");
        let target = outside_target();

        // 对照实验：不加沙箱时同一路径可以写入，说明拦截确实来自沙箱而非权限问题。
        fs::write(&target, b"control").expect("对照写入应成功");
        fs::remove_file(&target).expect("清理对照文件");

        let mut config = config();
        config.sandbox.backend = SandboxBackend::Seatbelt;
        config.sandbox.writable_system_paths = Vec::new();
        let guard = SeatbeltGuard::new(&config, dir.path()).expect("构造成功");

        let (program, args) = guard.wrap_command(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), format!("printf x > {}", target.display())],
        );
        let spec = ots_tools::process::ProcessSpec {
            program,
            args,
            cwd: dir.path().to_path_buf(),
            env: guard.env_overrides(),
            timeout: std::time::Duration::from_secs(30),
        };
        let outcome = ots_tools::process::run(spec, &tokio_util::sync::CancellationToken::new())
            .await
            .expect("启动成功");
        assert!(!outcome.is_success(), "越界写入不应成功: {:?}", outcome.stderr);
        assert!(!target.exists());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn seatbelt允许工作区内写入() {
        if !Path::new(SANDBOX_EXEC).exists() {
            return;
        }
        let dir = tempfile::tempdir().expect("临时目录");
        let mut config = config();
        config.sandbox.backend = SandboxBackend::Seatbelt;
        let guard = SeatbeltGuard::new(&config, dir.path()).expect("构造成功");

        let target = dir.path().join("ok.txt");
        let (program, args) = guard.wrap_command(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), format!("printf hi > {}", target.display())],
        );
        let spec = ots_tools::process::ProcessSpec {
            program,
            args,
            cwd: dir.path().to_path_buf(),
            env: guard.env_overrides(),
            timeout: std::time::Duration::from_secs(30),
        };
        let outcome = ots_tools::process::run(spec, &tokio_util::sync::CancellationToken::new())
            .await
            .expect("启动成功");
        assert!(outcome.is_success(), "stderr={}", outcome.stderr);
        assert_eq!(fs::read_to_string(&target).expect("读回"), "hi");
    }
}
