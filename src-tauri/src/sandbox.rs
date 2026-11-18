//! macOS Seatbelt 内核级写隔离。
//!
//! 桌面端对模型触发的命令原本只有一层软约束（策略分类 + 用户审批）：一旦命中白名单自动放行、
//! 或用户点了批准，命令就以用户账户的完整权限跑起来，可以往任意路径写文件。本模块把 CLI 侧
//! 已验证的 Seatbelt 方案移植过来，在执行前用 `sandbox-exec` 套一层由内核强制执行的隔离：
//! **读与进程派生全部放行，只收回写权限，再按需放开白名单目录**。
//!
//! 策略（是否启用、是否允许网络）由前端传入，本模块保持无状态；`sandbox-exec` 在部分 macOS
//! 版本上不可用时降级为原行为，并由 [`is_available`] 如实反馈，不静默。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// macOS 提供的沙箱执行器
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// 沙箱可用性探测结果：一次探测后缓存，避免每条命令都起一个探针进程
static AVAILABLE: OnceLock<bool> = OnceLock::new();

/// 一次执行的沙箱策略
#[derive(Clone, Copy)]
pub struct SandboxOptions {
    /// 是否启用内核沙箱
    pub enabled: bool,
    /// 是否允许子进程访问网络
    pub allow_network: bool,
}

/// 沙箱是否可用：仅 macOS、`sandbox-exec` 存在且探针能跑通
pub fn is_available() -> bool {
    *AVAILABLE.get_or_init(|| if cfg!(target_os = "macos") { probe_exec(Path::new(SANDBOX_EXEC)) } else { crate::sandbox_cross::available() })
}

/// 探针：用一条空 profile 跑 `/usr/bin/true`，返回是否成功。
///
/// 单独抽出来是为了能注入假路径做测试，不依赖真机状态。
fn probe_exec(exec: &Path) -> bool {
    if !exec.is_file() {
        return false;
    }
    Command::new(exec)
        .arg("-p")
        .arg("(version 1)(allow default)")
        .arg("/usr/bin/true")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 把 `sh -lc <command>` 改写成 `sandbox-exec -p <profile> /bin/sh -lc <command>`。
///
/// 返回 `None` 表示不启用沙箱（开关关闭或沙箱不可用），调用方按原样执行。
pub fn wrap_shell_command(
    command: &str,
    workspace: &Path,
    options: SandboxOptions,
) -> Option<(String, Vec<String>)> {
    if !options.enabled || !is_available() {
        return None;
    }
    if !cfg!(target_os = "macos") { return crate::sandbox_cross::wrap(command, workspace, options.allow_network); }
    Some((
        SANDBOX_EXEC.to_string(),
        vec![
            "-p".to_string(),
            seatbelt_profile(workspace, options.allow_network),
            "/bin/sh".to_string(),
            "-lc".to_string(),
            command.to_string(),
        ],
    ))
}

/// 生成 Seatbelt profile 文本：默认放行 + 收回写权限 + 按需放开白名单。
pub fn seatbelt_profile(workspace: &Path, allow_network: bool) -> String {
    let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
    for path in writable_paths(workspace) {
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            escape_profile_path(&path)
        ));
    }
    // 设备文件与标准流的写入不能拦，否则绝大多数命令会立刻失败
    profile.push_str("(allow file-write* (subpath \"/dev\"))\n");
    if !allow_network {
        profile.push_str("(deny network*)\n");
    }
    profile
}

/// 允许写入的目录：工作区 + 临时目录 + 常见工具链缓存。
///
/// 工具链缓存不可省：漏掉 `.m2` / `.gradle` 会直接打断 Maven、Gradle 构建，`.cargo` / `.npm`
/// 同理。全部先解析真实路径再去重（macOS 上 `/tmp` 与 `/var` 都是指向 `/private/...` 的软链）。
fn writable_paths(workspace: &Path) -> Vec<String> {
    let mut candidates: Vec<PathBuf> = vec![
        workspace.to_path_buf(),
        std::env::temp_dir(),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/tmp"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for relative in [
            ".cargo",
            ".rustup",
            ".npm",
            ".cache",
            "Library/pnpm",
            "Library/Caches",
            ".m2",
            ".gradle",
            "go",
        ] {
            candidates.push(home.join(relative));
        }
    }

    let mut out: Vec<String> = Vec::new();
    for path in candidates {
        let resolved = resolve_profile_path(&path);
        if !out.contains(&resolved) {
            out.push(resolved);
        }
    }
    out
}

/// 取路径的真实形态用于写入 profile。
///
/// Seatbelt 匹配的是内核眼中的真实路径，而 macOS 上 `/var`、`/tmp` 等都是指向 `/private/...`
/// 的软链：若按字面路径下发规则，工作区内的写入会被判为越界。路径尚未创建时无法解析软链，
/// 此时退回字面路径。
fn resolve_profile_path(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    resolved.to_string_lossy().to_string()
}

/// 转义 profile 字符串里的反斜杠与双引号
fn escape_profile_path(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 从 stderr 判断命令是否被沙箱拦下：Seatbelt 拒绝写入时内核返回 EPERM
pub fn looks_denied(stderr: &str) -> bool {
    stderr.contains("Operation not permitted")
}

/// 命令被拦截时追加的可读说明，让模型知道下一步能怎么做，而不是干瞪眼
pub fn denial_hint(workspace: &Path) -> String {
    format!(
        "\n[内核沙箱] 命令写入超出允许范围，已被系统拦截（Operation not permitted）。当前允许写入：{}。\
         请改在工作区内完成写入；确需写其他目录时，由用户在「设置 → 命令审批」里调整内核沙箱开关。\n",
        writable_paths(workspace).join("、")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ots-sandbox-test-{}-{}",
            std::process::id(),
            name
        ));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn profile_denies_writes_and_opens_whitelist() {
        let workspace = scratch("profile");
        let profile = seatbelt_profile(&workspace, true);
        assert!(profile.contains("(allow default)"));
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(allow file-write* (subpath \"/dev\"))"));
        let resolved = workspace.canonicalize().expect("解析工作区失败");
        assert!(
            profile.contains(&format!("(subpath \"{}\")", resolved.display())),
            "profile 缺少工作区白名单：{profile}"
        );
        assert!(!profile.contains("(deny network*)"));
        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn network_denied_only_when_disabled() {
        let workspace = scratch("network");
        assert!(seatbelt_profile(&workspace, false).contains("(deny network*)"));
        assert!(!seatbelt_profile(&workspace, true).contains("(deny network*)"));
        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn escapes_quotes_and_backslashes_in_profile_paths() {
        assert_eq!(escape_profile_path("/a\"b\\c"), "/a\\\"b\\\\c");
        assert_eq!(escape_profile_path("/plain"), "/plain");
    }

    #[test]
    fn missing_exec_is_unavailable() {
        assert!(!probe_exec(Path::new("/no/such/dir/ots-sandbox-exec")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn profile_resolves_symlinked_paths() {
        // /tmp 是指向 /private/tmp 的软链；按字面路径下发会让工作区内写入被判越界
        assert_eq!(resolve_profile_path(Path::new("/tmp")), "/private/tmp");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn blocks_write_outside_workspace_and_allows_inside() {
        // sandbox-exec 在部分 macOS 版本上不可用（返回非 0），此时跳过断言
        if !is_available() {
            return;
        }
        let workspace = scratch("real");
        let outside = Path::new("/private/var/tmp/ots-sandbox-write-probe.txt");
        let options = SandboxOptions {
            enabled: true,
            allow_network: true,
        };
        let timeout = Duration::from_secs(30);

        // 对照组：不加沙箱时同一路径可写，用来证明拦截确实来自沙箱
        let _ = fs::remove_file(outside);
        let probe = format!("printf x > {}", outside.display());
        crate::shell::run_with_timeout(&probe, Some(&workspace), timeout).expect("对照组执行失败");
        assert!(outside.exists(), "对照组应能写入工作区外路径");
        let _ = fs::remove_file(outside);

        // 沙箱组：越界写入应被内核拦下，并回填可读说明
        let blocked =
            crate::shell::run_sandboxed(&probe, Some(&workspace), timeout, &workspace, options)
                .expect("执行命令失败");
        assert_ne!(
            blocked.exit_code,
            Some(0),
            "越界写入不应成功：{}",
            blocked.stderr
        );
        assert!(!outside.exists(), "越界写入不应产生文件");
        assert!(
            blocked.stderr.contains("内核沙箱"),
            "应追加可读说明：{}",
            blocked.stderr
        );

        // 工作区内写入必须正常，否则沙箱会打断日常构建
        let inside = workspace.join("ok.txt");
        let allowed = format!("printf hi > {}", inside.display());
        let result =
            crate::shell::run_sandboxed(&allowed, Some(&workspace), timeout, &workspace, options)
                .expect("执行命令失败");
        assert_eq!(
            result.exit_code,
            Some(0),
            "工作区内写入应成功：{}",
            result.stderr
        );
        assert_eq!(fs::read_to_string(&inside).expect("读取失败"), "hi");

        fs::remove_dir_all(&workspace).ok();
    }
}
