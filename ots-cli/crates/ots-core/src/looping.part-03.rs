/// 记录一次生成尝试中是否已经输出过正文增量。
///
/// 循环据此决定能否整体重试：一旦用户已经看到正文，重试就会把同一段内容重复打印。
/// 推理增量不计入——它只影响调试观感，不进入最终消息。
struct DeltaTracker<'a> {
    inner: &'a dyn StreamSink,
    emitted: std::sync::atomic::AtomicBool,
}

impl<'a> DeltaTracker<'a> {
/// 函数级说明（开发者 Jan）：执行 new 的单一职责，并返回可供调用方继续处理的结果。
    fn new(inner: &'a dyn StreamSink) -> Self {
        Self { inner, emitted: std::sync::atomic::AtomicBool::new(false) }
    }

/// 函数级说明（开发者 Jan）：执行 emitted 的单一职责，并返回可供调用方继续处理的结果。
    fn emitted(&self) -> bool {
        self.emitted.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl StreamSink for DeltaTracker<'_> {
/// 函数级说明（开发者 Jan）：执行 on_delta 的单一职责，并返回可供调用方继续处理的结果。
    fn on_delta(&self, delta: &str) {
        if !delta.is_empty() {
            self.emitted.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.inner.on_delta(delta);
    }

/// 函数级说明（开发者 Jan）：执行 on_reasoning 的单一职责，并返回可供调用方继续处理的结果。
    fn on_reasoning(&self, delta: &str) {
        self.inner.on_reasoning(delta);
    }
}

enum PlannedCall {
    Ready,
    Denied(String),
}

#[derive(Default)]
struct ToolBatch {
    results: Vec<(ToolCall, ToolResult)>,
    abort: bool,
    abort_reason: Option<String>,
}

struct RunState {
    messages: Vec<Message>,
    iteration: u32,
    reason: TerminationReason,
    verification: Option<Verification>,
    final_message: String,
    usage: TokenUsage,
    changed_files: Vec<String>,
    error: Option<String>,
    abort_reason: Option<String>,
    /// 技能收窄后的可用工具范围；`None` 表示不约束。
    tool_scope: Option<BTreeSet<String>>,
    last_score: f64,
    last_changed_files: usize,
    stall: u32,
    duration_ms: u64,
}

impl RunState {
/// 函数级说明（开发者 Jan）：执行 new 的单一职责，并返回可供调用方继续处理的结果。
    fn new(goal: &str) -> Self {
        Self {
            messages: vec![Message::user(goal)],
            iteration: 0,
            reason: TerminationReason::MaxIterations,
            verification: None,
            final_message: String::new(),
            usage: TokenUsage::default(),
            changed_files: Vec::new(),
            error: None,
            abort_reason: None,
            tool_scope: None,
            last_score: 0.0,
            last_changed_files: 0,
            stall: 0,
            duration_ms: 0,
        }
    }

/// 函数级说明（开发者 Jan）：执行 record_change 的单一职责，并返回可供调用方继续处理的结果。
    fn record_change(&mut self, change: FileChange) {
        if !self.changed_files.contains(&change.path) {
            self.changed_files.push(change.path);
        }
    }

/// 函数级说明（开发者 Jan）：执行 finish 的单一职责，并返回可供调用方继续处理的结果。
    fn finish(&mut self, reason: TerminationReason) {
        self.reason = reason;
    }

/// 函数级说明（开发者 Jan）：执行 finish_duration 的单一职责，并返回可供调用方继续处理的结果。
    fn finish_duration(&mut self, started: Instant) {
        self.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    }
}

/// 函数级说明（开发者 Jan）：执行 render_continue_prompt 的单一职责，并返回可供调用方继续处理的结果。
fn render_continue_prompt(template: &str, iteration: u32, verification: &Verification) -> String {
    let details = if verification.details.is_empty() {
        String::new()
    } else {
        verification.details.iter().map(|d| format!("- {d}")).collect::<Vec<_>>().join("\n")
    };
    template
        .replace("{iteration}", &iteration.to_string())
        .replace("{score}", &format!("{:.2}", verification.score))
        .replace("{summary}", &verification.summary)
        .replace("{details}", &details)
}

/// 把模型流式增量转成循环事件的适配器。
struct EventStreamSink {
    sink: Arc<dyn EventSink>,
    session_id: String,
    iteration: u32,
}

impl StreamSink for EventStreamSink {
/// 函数级说明（开发者 Jan）：执行 on_delta 的单一职责，并返回可供调用方继续处理的结果。
    fn on_delta(&self, delta: &str) {
        self.sink.emit(&EventRecord {
            timestamp: Utc::now(),
            session_id: self.session_id.clone(),
            iteration: self.iteration,
            event: LoopEvent::GenerationDelta { text: delta.to_string() },
        });
    }

/// 函数级说明（开发者 Jan）：执行 on_reasoning 的单一职责，并返回可供调用方继续处理的结果。
    fn on_reasoning(&self, delta: &str) {
        self.sink.emit(&EventRecord {
            timestamp: Utc::now(),
            session_id: self.session_id.clone(),
            iteration: self.iteration,
            event: LoopEvent::ReasoningDelta { text: delta.to_string() },
        });
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::approval::FixedBroker;
    use crate::event::RecordingSink;
    use crate::guard::PermissiveGuard;
    use crate::policy::{PermissionMode, PolicyEvaluation, RiskLevel};
    use crate::tool::{Tool, ToolError, ToolLimits, ToolRegistry};
    use crate::verifier::VerificationContext;

    /// 生成器脚本中的一步。
    enum Step {
        /// 先输出增量再失败（模拟「流已开始但中途断开」）。
        EmitThenFail(&'static str, CoreError),
        /// 直接失败，未输出任何增量。
        Fail(CoreError),
        /// 成功返回。
        Ok(Generation),
    }

    /// 按脚本依次返回结果的生成器。
    struct ScriptedGenerator {
        steps: Mutex<VecDeque<Step>>,
        calls: std::sync::atomic::AtomicU32,
        /// 每次调用模型时实际暴露的工具名，用于断言技能收窄效果。
        seen_tools: Mutex<Vec<Vec<String>>>,
    }

    impl ScriptedGenerator {
        fn new(steps: Vec<Step>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
                calls: std::sync::atomic::AtomicU32::new(0),
                seen_tools: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> u32 {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn seen_tools(&self) -> Vec<Vec<String>> {
            self.seen_tools.lock().expect("工具记录锁未中毒").clone()
        }
    }

    #[async_trait]
    impl Generator for ScriptedGenerator {
        fn name(&self) -> &str {
            "scripted"
        }

        fn model(&self) -> &str {
            "scripted"
        }

        async fn generate(&self, request: GenerationRequest, sink: &dyn StreamSink) -> CoreResult<Generation> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.seen_tools
                .lock()
                .expect("工具记录锁未中毒")
                .push(request.tools.iter().map(|spec| spec.name.clone()).collect());
            match self.steps.lock().expect("脚本锁未中毒").pop_front().expect("脚本步骤已用尽") {
                Step::EmitThenFail(text, err) => {
                    sink.on_delta(text);
                    Err(err)
                }
                Step::Fail(err) => Err(err),
                Step::Ok(generation) => Ok(generation),
            }
        }
    }

    /// 固定返回同一结论的验证器。
    struct FixedVerifier(Verification);

    #[async_trait]
    impl Verifier for FixedVerifier {
        fn name(&self) -> &str {
            "fixed"
        }

        async fn verify(&self, _ctx: &VerificationContext) -> CoreResult<Verification> {
            Ok(self.0.clone())
        }
    }

    /// 全部放行的策略引擎。
    struct AllowAllPolicy;

    impl PolicyEngine for AllowAllPolicy {
        fn mode(&self) -> PermissionMode {
            PermissionMode::FullAccess
        }

        fn evaluate(&self, query: &PolicyQuery<'_>) -> PolicyEvaluation {
            PolicyEvaluation::new(PolicyDecision::Allow, RiskLevel::Low, format!("测试放行 {}", query.tool))
        }
    }

    /// 组装一个只依赖内存实现的循环。
    fn build(
        generator: Arc<ScriptedGenerator>,
        verification: Verification,
        generation_retries: u32,
        sink: Arc<RecordingSink>,
    ) -> AgentLoop {
        let runtime = Arc::new(ToolRuntime::new(ToolRegistry::new(), ToolLimits::default()));
        let mut config = LoopConfig::new("/ws", "scripted", "系统提示");
        config.policy.max_iterations = 3;
        config.generation_retries = generation_retries;
        config.guard = Arc::new(PermissiveGuard);
        AgentLoop::new(
            generator,
            Arc::new(FixedVerifier(verification)),
            Arc::new(AllowAllPolicy),
            Arc::new(FixedBroker::approve_all()),
            runtime,
            sink,
            config,
        )
    }

    /// 模拟 `use_skill`：正文不重要，关键是 `data` 里带出技能名与允许工具。
    struct FakeSkillTool {
        allowed: Option<Vec<&'static str>>,
    }

    #[async_trait]
    impl Tool for FakeSkillTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(USE_SKILL_TOOL_NAME, "载入技能", serde_json::json!({"type": "object"}), RiskLevel::Low, false)
        }

        async fn invoke(&self, invocation: ToolInvocation, _ctx: &ToolContext) -> Result<ToolResult, ToolError> {
            let name = invocation.arguments.get("name").and_then(Value::as_str).unwrap_or("unnamed").to_string();
            Ok(ToolResult::success(format!("{name} 的技能正文"))
                .with_data(serde_json::json!({ "skill": name, "allowed_tools": self.allowed })))
        }
    }

    /// 返回固定结果的普通工具，用于充当技能允许/不允许的工具。
    struct StubTool(&'static str);

    #[async_trait]
    impl Tool for StubTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(self.0, "测试工具", serde_json::json!({"type": "object"}), RiskLevel::Low, false)
        }

        async fn invoke(&self, _invocation: ToolInvocation, _ctx: &ToolContext) -> Result<ToolResult, ToolError> {
            Ok(ToolResult::success(format!("{} 已执行", self.0)))
        }
    }

    fn skill_registry() -> ToolRegistry {
        let mut registry = ToolRegistry::new();
        registry.register(FakeSkillTool { allowed: Some(vec!["read_file"]) }).expect("注册成功");
        registry.register(StubTool("read_file")).expect("注册成功");
        registry.register(StubTool("shell")).expect("注册成功");
        registry
    }

    /// 带自定义工具表与技能收窄开关的循环。
    fn build_with_tools(
        generator: Arc<ScriptedGenerator>,
        registry: ToolRegistry,
        skill_scope: bool,
        sink: Arc<RecordingSink>,
    ) -> AgentLoop {
        let runtime = Arc::new(ToolRuntime::new(registry, ToolLimits::default()));
        let mut config = LoopConfig::new("/ws", "scripted", "系统提示");
        config.policy.max_iterations = 3;
        config.generation_retries = 0;
        config.guard = Arc::new(PermissiveGuard);
        config.skill_scope = skill_scope;
        AgentLoop::new(
            generator,
            Arc::new(FixedVerifier(Verification::skipped("测试跳过验证"))),
            Arc::new(AllowAllPolicy),
            Arc::new(FixedBroker::approve_all()),
            runtime,
            sink,
            config,
        )
    }

    /// 三轮脚本：载入技能 → 越界调用 shell → 收尾。
    fn skill_script() -> Vec<Step> {
        vec![
            Step::Ok(Generation::with_tool_calls(
                "载入技能",
                vec![ToolCall::new("c1", USE_SKILL_TOOL_NAME, serde_json::json!({"name": "fix-bug"}))],
            )),
            Step::Ok(Generation::with_tool_calls(
                "换个工具",
                vec![
                    ToolCall::new("c2", "read_file", serde_json::json!({})),
                    ToolCall::new("c3", "shell", serde_json::json!({})),
                ],
            )),
            Step::Ok(Generation::text("完成")),
        ]
    }

    #[tokio::test]
    async fn 技能声明的工具范围在下一轮收窄() {
        let generator = Arc::new(ScriptedGenerator::new(skill_script()));
        let sink = Arc::new(RecordingSink::new());
        let agent = build_with_tools(Arc::clone(&generator), skill_registry(), true, Arc::clone(&sink));

        let outcome = agent.run("s1", "目标", CancellationToken::new()).await;

        assert_eq!(outcome.reason, TerminationReason::Completed);
        let seen = generator.seen_tools();
        assert_eq!(seen[0], vec!["read_file", "shell", USE_SKILL_TOOL_NAME]);
        assert_eq!(seen[1], vec!["read_file", USE_SKILL_TOOL_NAME], "第二轮起只暴露技能允许的工具");
        assert_eq!(seen[2], vec!["read_file", USE_SKILL_TOOL_NAME]);

        let records = sink.records();
        assert!(records.iter().any(|r| matches!(&r.event, LoopEvent::SkillLoaded { name, scope_applied, .. } if name == "fix-bug" && *scope_applied)));
        assert!(
            records.iter().any(|r| matches!(&r.event, LoopEvent::ToolFinished { tool, ok, .. } if tool == "shell" && !ok)),
            "越界调用应被拒绝执行"
        );
        assert!(records.iter().any(|r| matches!(&r.event, LoopEvent::ToolFinished { tool, ok, .. } if tool == "read_file" && *ok)));
    }

    #[tokio::test]
    async fn 关闭技能收窄后越界调用照常执行() {
        let generator = Arc::new(ScriptedGenerator::new(skill_script()));
        let sink = Arc::new(RecordingSink::new());
        let agent = build_with_tools(Arc::clone(&generator), skill_registry(), false, Arc::clone(&sink));

        let outcome = agent.run("s1", "目标", CancellationToken::new()).await;

        assert_eq!(outcome.reason, TerminationReason::Completed);
        let seen = generator.seen_tools();
        assert_eq!(seen[1], vec!["read_file", "shell", USE_SKILL_TOOL_NAME], "关闭收窄后不裁剪工具表");

        let records = sink.records();
        assert!(records.iter().any(|r| matches!(&r.event, LoopEvent::ToolFinished { tool, ok, .. } if tool == "shell" && *ok)));
        assert!(
            records.iter().any(|r| matches!(&r.event, LoopEvent::SkillLoaded { scope_applied, .. } if !*scope_applied)),
            "关闭收窄时应如实报告未收窄"
        );
    }

    #[tokio::test]
    async fn 临时故障会被重试并最终成功() {
        let generator = Arc::new(ScriptedGenerator::new(vec![
            Step::Fail(CoreError::Generation("连接被重置".to_string())),
            Step::Ok(Generation::text("完成")),
        ]));
        let sink = Arc::new(RecordingSink::new());
        let agent = build(Arc::clone(&generator), Verification::skipped("测试跳过验证"), 1, sink);

        let outcome = agent.run("s1", "目标", CancellationToken::new()).await;

        assert_eq!(generator.calls(), 2, "临时故障应重试一次");
        assert_eq!(outcome.reason, TerminationReason::Completed);
        assert_eq!(outcome.final_message, "完成");
    }

    #[tokio::test]
    async fn 不可重试的失败不重试() {
        let generator = Arc::new(ScriptedGenerator::new(vec![
            Step::Fail(CoreError::GenerationRefused("鉴权失败".to_string())),
            Step::Ok(Generation::text("不该被用到")),
        ]));
        let sink = Arc::new(RecordingSink::new());
        let agent = build(Arc::clone(&generator), Verification::skipped("测试跳过验证"), 3, sink);

        let outcome = agent.run("s1", "目标", CancellationToken::new()).await;

        assert_eq!(generator.calls(), 1, "确定性失败不应重试");
        assert_eq!(outcome.reason, TerminationReason::FatalError);
        assert!(outcome.error.unwrap_or_default().contains("鉴权失败"));
    }

    #[tokio::test]
    async fn 已输出增量后不再重试() {
        let generator = Arc::new(ScriptedGenerator::new(vec![
            Step::EmitThenFail("已经打印了一半", CoreError::Generation("连接中断".to_string())),
            Step::Ok(Generation::text("重复内容")),
        ]));
        let sink = Arc::new(RecordingSink::new());
        let agent = build(Arc::clone(&generator), Verification::skipped("测试跳过验证"), 3, Arc::clone(&sink));

        let outcome = agent.run("s1", "目标", CancellationToken::new()).await;

        assert_eq!(generator.calls(), 1, "已输出增量后重试会重复内容，必须放弃");
        assert_eq!(outcome.reason, TerminationReason::FatalError);
        let deltas = sink
            .records()
            .iter()
            .filter(|record| matches!(record.event, LoopEvent::GenerationDelta { .. }))
            .count();
        assert_eq!(deltas, 1, "增量只应出现一次");
    }

    #[tokio::test]
    async fn 验证通过即终止循环() {
        let generator = Arc::new(ScriptedGenerator::new(vec![
            Step::Ok(Generation::text("第一轮")),
            Step::Ok(Generation::text("不该被用到")),
        ]));
        let sink = Arc::new(RecordingSink::new());
        let agent = build(Arc::clone(&generator), Verification::passed(1.0, "测试通过"), 0, sink);

        let outcome = agent.run("s1", "目标", CancellationToken::new()).await;

        assert_eq!(outcome.reason, TerminationReason::VerificationPassed);
        assert_eq!(outcome.iterations, 1);
        assert!(outcome.is_success());
    }
}

