
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use ots_config::{
    load, project_config_path, to_toml, user_config_path, validate, LoadOptions, LoadedConfig,
    OtsConfig, VerifierKind,
};
use ots_core::{
    build_system_prompt, new_id, AgentInstructions, AgentLoop, ApprovalBroker, ApprovalDecision,
    ApprovalRequest, EventSink, ExecGuard, FixedBroker, LoopConfig, LoopOutcome, LoopPolicy,
    PolicyDecision, PolicyEngine, PolicyQuery, SkillRegistry, TerminationReason, ToolContext,
    ToolInvocation, ToolLimits, ToolRuntime, Verifier,
};
use ots_llm::{LlmClientConfig, OpenAiCompatGenerator};
use ots_sandbox::{
    build_guard, seatbelt_profile, ApprovalStore, DeferredBroker, InteractiveBroker, PreviewBuilder,
    SandboxPolicyEngine, StdioPrompter,
};
use ots_tools::{
    build_registry, load_skills, read_skill_body, NoVerifier, TestCommandVerifier, BUILTIN_TOOL_NAMES,
};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::cli::{
    ApprovalsCommand, Cli, Command, ConfigCommand, ExecArgs, LogFormatArg, RunArgs, SandboxCommand,
    SkillsCommand, ToolsCommand,
};
use crate::sink::{self, AuditWriter, ConsoleEventSink, JsonEventSink, MultiSink, AUDIT_RELATIVE_PATH};

/// 项目指令文件注入系统提示时的上限（字节）。
const INSTRUCTIONS_LIMIT_BYTES: usize = 32 * 1024;

/// 程序入口：装载配置、初始化日志、分发子命令。
///
/// # Errors
/// 配置加载失败、依赖组装失败或命令执行失败时返回错误。
pub async fn run(cli: Cli) -> Result<ExitCode> {
    let seed = resolve_workspace(&cli)?;
    let mut loaded = load_config(&cli, &seed)?;
    let mut workspace = seed.clone();

    // `project.workspace` 可以把工作区重定向到别处；重定向后需要按新工作区重新装载，
    // 否则项目级配置会取自错误的目录。
    if let Some(project) = loaded.config.project.workspace.clone() {
        let candidate = canonical_workspace(&absolutize(&seed, &project));
        if candidate != workspace {
            workspace = candidate;
            loaded = load_config(&cli, &workspace)?;
        }
    }

    let level = cli.log_level.clone().unwrap_or_else(|| loaded.config.logging.level.clone());
    let format = cli.log_format.map(LogFormatArg::to_config).unwrap_or(loaded.config.logging.format);
    sink::init_tracing(&level, format);

    let app = App { cli, workspace, config: loaded.config.clone(), loaded };
    app.report_validation()?;
    app.dispatch().await
}

/// 单次进程内的应用上下文。
struct App {
    cli: Cli,
    workspace: PathBuf,
    config: OtsConfig,
    loaded: LoadedConfig,
}

/// 运行时依赖组合。
struct Composition {
    runtime: Arc<ToolRuntime>,
    guard: Arc<dyn ExecGuard>,
    policy: Arc<dyn PolicyEngine>,
    previews: Arc<PreviewBuilder>,
    skills: Arc<SkillRegistry>,
}

impl App {
    /// 是否需要把结果输出为 JSON。
    fn json(&self) -> bool {
        self.cli.json || self.config.logging.format == ots_config::LogFormat::Json
    }

    /// 校验配置：诊断类子命令只提示，其余子命令遇到致命问题直接终止。
    fn report_validation(&self) -> Result<()> {
        let report = validate(&self.config, BUILTIN_TOOL_NAMES);
        // `config validate` 会把这些提醒打印到 stdout，再走一遍日志就重复了。
        if !self.wants_validation_report() {
            for warning in &report.warnings {
                tracing::warn!("{warning}");
            }
        }
        let diagnostic = matches!(
            self.cli.command,
            Command::Config(ConfigCommand::Validate | ConfigCommand::Show | ConfigCommand::Path | ConfigCommand::Init { .. })
        );
        if !report.errors.is_empty() && !diagnostic && !self.cli.skip_validate {
            let mut message = String::from("配置校验未通过：\n");
            for error in &report.errors {
                message.push_str(&format!("  - {error}\n"));
            }
            message.push_str("（可执行 `ots config validate` 查看详情）");
            bail!(message);
        }
        Ok(())
    }

    /// 该子命令是否会自己完整展示校验结果。
    fn wants_validation_report(&self) -> bool {
        matches!(self.cli.command, Command::Config(ConfigCommand::Validate))
    }

    /// 组装运行时依赖。
    fn compose(&self) -> Result<Composition> {
        let skills = Arc::new(self.load_skills());
        let registry = build_registry(&self.config, Arc::clone(&skills)).context("组装工具注册表失败")?;
        let specs = registry.specs();
        let guard = build_guard(&self.config, &self.workspace).context("构造沙箱守卫失败")?;
        let policy = Arc::new(
            SandboxPolicyEngine::new(&self.config, &specs).context("构造策略引擎失败")?,
        );
        let limits = ToolLimits {
            timeout: Duration::from_secs(self.config.agent.tool_timeout_secs),
            max_output_bytes: self.config.tools.max_output_bytes,
        };
        let runtime = Arc::new(ToolRuntime::new(registry, limits));
        let previews = Arc::new(PreviewBuilder::new(
            Arc::clone(&runtime),
            Arc::clone(&guard),
            self.workspace.clone(),
        ));
        Ok(Composition { runtime, guard, policy, previews, skills })
    }

    /// 按配置与工作区装载技能（`ots skills` 与循环共用同一条装载路径）。
    fn load_skills(&self) -> SkillRegistry {
        load_skills(&self.config, &self.workspace)
    }

    /// 按环境选择审批代理：`--yes` 自动批准；有终端则交互式，否则落盘等待外部审批。
    fn broker(&self, composition: &Composition) -> Arc<dyn ApprovalBroker> {
        if self.cli.yes {
            return Arc::new(FixedBroker::approve_all());
        }
        if std::io::stdin().is_terminal() {
            Arc::new(InteractiveBroker::new(
                Arc::new(StdioPrompter::new()),
                Arc::clone(&composition.previews),
                &self.config.approval,
            ))
        } else {
            let store = ApprovalStore::from_config(&self.config.approval, &self.workspace);
            Arc::new(DeferredBroker::new(
                store,
                Arc::clone(&composition.previews),
                self.config.approval.deferred_wait_secs,
            ))
        }
    }

    /// 按配置选择验证器。
    fn verifier(&self, composition: &Composition) -> Arc<dyn Verifier> {
        match self.config.agent.verifier {
            VerifierKind::None => Arc::new(NoVerifier),
            VerifierKind::TestCommand => Arc::new(TestCommandVerifier::new(
                self.config.agent.test_command.clone().unwrap_or_default(),
                Arc::clone(&composition.guard),
                Duration::from_secs(self.config.agent.tool_timeout_secs),
            )),
        }
    }

    /// 构造模型生成器。
    fn generator(&self) -> Result<Arc<dyn ots_core::Generator>> {
        let llm = &self.config.llm;
        let api_key = llm
            .api_key
            .clone()
            .filter(|key| !key.trim().is_empty())
            .or_else(|| std::env::var(&llm.api_key_env).ok().filter(|key| !key.trim().is_empty()));
        if api_key.is_none() {
            bail!(
                "未找到 API Key：请设置环境变量 {}，或在配置中填写 llm.api_key",
                llm.api_key_env
            );
        }
        let client = LlmClientConfig::new(llm.base_url.clone(), self.model())
            .with_api_key(api_key)
            .with_api_key_env(llm.api_key_env.clone())
            .with_organization(llm.organization.clone())
            .with_sampling(llm.temperature, llm.max_tokens)
            .with_timeout_secs(llm.timeout_secs)
            .with_stream(llm.stream)
            .with_max_retries(llm.max_retries)
            .with_extras(llm.extra_headers.clone(), llm.extra_body.clone());
        Ok(Arc::new(OpenAiCompatGenerator::new(client)))
    }

    /// 生效的模型名（命令行优先）。
    fn model(&self) -> String {
        self.cli.model.clone().unwrap_or_else(|| self.config.llm.model.clone())
    }

    /// 构造事件接收器：控制台（或 JSON 流）+ 审计文件。
    fn event_sink(&self) -> Result<Arc<dyn EventSink>> {
        let mut sinks: Vec<Arc<dyn EventSink>> = Vec::new();
        if self.json() {
            sinks.push(Arc::new(JsonEventSink));
        } else {
            let progress = self.config.logging.progress && !self.cli.no_progress;
            sinks.push(Arc::new(ConsoleEventSink::new(progress, self.cli.show_reasoning)));
        }

        let audit_path = match &self.config.logging.audit_path {
            Some(path) => absolutize(&self.workspace, path),
            None => self.workspace.join(AUDIT_RELATIVE_PATH),
        };
        let audit = AuditWriter::open(&audit_path)
            .with_context(|| format!("无法打开审计文件 {}", audit_path.display()))?;
        tracing::debug!("审计日志: {}", audit.path().display());
        sinks.push(Arc::new(audit));

        Ok(Arc::new(MultiSink::new(sinks)))
    }

    /// 读取项目指令文件并拼接。
    fn project_instructions(&self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        for name in &self.config.agent.instructions_files {
            if name.trim().is_empty() {
                continue;
            }
            let path = absolutize(&self.workspace, Path::new(name));
            match std::fs::read_to_string(&path) {
                Ok(text) if !text.trim().is_empty() => {
                    parts.push(format!("（来自 {}）\n{}", name, text.trim()));
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => tracing::warn!("读取项目指令 {} 失败: {err}", path.display()),
            }
        }
        if parts.is_empty() {
            return None;
        }
        let joined = parts.join("\n\n");
        let (text, truncated) = ots_core::truncate_output(&joined, INSTRUCTIONS_LIMIT_BYTES);
        if truncated {
            tracing::warn!("项目指令超过 {INSTRUCTIONS_LIMIT_BYTES} 字节，已截断");
        }
        Some(text)
    }

    /// 构造系统提示词。
    fn system_prompt(&self, composition: &Composition) -> String {
        let verification = match self.config.agent.verifier {
            VerifierKind::None => None,
            VerifierKind::TestCommand => self
                .config
                .agent
                .test_command
                .as_deref()
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .map(|command| format!("项目验证命令：`{command}`，退出码 0 视为通过。")),
        };
        let instructions = AgentInstructions {
            workspace: self.workspace.display().to_string(),
            mode: composition.policy.mode(),
            tools: composition.runtime.registry().names(),
            project_instructions: self.project_instructions(),
            extra_system_prompt: self.config.agent.system_prompt_extra.clone(),
            sandbox: composition.guard.describe(),
            verification,
            // 只放「名称 + 描述」索引，正文等模型调用 `use_skill` 时再读入。
            skills: composition.skills.index(),
        };
        build_system_prompt(&instructions)
    }

    /// 构造循环配置。
    fn loop_config(&self, composition: &Composition) -> LoopConfig {
        let agent = &self.config.agent;
        let mut config = LoopConfig::new(self.workspace.clone(), self.model(), self.system_prompt(composition));
        config.policy = LoopPolicy {
            max_iterations: agent.max_iterations,
            quality_threshold: agent.quality_threshold,
            stop_on_verification_pass: agent.stop_on_verification_pass,
            max_duration_secs: agent.max_duration_secs,
            max_total_tokens: agent.max_total_tokens,
            stall_patience: agent.stall_patience,
            continue_prompt: agent.continue_prompt.clone(),
        };
        config.temperature = self.config.llm.temperature;
        config.max_tokens = self.config.llm.max_tokens;
        config.max_tool_concurrency = agent.max_tool_concurrency;
        // 重试由 ots-llm 客户端负责：它知道哪些错误可重试、以及是否已经输出过增量。
        // 循环层若再重试一次，只会把同一批重试再叠加一遍，因此这里明确关闭。
        config.generation_retries = 0;
        config.tool_timeout = Duration::from_secs(agent.tool_timeout_secs);
        config.guard = Arc::clone(&composition.guard);
        config.skill_scope = !self.cli.no_skill_scope;
        config
    }

    /// 分发子命令。
    async fn dispatch(&self) -> Result<ExitCode> {
        match &self.cli.command {
            Command::Run(args) => self.command_run(args).await,
            Command::Exec(args) => self.command_exec(args).await,
            Command::Tools(command) => self.command_tools(command).await,
            Command::Skills(command) => self.command_skills(command),
            Command::Approvals(command) => self.command_approvals(command).await,
            Command::Sandbox(command) => self.command_sandbox(command).await,
            Command::Config(command) => self.command_config(command),
        }
    }

    /// `ots run`：完整循环。
    async fn command_run(&self, args: &RunArgs) -> Result<ExitCode> {
        let composition = self.compose()?;
        let agent = self.build_agent(&composition)?;
        let session = new_id();
        if !self.json() {
            println!("工作区: {}", self.workspace.display());
            println!("模型  : {}", self.model());
            println!("会话  : {session}");
        }
        let cancel = CancellationToken::new();
        let interrupted = install_interrupt_handler(cancel.clone());
        let outcome = agent.run(&session, &args.goal, cancel).await;
        interrupted.abort();
        self.print_outcome(&outcome)?;
        Ok(exit_code(&outcome))
    }

    /// `ots exec`：只跑一轮。
    async fn command_exec(&self, args: &ExecArgs) -> Result<ExitCode> {
        let composition = self.compose()?;
        let agent = self.build_agent(&composition)?;
        let session = new_id();
        let cancel = CancellationToken::new();
        let interrupted = install_interrupt_handler(cancel.clone());
        let result = agent.run_once(&session, &args.goal, cancel).await;
        interrupted.abort();
        match result {
            Ok(outcome) => {
                self.print_outcome(&outcome)?;
                Ok(exit_code(&outcome))
            }
            Err(err) => Err(anyhow!("执行失败: {err}")),
        }
    }

/// 函数级说明（开发者 Jan）：执行 build_agent 的单一职责，并返回可供调用方继续处理的结果。
    fn build_agent(&self, composition: &Composition) -> Result<AgentLoop> {
        Ok(AgentLoop::new(
            self.generator()?,
            self.verifier(composition),
            Arc::clone(&composition.policy),
            self.broker(composition),
            Arc::clone(&composition.runtime),
            self.event_sink()?,
            self.loop_config(composition),
        ))
    }

    /// 渲染循环结果。
    fn print_outcome(&self, outcome: &LoopOutcome) -> Result<()> {
        if self.json() {
            println!("{}", serde_json::to_string_pretty(outcome)?);
            return Ok(());
        }
        println!();
        println!("会话      : {}", outcome.session_id);
        println!("终止原因  : {}", outcome.reason.label());
        println!("迭代轮数  : {}", outcome.iterations);
        println!("耗时      : {:.1}s", outcome.duration_ms as f64 / 1000.0);
        println!(
            "token     : 输入 {} / 输出 {} / 合计 {}",
            outcome.usage.prompt_tokens, outcome.usage.completion_tokens, outcome.usage.total_tokens
        );
        if let Some(verification) = &outcome.verification {
            let verdict = if verification.skipped {
                "已跳过".to_string()
            } else if verification.passed {
                "通过".to_string()
            } else {
                format!("未通过（得分 {:.2}）", verification.score)
            };
            println!("验证      : {verdict} —— {}", verification.summary);
        }
        if !outcome.changed_files.is_empty() {
            println!("改动文件  : {} 个", outcome.changed_files.len());
            for path in &outcome.changed_files {
                println!("  [M] {path}");
            }
        }
        if let Some(error) = &outcome.error {
            println!("错误      : {error}");
        }
        if !outcome.final_message.trim().is_empty() {
            println!();
            println!("最终输出:");
            println!("{}", outcome.final_message.trim());
        }
        Ok(())
    }

    /// `ots tools`。
    async fn command_tools(&self, command: &ToolsCommand) -> Result<ExitCode> {
        let composition = self.compose()?;
        match command {
            ToolsCommand::List => {
                let specs = composition.runtime.registry().specs();
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&specs)?);
                    return Ok(ExitCode::SUCCESS);
                }
                println!("{:<14} {:<6} {:<6} 说明", "工具", "风险", "写权限");
                for spec in specs {
                    println!(
                        "{:<14} {:<6} {:<6} {}",
                        spec.name,
                        spec.risk.label(),
                        if spec.mutating { "是" } else { "否" },
                        sink::first_line(&spec.description)
                    );
                }
                Ok(ExitCode::SUCCESS)
            }
            ToolsCommand::Schema { name } => {
                let spec = composition
                    .runtime
                    .registry()
                    .get(name)
                    .map(|tool| tool.spec())
                    .ok_or_else(|| anyhow!("工具 `{name}` 未注册，可用工具: {}", composition.runtime.registry().names().join(", ")))?;
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&spec)?);
                } else {
                    println!("工具      : {}", spec.name);
                    println!("风险等级  : {}", spec.risk.label());
                    println!("修改工作区: {}", if spec.mutating { "是" } else { "否" });
                    if !spec.tags.is_empty() {
                        println!("标签      : {}", spec.tags.join("、"));
                    }
                    println!("\n说明:\n{}", spec.description.trim());
                    println!("\n参数 Schema:");
                    println!("{}", serde_json::to_string_pretty(&spec.parameters)?);
                }
                Ok(ExitCode::SUCCESS)
            }
            ToolsCommand::Run { name, args, dry_run } => {
                let arguments = parse_arguments(args)?;
                self.invoke_tool(&composition, name, arguments, *dry_run).await
            }
        }
    }

    /// 执行一次工具调用：策略 → 审批 → 执行。
    async fn invoke_tool(
        &self,
        composition: &Composition,
        name: &str,
        arguments: Value,
        dry_run: bool,
    ) -> Result<ExitCode> {
        if composition.runtime.registry().get(name).is_none() {
            bail!(
                "工具 `{name}` 未注册，可用工具: {}",
                composition.runtime.registry().names().join(", ")
            );
        }

        let query = PolicyQuery::new(name, &arguments, &self.workspace);
        let evaluation = composition.policy.evaluate(&query);
        if !self.json() {
            println!("策略裁决: {:?} —— {}", evaluation.decision, evaluation.reason);
        }

        match evaluation.decision {
            PolicyDecision::Deny => bail!("该调用被策略拒绝: {}", evaluation.reason),
            PolicyDecision::Ask => {
                let broker = self.broker(composition);
                let preview = composition.previews.build(name, &arguments, &self.workspace).await;
                let request = ApprovalRequest::new(
                    "cli",
                    name,
                    arguments.clone(),
                    evaluation.risk,
                    evaluation.reason.clone(),
                    evaluation.matched_rule.clone(),
                    preview,
                );
                if !self.json() {
                    println!("{}", request.render());
                }
                match broker.request(&request).await {
                    Ok(decision) if decision.is_approved() => {
                        if !self.json() {
                            println!("已批准（来源 {}）", broker.name());
                        }
                    }
                    Ok(_) => bail!("审批未通过，已取消执行"),
                    Err(err) => bail!("审批失败: {err}"),
                }
            }
            PolicyDecision::Allow => {}
        }

        let context = ToolContext {
            workspace: self.workspace.clone(),
            cancel: CancellationToken::new(),
            timeout: composition.runtime.limits().timeout,
            dry_run,
            guard: Arc::clone(&composition.guard),
        };
        let result = composition
            .runtime
            .execute(ToolInvocation::new(new_id(), name, arguments), &context)
            .await;

        if self.json() {
            println!("{}", serde_json::to_string_pretty(&result)?);
        } else {
            if !result.stdout.is_empty() {
                println!("{}", result.stdout.trim_end());
            }
            if !result.stderr.is_empty() {
                eprintln!("{}", result.stderr.trim_end());
            }
            println!(
                "结果: {}（{} ms{}）",
                if result.ok { "成功" } else { "失败" },
                result.duration_ms,
                if dry_run { "，预演模式未落盘" } else { "" }
            );
        }
        Ok(if result.ok { ExitCode::SUCCESS } else { ExitCode::FAILURE })
    }

    /// `ots skills`。
    fn command_skills(&self, command: &SkillsCommand) -> Result<ExitCode> {
        let skills = self.load_skills();
        match command {
            SkillsCommand::List => {
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&skills.specs())?);
                    return Ok(ExitCode::SUCCESS);
                }
                if skills.is_empty() {
                    let user_dir = ots_config::user_config_dir()
                        .map(|dir| dir.join(ots_tools::SKILLS_DIR_NAME).display().to_string())
                        .unwrap_or_else(|| "（无法定位用户配置目录）".to_string());
                    let project_dir = self.workspace.join(".octopuses").join(ots_tools::SKILLS_DIR_NAME);
                    println!("没有已装载的技能（用户级 {user_dir}，项目级 {}）", project_dir.display());
                    return Ok(ExitCode::SUCCESS);
                }
                println!("{:<16} {:<10} {:<24} 说明", "技能", "来源", "工具范围");
                for spec in skills.specs() {
                    let scope = match &spec.allowed_tools {
                        None => "不约束".to_string(),
                        Some(tools) if tools.is_empty() => "无".to_string(),
                        Some(tools) => tools.iter().cloned().collect::<Vec<_>>().join("、"),
                    };
                    println!(
                        "{:<16} {:<10} {:<24} {}",
                        spec.name,
                        spec.source.label(),
                        scope,
                        sink::first_line(&spec.description)
                    );
                }
                Ok(ExitCode::SUCCESS)
            }
            SkillsCommand::Show { name } => {
                let spec = skills.get(name).ok_or_else(|| {
                    anyhow!("技能 `{name}` 不存在，可用技能: {}", skills.names().join("、"))
                })?;
                let (body, truncated) =
                    read_skill_body(spec, self.config.skills.max_body_bytes).map_err(|err| anyhow!(err))?;
                if self.json() {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "name": spec.name,
                            "description": spec.description,
                            "allowed_tools": spec.allowed_tools_sorted(),
                            "source": spec.source.label(),
                            "path": spec.path.display().to_string(),
                            "body": body,
                            "truncated": truncated,
                        }))?
                    );
                    return Ok(ExitCode::SUCCESS);
                }
                println!("技能      : {}", spec.name);
                if !spec.description.is_empty() {
                    println!("说明      : {}", spec.description);
                }
                println!("来源      : {}", spec.source.label());
                println!("定义文件  : {}", spec.path.display());
                match &spec.allowed_tools {
                    None => println!("工具范围  : 不约束"),
                    Some(tools) if tools.is_empty() => println!("工具范围  : 无（仅保留 use_skill 以便载入其它技能）"),
                    Some(tools) => println!("工具范围  : {}", tools.iter().cloned().collect::<Vec<_>>().join("、")),
                }
                println!("\n{}", body);
                if truncated {
                    println!("\n（正文超过 {} 字节，已截断）", self.config.skills.max_body_bytes);
                }
                Ok(ExitCode::SUCCESS)
            }
        }
    }

    /// `ots approvals`。
    async fn command_approvals(&self, command: &ApprovalsCommand) -> Result<ExitCode> {
        let store = ApprovalStore::from_config(&self.config.approval, &self.workspace);
        match command {
            ApprovalsCommand::List { pending } => {
                let entries = if *pending { store.pending().await } else { store.list().await }
                    .map_err(|err| anyhow!("读取审批记录失败: {err}"))?;
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&entries)?);
                    return Ok(ExitCode::SUCCESS);
                }
                if entries.is_empty() {
                    println!("没有审批记录（存储位置: {}）", store.path().display());
                    return Ok(ExitCode::SUCCESS);
                }
                println!("{:<10} {:<10} {:<14} {:<6} 摘要", "ID", "状态", "工具", "风险");
                for entry in entries {
                    let request = &entry.request;
                    println!(
                        "{:<10} {:<10} {:<14} {:<6} {}",
                        request.id,
                        sink::approval_status_label(request.status),
                        request.tool,
                        request.risk.label(),
                        request.preview.summary
                    );
                }
                Ok(ExitCode::SUCCESS)
            }
            ApprovalsCommand::Show { id } => {
                let entry = store
                    .get(id)
                    .await
                    .map_err(|err| anyhow!("读取审批记录失败: {err}"))?
                    .ok_or_else(|| anyhow!("未找到审批请求 `{id}`（存储位置: {}）", store.path().display()))?;
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&entry)?);
                } else {
                    print!("{}", entry.request.render());
                    println!("  状态     : {}", sink::approval_status_label(entry.request.status));
                    if let Some(decision) = entry.decision {
                        println!("  决策     : {decision:?}");
                    }
                    if let Some(note) = &entry.request.note {
                        println!("  备注     : {note}");
                    }
                }
                Ok(ExitCode::SUCCESS)
            }
            ApprovalsCommand::Approve { id, note } => {
                self.decide(&store, id, ApprovalDecision::Approve, note.as_deref()).await
            }
            ApprovalsCommand::Deny { id, note } => {
                self.decide(&store, id, ApprovalDecision::Deny, note.as_deref()).await
            }
        }
    }

/// 函数级说明（开发者 Jan）：执行 decide 的单一职责，并返回可供调用方继续处理的结果。
    async fn decide(
        &self,
        store: &ApprovalStore,
        id: &str,
        decision: ApprovalDecision,
        note: Option<&str>,
    ) -> Result<ExitCode> {
        let entry = store
            .get(id)
            .await
            .map_err(|err| anyhow!("读取审批记录失败: {err}"))?
            .ok_or_else(|| anyhow!("未找到审批请求 `{id}`"))?;
        if entry.request.status.is_final() {
            bail!(
                "审批请求 `{id}` 已经结束（{}），无需再次处理",
                sink::approval_status_label(entry.request.status)
            );
        }
        store
            .decide(id, decision, "cli", note)
            .await
            .map_err(|err| anyhow!("写入审批决策失败: {err}"))?;
        println!("已{}审批请求 {id}", if decision.is_approved() { "批准" } else { "拒绝" });
        Ok(ExitCode::SUCCESS)
    }

    /// `ots sandbox`。
    async fn command_sandbox(&self, command: &SandboxCommand) -> Result<ExitCode> {
        let composition = self.compose()?;
        match command {
            SandboxCommand::Preview { tool, args } => {
                let arguments = parse_arguments(args)?;
                let preview = composition.previews.build(tool, &arguments, &self.workspace).await;
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&preview)?);
                    return Ok(ExitCode::SUCCESS);
                }
                println!("预览: {}", preview.summary);
                for command in &preview.commands {
                    println!("  待执行命令: {command}");
                }
                for change in &preview.file_changes {
                    println!(
                        "  [{}] {}（+{} / -{}）",
                        change.kind.marker(),
                        change.path,
                        change.additions,
                        change.deletions
                    );
                    if let Some(diff) = &change.diff {
                        println!("{diff}");
                    }
                }
                for path in &preview.out_of_scope {
                    println!("  越界路径: {path}");
                }
                for note in &preview.notes {
                    println!("  提示: {note}");
                }
                Ok(ExitCode::SUCCESS)
            }
            SandboxCommand::Profile => {
                let profile = seatbelt_profile(&self.workspace, &self.config.sandbox);
                println!("# 沙箱: {}", composition.guard.describe());
                println!("# 后端: {:?}", self.config.sandbox.backend);
                println!("{profile}");
                Ok(ExitCode::SUCCESS)
            }
            SandboxCommand::Check { command, path, access } => {
                let mut denied = false;
                if let Some(command) = command {
                    match composition.guard.check_command(command) {
                        Ok(()) => println!("命令允许执行: {command}"),
                        Err(err) => {
                            denied = true;
                            println!("命令被拦截: {err}");
                        }
                    }
                }
                if let Some(path) = path {
                    let access = access.to_access();
                    let candidate = if path.is_absolute() { path.clone() } else { self.workspace.join(path) };
                    match composition.guard.resolve_path(&candidate, access) {
                        Ok(resolved) => println!("路径允许访问: {}（解析为 {}）", path.display(), resolved.display()),
                        Err(err) => {
                            denied = true;
                            println!("路径被拦截: {err}");
                        }
                    }
                }
                Ok(if denied { ExitCode::FAILURE } else { ExitCode::SUCCESS })
            }
        }
    }

    /// `ots config`。
    fn command_config(&self, command: &ConfigCommand) -> Result<ExitCode> {
        match command {
            ConfigCommand::Init { user, force } => {
                let path = if *user {
                    user_config_path().ok_or_else(|| anyhow!("无法定位用户配置目录"))?
                } else {
                    project_config_path(&self.workspace)
                };
                if path.exists() && !*force {
                    bail!("配置文件已存在: {}（如需覆盖请加 --force）", path.display());
                }
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("创建目录 {} 失败", parent.display()))?;
                }
                let text = to_toml(&self.config).context("序列化配置失败")?;
                std::fs::write(&path, text)
                    .with_context(|| format!("写入 {} 失败", path.display()))?;
                println!("已写入 {}", path.display());
                Ok(ExitCode::SUCCESS)
            }
            ConfigCommand::Show => {
                if self.json() {
                    println!("{}", serde_json::to_string_pretty(&self.loaded.to_json()?)?);
                } else {
                    print!("{}", self.render_sources());
                    println!("{}", to_toml(&self.config).context("序列化配置失败")?);
                }
                Ok(ExitCode::SUCCESS)
            }
            ConfigCommand::Validate => {
                let report = validate(&self.config, BUILTIN_TOOL_NAMES);
                if self.json() {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": report.is_ok(),
                            "errors": report.errors,
                            "warnings": report.warnings,
                        }))?
                    );
                } else if report.is_ok() && report.warnings.is_empty() {
                    println!("配置校验通过");
                } else {
                    for error in &report.errors {
                        println!("错误: {error}");
                    }
                    for warning in &report.warnings {
                        println!("提醒: {warning}");
                    }
                    if report.is_ok() {
                        println!("配置校验通过（有 {} 条提醒）", report.warnings.len());
                    }
                }
                Ok(if report.is_ok() { ExitCode::SUCCESS } else { ExitCode::FAILURE })
            }
            ConfigCommand::Path => {
                if self.json() {
                    let sources = self
                        .loaded
                        .sources
                        .iter()
                        .map(|source| {
                            serde_json::json!({
                                "kind": source.kind.label(),
                                "path": source.path.as_ref().map(|path| path.display().to_string()),
                                "present": source.present,
                                "note": source.note,
                            })
                        })
                        .collect::<Vec<_>>();
                    println!("{}", serde_json::to_string_pretty(&sources)?);
                } else {
                    print!("{}", self.render_sources());
                }
                Ok(ExitCode::SUCCESS)
            }
        }
    }

    /// 渲染配置来源表。
    fn render_sources(&self) -> String {
        let mut out = String::from("配置来源（低 → 高优先级）:\n");
        for source in &self.loaded.sources {
            let path = match &source.path {
                Some(path) => path.display().to_string(),
                None => "-".to_string(),
            };
            let mark = if source.path.is_some() && !source.present { "（不存在）" } else { "" };
            let note = source.note.as_deref().map(|note| format!(" [{note}]")).unwrap_or_default();
            out.push_str(&format!("  {:<10} {}{}{}\n", source.kind.label(), path, mark, note));
        }
        if !self.loaded.env_applied.is_empty() {
            out.push_str("环境变量覆盖:\n");
            for (key, value) in &self.loaded.env_applied {
                out.push_str(&format!("  {key}={value}\n"));
            }
        }
        out.push('\n');
        out
    }
}
