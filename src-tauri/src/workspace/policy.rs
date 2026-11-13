//! 命令分类策略；此模块不执行命令。
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandDecision {
    Allow,
    Ask,
    Deny,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandPolicyResult {
    pub(super) decision: CommandDecision,
    pub(super) reason: String,
}

/// 按 shell 语法把一条命令拆成若干可独立判定的命令段（开发者 Jan）。
///
/// 逐字符扫描并跟踪引号状态，让引号里的 `;` `|` `&&` 不参与切分；
/// 拆段的目的是让 `ls && rm -rf /` 这类拼接命令里每一段都单独过危险规则，
/// 避免只看首个命令就整体放行。
fn split_command_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(active) = quote {
            current.push(ch);
            if ch == active {
                quote = None;
            } else if ch == '\\' && active == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
            continue;
        }
        let separator = match ch {
            ';' | '\n' => true,
            '|' | '&' if chars.peek() == Some(&ch) => {
                chars.next();
                true
            }
            '|' => true,
            _ => false,
        };
        if separator {
            if !current.trim().is_empty() {
                segments.push(current.trim().to_string());
            }
            current.clear();
        } else {
            current.push(ch);
        }
    }
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    segments
}

/// 归一化命令段（开发者 Jan）：折叠连续空白并转小写，
/// 使 `Cargo  Test` 与 `cargo test` 命中同一套放行规则。
fn normalized_command(segment: &str) -> String {
    segment
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// 判断归一化命令是否以某条放行规则开头（开发者 Jan）。
///
/// 必须是整词匹配：`ls` 规则不能顺带放行 `lsof`，因此额外要求规则后面紧跟空格或直接结束。
fn command_starts_with(normalized: &str, rule: &str) -> bool {
    normalized == rule || normalized.starts_with(&format!("{rule} "))
}

/// 把命令段切成小写化的词元（开发者 Jan），顺带剥掉词元两端的引号，
/// 便于按「可执行文件 + 参数」的形态识别危险命令。
fn command_tokens(segment: &str) -> Vec<String> {
    segment
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch| matches!(ch, '\'' | '"'))
                .to_ascii_lowercase()
        })
        .collect()
}

/// 定位真正的可执行文件在词元里的下标（开发者 Jan）。
///
/// 跳过 `env` / `command` / `nohup` 这类包装器与 `FOO=bar` 形式的环境变量前缀，
/// 否则 `env rm -rf /` 会被误判成「执行 env」，从而绕过危险命令识别。
fn executable_index(tokens: &[String]) -> usize {
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if matches!(token.as_str(), "env" | "command" | "nohup") || token.contains('=') {
            index += 1;
            continue;
        }
        break;
    }
    index
}

/// 判断命令段是否命中不可绕过的危险规则（开发者 Jan），命中则返回规则名。
///
/// 只覆盖「无论用户是否授权都必须拒绝」的破坏性命令：提权、嵌套 shell、`rm -rf`、
/// `git reset --hard` / `git clean -f`、磁盘与系统管理命令、`dd if=`、fork 炸弹等。
/// 判定基于可执行文件名与参数组合，因此先经 [`executable_index`] 剥掉包装器再逐条比对。
fn dangerous_rule(segment: &str) -> Option<&'static str> {
    let tokens = command_tokens(segment);
    let executable = executable_index(&tokens);
    let command = tokens.get(executable).map(|token| {
        Path::new(token)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(token)
    })?;
    let args = &tokens[executable + 1..];

    if matches!(command, "sudo" | "su") {
        return Some("提权命令");
    }
    if matches!(command, "sh" | "bash" | "zsh" | "fish" | "dash")
        && args.iter().any(|arg| arg == "-c" || arg == "-lc")
    {
        return Some("嵌套 shell 命令");
    }
    if command == "rm" {
        let recursive = args
            .iter()
            .any(|arg| arg == "--recursive" || (arg.starts_with('-') && arg.contains('r')));
        let force = args
            .iter()
            .any(|arg| arg == "--force" || (arg.starts_with('-') && arg.contains('f')));
        if recursive && force {
            return Some("rm -rf");
        }
    }
    if command == "git" {
        if let Some(reset) = args.iter().position(|arg| arg == "reset") {
            if args[reset + 1..].iter().any(|arg| arg == "--hard") {
                return Some("git reset --hard");
            }
        }
        if let Some(clean) = args.iter().position(|arg| arg == "clean") {
            if args[clean + 1..]
                .iter()
                .any(|arg| arg == "--force" || (arg.starts_with('-') && arg.contains('f')))
            {
                return Some("git clean -f");
            }
        }
    }
    if matches!(
        command,
        "shutdown"
            | "reboot"
            | "halt"
            | "poweroff"
            | "mkfs"
            | "fdisk"
            | "parted"
            | "mount"
            | "umount"
    ) {
        return Some("系统或磁盘管理命令");
    }
    if command == "diskutil"
        && args
            .iter()
            .any(|arg| arg.starts_with("erase") || arg.starts_with("partition"))
    {
        return Some("diskutil erase/partition");
    }
    if command == "dd" && args.iter().any(|arg| arg.starts_with("if=")) {
        return Some("dd if=");
    }
    if normalized_command(segment).contains(":(){") {
        return Some(":(){");
    }
    None
}

/// 判定一条命令的处置档位（开发者 Jan）：Allow / Ask / Deny。
///
/// 顺序固定为「先拒绝、再放行、最后才问」，避免放行规则覆盖危险规则：
/// 1. 空命令直接拒绝；
/// 2. 含反引号 / `$(` / `>(` / `<(` 等动态展开时拒绝——静态分类无法可靠判断其真实意图；
/// 3. 逐段过 [`dangerous_rule`]，任一段命中即整体拒绝（不可被用户授权绕过）；
/// 4. 仅在用户开启「信任只读命令」时，全部命令段都命中白名单才放行；
/// 5. 其余一律转人工确认（Ask），交由审批卡片处理。
pub(super) fn classify_command(command: &str, trust_read_only: bool) -> CommandPolicyResult {
    let command = command.trim();
    if command.is_empty() {
        return CommandPolicyResult {
            decision: CommandDecision::Deny,
            reason: "命令不能为空".to_string(),
        };
    }
    if command.contains('`')
        || command.contains("$(")
        || command.contains(">(")
        || command.contains("<(")
    {
        return CommandPolicyResult {
            decision: CommandDecision::Deny,
            reason: "命令包含无法可靠静态分类的动态 shell 展开".to_string(),
        };
    }
    let segments = split_command_segments(command);
    if segments.is_empty() {
        return CommandPolicyResult {
            decision: CommandDecision::Deny,
            reason: "命令不能为空".to_string(),
        };
    }
    for segment in &segments {
        if let Some(rule) = dangerous_rule(segment) {
            return CommandPolicyResult {
                decision: CommandDecision::Deny,
                reason: format!("命令段 `{segment}` 命中不可绕过的危险规则 `{rule}`"),
            };
        }
    }
    if trust_read_only {
        let allow = [
            "cargo test",
            "cargo check",
            "cargo clippy",
            "cargo fmt --check",
            "npm test",
            "npm run test",
            "npm run build",
            "pnpm test",
            "pnpm build",
            "pnpm run build",
            "yarn test",
            "yarn build",
            "git status",
            "git diff",
            "git log",
            "git show",
            "git branch",
            "git rev-parse",
            "ls",
            "pwd",
            "node --version",
            "npm --version",
            "pnpm --version",
            "rustc --version",
            "cargo --version",
        ];
        let all_allowed = segments.iter().all(|segment| {
            let normalized = normalized_command(segment);
            allow
                .iter()
                .any(|rule| command_starts_with(&normalized, rule))
        });
        if all_allowed {
            return CommandPolicyResult {
                decision: CommandDecision::Allow,
                reason: "所有命令段均为受信任的只读或验证命令".to_string(),
            };
        }
    }
    CommandPolicyResult {
        decision: CommandDecision::Ask,
        reason: "命令未命中自动放行规则，需要用户确认".to_string(),
    }
}
