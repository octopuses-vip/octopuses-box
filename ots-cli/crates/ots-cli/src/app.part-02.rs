
/// 解析 `--args` 传入的 JSON。
fn parse_arguments(raw: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(raw).with_context(|| format!("参数不是合法 JSON: {raw}"))?;
    if !value.is_object() {
        bail!("参数必须是 JSON 对象，例如 --args '{{\"path\":\"README.md\"}}'");
    }
    Ok(value)
}

/// 依据循环结果决定进程退出码。
fn exit_code(outcome: &LoopOutcome) -> ExitCode {
    match outcome.reason {
        TerminationReason::UserInterrupted => ExitCode::from(130),
        reason if reason.is_success() => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

/// 解析工作区种子目录（`--workspace` 或当前目录）。
fn resolve_workspace(cli: &Cli) -> Result<PathBuf> {
    let raw = match &cli.workspace {
        Some(path) => path.clone(),
        None => std::env::current_dir().context("无法确定当前目录")?,
    };
    if !raw.is_dir() {
        bail!("工作区目录不存在: {}", raw.display());
    }
    Ok(canonical_workspace(&raw))
}

/// 规范化工作区：解析软链与 `..`，让后续所有路径比较使用同一形态。
///
/// macOS 上 `/tmp`、`/var` 都是软链，若不统一形态，「工作区内」的判定会时对时错。
fn canonical_workspace(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// 以 `base` 为基准解析相对路径。
fn absolutize(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

/// 装载分层配置。
fn load_config(cli: &Cli, workspace: &Path) -> Result<LoadedConfig> {
    let mut options = LoadOptions::new(workspace).with_cli_overrides(cli_overrides(cli));
    if let Some(path) = &cli.config {
        options = options.with_explicit(absolutize(workspace, path));
    }
    load(&options).map_err(|err| anyhow!("{err}"))
}

/// 把命令行参数翻译成配置补丁。
///
/// 这样「命令行 > 环境变量 > 配置文件」的优先级由配置层统一实现，
/// 各子命令只需读最终的 [`OtsConfig`]，不必到处写 `if let Some(override)`。
fn cli_overrides(cli: &Cli) -> Value {
    let mut patch = Map::new();
    let mut llm = Map::new();
    let mut agent = Map::new();
    let mut approval = Map::new();
    let mut sandbox = Map::new();
    let mut logging = Map::new();

    if let Some(model) = &cli.model {
        llm.insert("model".to_string(), Value::String(model.clone()));
    }
    if let Some(mode) = cli.permission_mode {
        approval.insert("mode".to_string(), Value::String(mode.as_str().to_string()));
    }
    if let Some(backend) = cli.sandbox {
        sandbox.insert("backend".to_string(), Value::String(backend.as_str().to_string()));
    }
    if let Some(level) = &cli.log_level {
        logging.insert("level".to_string(), Value::String(level.clone()));
    }

    match &cli.command {
        Command::Run(args) => {
            if let Some(value) = args.max_iterations {
                agent.insert("max_iterations".to_string(), Value::from(value));
            }
            if let Some(value) = args.quality_threshold {
                agent.insert("quality_threshold".to_string(), Value::from(value));
            }
            if let Some(value) = args.max_duration {
                agent.insert(
                    "max_duration_secs".to_string(),
                    if value == 0 { Value::Null } else { Value::from(value) },
                );
            }
            if let Some(value) = args.max_total_tokens {
                agent.insert(
                    "max_total_tokens".to_string(),
                    if value == 0 { Value::Null } else { Value::from(value) },
                );
            }
            if let Some(value) = args.stall_patience {
                agent.insert("stall_patience".to_string(), Value::from(value));
            }
            if let Some(command) = &args.test_command {
                agent.insert("test_command".to_string(), Value::String(command.clone()));
            }
            if args.no_verify {
                agent.insert("verifier".to_string(), Value::String("none".to_string()));
            } else if let Some(verifier) = args.verifier {
                agent.insert("verifier".to_string(), Value::String(verifier.as_str().to_string()));
            }
            if let Some(value) = args.tool_timeout {
                agent.insert("tool_timeout_secs".to_string(), Value::from(value));
            }
            if let Some(value) = args.tool_concurrency {
                agent.insert("max_tool_concurrency".to_string(), Value::from(value));
            }
        }
        Command::Exec(args) => {
            if let Some(value) = args.tool_timeout {
                agent.insert("tool_timeout_secs".to_string(), Value::from(value));
            }
        }
        _ => {}
    }

    if !llm.is_empty() {
        patch.insert("llm".to_string(), Value::Object(llm));
    }
    if !agent.is_empty() {
        patch.insert("agent".to_string(), Value::Object(agent));
    }
    if !approval.is_empty() {
        patch.insert("approval".to_string(), Value::Object(approval));
    }
    if !sandbox.is_empty() {
        patch.insert("sandbox".to_string(), Value::Object(sandbox));
    }
    if !logging.is_empty() {
        patch.insert("logging".to_string(), Value::Object(logging));
    }
    Value::Object(patch)
}

/// 监听 Ctrl-C 并触发取消。
fn install_interrupt_handler(cancel: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                eprintln!("\n收到中断信号（Ctrl-C），正在停止…");
                cancel.cancel();
            }
            Err(err) => tracing::warn!("无法监听中断信号: {err}"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("ots").chain(args.iter().copied())).expect("参数应可解析")
    }

    #[test]
    fn 全局参数被翻译为配置补丁() {
        let cli = cli(&["--model", "gpt-4o", "--permission-mode", "read-only", "--sandbox", "none", "tools", "list"]);
        let patch = cli_overrides(&cli);
        assert_eq!(patch["llm"]["model"], "gpt-4o");
        assert_eq!(patch["approval"]["mode"], "read-only");
        assert_eq!(patch["sandbox"]["backend"], "none");
    }

    #[test]
    fn run参数进入agent配置() {
        let cli = cli(&["run", "--max-iterations", "3", "--test-command", "cargo test", "--no-verify", "目标"]);
        let patch = cli_overrides(&cli);
        assert_eq!(patch["agent"]["max_iterations"], 3);
        assert_eq!(patch["agent"]["test_command"], "cargo test");
        assert_eq!(patch["agent"]["verifier"], "none");
    }

    #[test]
    fn 时长预算为零时置空表示不限制() {
        let cli = cli(&["run", "--max-duration", "0", "--max-total-tokens", "0", "目标"]);
        let patch = cli_overrides(&cli);
        assert!(patch["agent"]["max_duration_secs"].is_null());
        assert!(patch["agent"]["max_total_tokens"].is_null());
    }

    #[test]
    fn 非对象参数被拒绝() {
        assert!(parse_arguments("[1,2]").is_err());
        assert!(parse_arguments("{不是 JSON").is_err());
        assert_eq!(parse_arguments("{\"a\":1}").expect("解析成功")["a"], 1);
    }

    #[test]
    fn 退出码区分成功中断与失败() {
        let outcome = |reason| LoopOutcome {
            session_id: "s".to_string(),
            iterations: 1,
            reason,
            verification: None,
            final_message: String::new(),
            usage: ots_core::TokenUsage::default(),
            changed_files: Vec::new(),
            error: None,
            duration_ms: 0,
        };
        assert_eq!(exit_code(&outcome(TerminationReason::VerificationPassed)), ExitCode::SUCCESS);
        assert_eq!(exit_code(&outcome(TerminationReason::MaxIterations)), ExitCode::FAILURE);
        assert_eq!(exit_code(&outcome(TerminationReason::UserInterrupted)), ExitCode::from(130));
    }
}

