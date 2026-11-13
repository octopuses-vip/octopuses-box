

/// 单台主机「执行限制」提示词的长度上限（字符）
///
/// 这段文本会在每次远程调用时回灌给模型，不设上限就等于让一个字段无限制地吃上下文窗口；
/// 4000 字符足够写清一份运维红线，超出即拒绝保存并提示，而不是静默截断让用户以为生效了。
pub(super) const GUARD_PROMPT_LIMIT: usize = 4000;

/// 远端静态拒绝清单（开发者 Jan）
///
/// 只拦「几乎不可能属于正常运维」的破坏性动作，用于纵深防御；
/// 是否放行的最终判断始终在人工审批，不依赖这里的结果。
pub(super) fn remote_deny_reason(command: &str) -> Option<String> {
    /// 破坏性命令的首词
    const DENIED_COMMANDS: &[&str] = &["shutdown", "reboot", "halt", "poweroff"];
    /// 可用于提权的前缀，需要在取首词前跳过
    const PRIVILEGE_PREFIXES: &[&str] = &["sudo", "doas", "command", "nohup", "setsid", "nice"];

    let normalized = command.to_ascii_lowercase();
    // 直接在整串上匹配的特征片段
    for pattern in [":(){", "> /dev/sd", "of=/dev/sd", "of=/dev/nvme"] {
        if normalized.contains(pattern) {
            return Some(format!("命令包含高危片段 `{pattern}`，已拒绝执行。"));
        }
    }

    for segment in command.split([';', '|', '&', '\n', '\r']) {
        let mut tokens = segment.split_whitespace();
        // 跳过提权/包装前缀与其选项，露出真正要执行的命令
        let mut head = tokens.next();
        while let Some(token) = head {
            let lowered = token.to_ascii_lowercase();
            if PRIVILEGE_PREFIXES.contains(&lowered.as_str()) || lowered.starts_with('-') {
                head = tokens.next();
                continue;
            }
            break;
        }
        let Some(head) = head else { continue };
        let lowered = head.to_ascii_lowercase();
        if DENIED_COMMANDS.contains(&lowered.as_str()) || lowered.starts_with("mkfs") {
            return Some(format!("命令 `{head}` 会中断主机服务或破坏文件系统，已拒绝执行。"));
        }
        if lowered == "dd" && segment.contains("if=") {
            return Some("命令 `dd` 直写设备，已拒绝执行。".to_string());
        }
        // 递归强制删根：按 token 判定目标，避免 `rm -rf /tmp/x` 被前缀误伤
        if lowered == "rm" && is_recursive_root_delete(segment) {
            return Some("命令递归强制删除文件系统根目录，已拒绝执行。".to_string());
        }
    }
    None
}

/// 该段命令是否为「递归 + 强制删除文件系统根目录」（开发者 Jan）
///
/// 只认目标恰为 `/`（含 `/*`、`/.`）的写法。`rm -rf /tmp/octopuses-cache` 这类清理
/// 属于正常运维，仅凭字符串前缀相同不能一并拦下。
pub(super) fn is_recursive_root_delete(segment: &str) -> bool {
    let mut recursive = false;
    let mut force = false;
    let mut hits_root = false;
    for token in segment.split_whitespace().skip(1) {
        if token.starts_with("--") {
            continue;
        }
        if let Some(flags) = token.strip_prefix('-') {
            let flags = flags.to_ascii_lowercase();
            recursive |= flags.contains('r');
            force |= flags.contains('f');
            continue;
        }
        if matches!(token, "/" | "/*" | "/.") {
            hits_root = true;
        }
    }
    recursive && force && hits_root
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------
