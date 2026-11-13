//! 路径与命令的匹配规则。
//!
//! 策略引擎与执行守卫共用同一套判定口径，避免「策略放行但守卫拦截」这类不一致。

use std::path::{Component, Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use ots_config::SandboxConfig;
use ots_core::{CoreError, CoreResult};
use serde_json::Value;

/// 工具参数中可能承载文件路径的键名。
pub const PATH_KEYS: &[&str] = &["path", "paths", "file", "files", "cwd", "dir", "directory"];
/// 工具参数中可能承载命令文本的键名。
pub const COMMAND_KEYS: &[&str] = &["command", "cmd", "script"];

/// 从参数中按键名收集字符串（同时支持字符串与字符串数组）。
pub fn collect_strings(arguments: &Value, keys: &[&str]) -> Vec<String> {
    let mut collected = Vec::new();
    for key in keys {
        match arguments.get(*key) {
            Some(Value::String(text)) => collected.push(text.clone()),
            Some(Value::Array(items)) => {
                collected.extend(items.iter().filter_map(Value::as_str).map(str::to_string));
            }
            _ => {}
        }
    }
    collected
}

/// 把参数中的路径锚定到工作区并做词法规范化。
///
/// 策略引擎与操作预览共用本函数，保证两者对「同一个路径」的理解完全一致。
pub fn resolve_argument_path(cwd: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    normalize(&joined)
}

/// 一组 glob 路径规则：同时按「工作区相对路径」与「绝对路径」匹配。
#[derive(Debug, Clone, Default)]
pub struct PathGlobs {
    inner: Option<GlobSet>,
}

impl PathGlobs {
    /// 编译 glob 模式集合；全部为空白时表示「没有规则」。
    ///
    /// # Errors
    /// 任一模式非法时返回 [`CoreError::Config`]。
    pub fn compile(patterns: &[String], field: &str) -> CoreResult<Self> {
        if patterns.iter().all(|pattern| pattern.trim().is_empty()) {
            return Ok(Self::default());
        }
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            if pattern.trim().is_empty() {
                continue;
            }
            let glob = Glob::new(pattern)
                .map_err(|err| CoreError::Config(format!("{field} 中的 glob `{pattern}` 非法: {err}")))?;
            builder.add(glob);
        }
        let set = builder
            .build()
            .map_err(|err| CoreError::Config(format!("{field} 的 glob 集合构建失败: {err}")))?;
        Ok(Self { inner: Some(set) })
    }

    /// 是否配置了规则。
    pub fn is_empty(&self) -> bool {
        self.inner.is_none()
    }

    /// 匹配路径。
    pub fn is_match(&self, path: &Path, root: &Path) -> bool {
        let Some(set) = &self.inner else {
            return false;
        };
        let normalized = normalize(path);
        let root = normalize(root);
        let relative = normalized.strip_prefix(&root).unwrap_or(&normalized);
        set.is_match(relative) || set.is_match(&normalized)
    }
}

/// 工作区之外被显式声明可读 / 可写的路径集合。
///
/// 语义：工作区本身永远可读写；`readable_paths` 追加只读范围；
/// `writable_paths` 与 `writable_system_paths` 追加可写范围（自然也可读）。
#[derive(Debug, Clone, Default)]
pub struct ScopeSets {
    readable: PathGlobs,
    writable: PathGlobs,
}

impl ScopeSets {
    /// 从沙箱配置构造。
    ///
    /// # Errors
    /// 配置中的 glob 非法时返回 [`CoreError::Config`]。
    pub fn from_config(config: &SandboxConfig) -> CoreResult<Self> {
        let mut writable_patterns = config.writable_paths.clone();
        writable_patterns.extend(config.writable_system_paths.iter().cloned());
        Ok(Self {
            readable: PathGlobs::compile(&config.readable_paths, "sandbox.readable_paths")?,
            writable: PathGlobs::compile(&writable_patterns, "sandbox.writable_paths")?,
        })
    }

    /// 工作区之外是否允许读取该路径。
    pub fn allows_read(&self, path: &Path, root: &Path) -> bool {
        self.readable.is_match(path, root) || self.writable.is_match(path, root)
    }

    /// 工作区之外是否允许写入该路径。
    pub fn allows_write(&self, path: &Path, root: &Path) -> bool {
        self.writable.is_match(path, root)
    }

    /// 工作区之外的路径是否已被显式声明（按操作是否需要写权限判断）。
    pub fn declares(&self, path: &Path, root: &Path, mutating: bool) -> bool {
        if mutating {
            self.allows_write(path, root)
        } else {
            self.allows_read(path, root)
        }
    }
}

/// 词法规范化：不访问文件系统，仅消除 `.`、`..` 与重复分隔符。
///
/// 对不存在的路径同样有效，因此可以在真正落盘之前判断越界与否。
pub fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !result.pop() {
                    result.push("..");
                }
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    if result.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        result
    }
}

/// 判断 `path` 是否位于 `root` 之内（含与 `root` 相等）。
///
/// 先做词法比较；若两者都能规范化到真实路径（文件已存在、符号链接可解析），
/// 再做一次真实路径比较，以覆盖 macOS 上 `/var` → `/private/var` 之类的软链。
pub fn is_within(root: &Path, path: &Path) -> bool {
    if normalize(path).starts_with(normalize(root)) {
        return true;
    }
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(real_root), Ok(real_path)) => real_path.starts_with(real_root),
        _ => false,
    }
}

/// 判断命令是否以给定前缀开头（含命令链中的任意一段）。
pub fn command_matches_prefix(command: &str, prefix: &str) -> bool {
    let normalized = squash_whitespace(command);
    let prefix = squash_whitespace(prefix);
    if prefix.is_empty() {
        return false;
    }
    if normalized == prefix || normalized.starts_with(&format!("{prefix} ")) {
        return true;
    }
    for separator in ["&&", "||", ";", "|"] {
        if normalized.contains(&format!("{separator} {prefix} ")) || normalized.ends_with(&format!("{separator} {prefix}")) {
            return true;
        }
    }
    false
}

/// 判断命令是否命中任一前缀，返回命中的前缀。
pub fn command_matches_any(command: &str, prefixes: &[String]) -> Option<String> {
    prefixes.iter().find(|prefix| command_matches_prefix(command, prefix)).cloned()
}

/// 把连续空白压缩为单个空格，便于命令比较。
fn squash_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 规范化消除相对段() {
        assert_eq!(normalize(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(normalize(Path::new("a/../../b")), PathBuf::from("../b"));
    }

    #[test]
    fn 判断路径是否在工作区内() {
        assert!(is_within(Path::new("/ws"), Path::new("/ws/src/main.rs")));
        assert!(is_within(Path::new("/ws"), Path::new("/ws")));
        assert!(is_within(Path::new("/ws"), Path::new("/ws/../ws/a")));
        assert!(!is_within(Path::new("/ws"), Path::new("/ws2/a")));
        assert!(!is_within(Path::new("/ws"), Path::new("/etc/passwd")));
    }

    #[test]
    fn 命令前缀匹配() {
        assert!(command_matches_prefix("git status", "git status"));
        assert!(command_matches_prefix("git status -s", "git status"));
        assert!(!command_matches_prefix("git stash", "git status"));
        assert!(command_matches_prefix("cd /tmp && rm -rf /tmp/x", "rm -rf /tmp/x"));
        assert!(!command_matches_prefix("echo 'rm -rf /tmp/x'", "rm -rf /tmp/x"));
        assert!(command_matches_prefix("ls    -la", "ls -la"));
    }

    #[test]
    fn 空前缀不匹配() {
        assert!(!command_matches_prefix("anything", "   "));
    }

    #[test]
    fn 路径glob同时匹配相对与绝对形式() {
        let globs = PathGlobs::compile(&["**/*.pem".to_string(), "/etc/**".to_string()], "test").expect("编译成功");
        assert!(globs.is_match(Path::new("/ws/certs/a.pem"), Path::new("/ws")));
        assert!(globs.is_match(Path::new("/etc/hosts"), Path::new("/ws")));
        assert!(!globs.is_match(Path::new("/ws/src/main.rs"), Path::new("/ws")));
    }

    #[test]
    fn 作用域集合区分读写() {
        let config = SandboxConfig {
            readable_paths: vec!["/data/**".to_string()],
            writable_paths: vec!["/out/**".to_string()],
            ..SandboxConfig::default()
        };
        let scope = ScopeSets::from_config(&config).expect("构造成功");
        assert!(scope.allows_read(Path::new("/data/a.txt"), Path::new("/ws")));
        assert!(!scope.allows_write(Path::new("/data/a.txt"), Path::new("/ws")));
        assert!(scope.allows_write(Path::new("/out/a.txt"), Path::new("/ws")));
        assert!(!scope.allows_read(Path::new("/tmp/a.txt"), Path::new("/ws")));
    }
}
