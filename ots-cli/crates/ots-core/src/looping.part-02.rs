impl AgentLoop {
    /// 组装一个循环实例。
    pub fn new(
        generator: Arc<dyn Generator>,
        verifier: Arc<dyn Verifier>,
        policy: Arc<dyn PolicyEngine>,
        broker: Arc<dyn ApprovalBroker>,
        runtime: Arc<ToolRuntime>,
        sink: Arc<dyn EventSink>,
        config: LoopConfig,
    ) -> Self {
        Self { generator, verifier, policy, broker, runtime, sink, config }
    }

    /// 循环配置。
    pub fn config(&self) -> &LoopConfig {
        &self.config
    }

    /// 执行一次完整循环。
    pub async fn run(&self, session_id: &str, goal: &str, cancel: CancellationToken) -> LoopOutcome {
        let started = Instant::now();
        let mut state = RunState::new(goal);

        self.emit(session_id, 0, LoopEvent::LoopStarted { goal: goal.to_string(), max_iterations: self.config.policy.max_iterations });

        for iteration in 1..=self.config.policy.max_iterations {
            if cancel.is_cancelled() {
                state.finish(TerminationReason::UserInterrupted);
                break;
            }
            if let Some(budget) = self.config.policy.max_duration_secs {
                if started.elapsed().as_secs() >= budget {
                    state.finish(TerminationReason::TimeBudgetExhausted);
                    break;
                }
            }
            if let Some(budget) = self.config.policy.max_total_tokens {
                if state.usage.total_tokens >= budget {
                    state.finish(TerminationReason::TokenBudgetExhausted);
                    break;
                }
            }

            state.iteration = iteration;
            self.emit(session_id, iteration, LoopEvent::IterationStarted { iteration });

            let stream = EventStreamSink { sink: Arc::clone(&self.sink), session_id: session_id.to_string(), iteration };
            let scope = self.active_scope(&state);
            let generation = match self.generate(&state.messages, &stream, &cancel, scope.as_ref()).await {
                Ok(generation) => generation,
                Err(err) => {
                    let cancelled = err.is_cancelled();
                    state.error = Some(err.to_string());
                    self.emit(session_id, iteration, LoopEvent::ErrorOccurred { message: err.to_string() });
                    state.finish(if cancelled { TerminationReason::UserInterrupted } else { TerminationReason::FatalError });
                    break;
                }
            };
            state.usage.accumulate(&generation.usage);
            state.final_message = generation.content.clone();
            self.emit(
                session_id,
                iteration,
                LoopEvent::GenerationFinished {
                    content_chars: generation.content.chars().count(),
                    tool_call_count: generation.tool_calls.len(),
                    usage: generation.usage,
                    finish_reason: generation.finish_reason.clone(),
                },
            );

            let assistant_content = if generation.content.trim().is_empty() { None } else { Some(generation.content.clone()) };
            state.messages.push(Message::assistant_tool_calls(assistant_content, generation.tool_calls.clone()));

            if generation.tool_calls.is_empty() {
                let verification = self.verify(iteration, &state, &generation, &cancel).await;
                self.emit(
                    session_id,
                    iteration,
                    LoopEvent::VerificationFinished {
                        iteration,
                        passed: verification.passed,
                        score: verification.score,
                        skipped: verification.skipped,
                        summary: verification.summary.clone(),
                    },
                );

                if verification.skipped {
                    state.verification = Some(verification);
                    state.finish(TerminationReason::Completed);
                    break;
                }
                if verification.passed && self.config.policy.stop_on_verification_pass {
                    state.verification = Some(verification);
                    state.finish(TerminationReason::VerificationPassed);
                    break;
                }
                if verification.score >= self.config.policy.quality_threshold {
                    state.verification = Some(verification);
                    state.finish(TerminationReason::QualityThresholdMet);
                    break;
                }

                let progressed = verification.score > state.last_score || state.changed_files.len() > state.last_changed_files;
                state.last_score = state.last_score.max(verification.score);
                state.last_changed_files = state.changed_files.len();
                state.stall = if progressed { 0 } else { state.stall + 1 };

                if self.config.policy.stall_patience > 0 && state.stall >= self.config.policy.stall_patience {
                    state.verification = Some(verification);
                    state.finish(TerminationReason::NoProgress);
                    break;
                }

                state.messages.push(Message::user(render_continue_prompt(
                    &self.config.policy.continue_prompt,
                    iteration,
                    &verification,
                )));
                state.verification = Some(verification);
                continue;
            }

            let batch =
                self.execute_tool_calls(session_id, iteration, &generation.tool_calls, &cancel, scope.as_ref()).await;
            for (call, result) in &batch.results {
                if let Some(changes) = FileChange::list_from_tool_result(result) {
                    for change in changes {
                        state.record_change(change);
                    }
                }
                state.messages.push(Message::tool_result(call.id.clone(), result.to_model_text()));
            }
            self.absorb_skill_effects(session_id, iteration, &mut state, &batch.results);

            if batch.abort {
                state.abort_reason = batch.abort_reason;
                state.finish(TerminationReason::UserInterrupted);
                break;
            }
        }

        state.finish_duration(started);
        self.emit(
            session_id,
            state.iteration,
            LoopEvent::LoopFinished { reason: state.reason, iterations: state.iteration, usage: state.usage },
        );

        LoopOutcome {
            session_id: session_id.to_string(),
            iterations: state.iteration,
            reason: state.reason,
            verification: state.verification,
            final_message: state.final_message,
            usage: state.usage,
            changed_files: state.changed_files.clone(),
            error: state.error.or(state.abort_reason),
            duration_ms: state.duration_ms,
        }
    }

    /// 执行单轮生成 + 工具执行（不进入验证循环），用于 `ots exec`。
    ///
    /// # Errors
    /// 模型调用失败或用户中断时返回错误。
    pub async fn run_once(&self, session_id: &str, goal: &str, cancel: CancellationToken) -> CoreResult<LoopOutcome> {
        let started = Instant::now();
        let mut messages = vec![Message::system(self.config.system_prompt.clone()), Message::user(goal)];
        self.emit(session_id, 1, LoopEvent::IterationStarted { iteration: 1 });
        let stream = EventStreamSink { sink: Arc::clone(&self.sink), session_id: session_id.to_string(), iteration: 1 };
        let generation = self.generate(&messages, &stream, &cancel, None).await?;
        self.emit(
            session_id,
            1,
            LoopEvent::GenerationFinished {
                content_chars: generation.content.chars().count(),
                tool_call_count: generation.tool_calls.len(),
                usage: generation.usage,
                finish_reason: generation.finish_reason.clone(),
            },
        );
        let assistant_content = if generation.content.trim().is_empty() { None } else { Some(generation.content.clone()) };
        messages.push(Message::assistant_tool_calls(assistant_content, generation.tool_calls.clone()));

        let mut changed_files: Vec<String> = Vec::new();
        let batch = self.execute_tool_calls(session_id, 1, &generation.tool_calls, &cancel, None).await;
        for (call, result) in &batch.results {
            if let Some(changes) = FileChange::list_from_tool_result(result) {
                for change in changes {
                    if !changed_files.contains(&change.path) {
                        changed_files.push(change.path.clone());
                    }
                }
            }
            messages.push(Message::tool_result(call.id.clone(), result.to_model_text()));
        }

        let reason = if batch.abort { TerminationReason::UserInterrupted } else { TerminationReason::Completed };
        let outcome = LoopOutcome {
            session_id: session_id.to_string(),
            iterations: 1,
            reason,
            verification: None,
            final_message: generation.content.clone(),
            usage: generation.usage,
            changed_files,
            error: None,
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        };
        self.emit(session_id, 1, LoopEvent::LoopFinished { reason, iterations: 1, usage: generation.usage });
        Ok(outcome)
    }

    /// 当前会话生效的工具范围；未开启收窄或尚未加载技能时为 `None`（不约束）。
    ///
    /// 返回克隆值而非引用，避免调用方在后续可变借用 `RunState` 时产生借用冲突。
    fn active_scope(&self, state: &RunState) -> Option<BTreeSet<String>> {
        if !self.config.skill_scope {
            return None;
        }
        state.tool_scope.clone()
    }

    /// 本轮暴露给模型的工具：收窄生效时只保留范围内的工具。
    fn visible_tools(&self, scope: Option<&BTreeSet<String>>) -> Vec<ToolSpec> {
        let specs = self.runtime.registry().specs();
        match scope {
            Some(scope) => specs.into_iter().filter(|spec| scope.contains(&spec.name)).collect(),
            None => specs,
        }
    }

    /// 吸收本轮工具调用产生的技能副作用：记录载入的技能，并按声明收窄可用工具。
    ///
    /// 收窄**从下一轮迭代开始生效**——同一批工具调用是并发执行的，本轮已经在途。
    fn absorb_skill_effects(
        &self,
        session_id: &str,
        iteration: u32,
        state: &mut RunState,
        results: &[(ToolCall, ToolResult)],
    ) {
        for (call, result) in results {
            if call.name != USE_SKILL_TOOL_NAME || !result.ok {
                continue;
            }
            let Some(payload) = result.data.as_ref() else {
                continue;
            };
            let Some(name) = payload.get("skill").and_then(Value::as_str) else {
                continue;
            };
            // `allowed_tools: null` 表示该技能不约束工具。
            let declared: Option<Vec<String>> = payload
                .get("allowed_tools")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect());
            let applied = self.config.skill_scope && declared.is_some();
            if applied {
                state.tool_scope = narrow_scope(state.tool_scope.as_ref(), declared.as_deref());
            }
            self.emit(
                session_id,
                iteration,
                LoopEvent::SkillLoaded {
                    name: name.to_string(),
                    allowed_tools: declared.clone().unwrap_or_default(),
                    scope_applied: applied,
                },
            );
            if applied {
                let visible = state
                    .tool_scope
                    .as_ref()
                    .map(|scope| scope.iter().cloned().collect::<Vec<_>>().join("、"))
                    .unwrap_or_default();
                self.emit(session_id, iteration, LoopEvent::Warning {
                    message: format!(
                        "技能 `{name}` 已收窄本会话可用工具为 {visible}（下一轮迭代生效，可用 --no-skill-scope 关闭）"
                    ),
                });
            }
        }
    }

    /// 调用模型，必要时重试。
    ///
    /// 只有满足以下两个条件才重试：
    /// 1. 错误属于可重试类别（见 [`CoreError::is_retryable`]）；
    /// 2. 本次尝试还没有向用户输出过任何增量——否则重试会把同一段正文再打印一遍。
    async fn generate(
        &self,
        messages: &[Message],
        stream: &dyn StreamSink,
        cancel: &CancellationToken,
        scope: Option<&BTreeSet<String>>,
    ) -> CoreResult<Generation> {
        let mut attempt: u32 = 0;
        loop {
            let request = GenerationRequest {
                model: self.config.model.clone(),
                messages: messages.to_vec(),
                tools: self.visible_tools(scope),
                temperature: self.config.temperature,
                max_tokens: self.config.max_tokens,
            };
            self.emit_no_iteration(LoopEvent::GenerationStarted {
                model: request.model.clone(),
                message_count: request.messages.len(),
                tool_count: request.tools.len(),
            });
            let tracked = DeltaTracker::new(stream);
            let result = tokio::select! {
                biased;
                () = cancel.cancelled() => Err(CoreError::Cancelled),
                result = self.generator.generate(request, &tracked) => result,
            };
            let err = match result {
                Ok(generation) => return Ok(generation),
                Err(err) => err,
            };
            if !err.is_retryable() || tracked.emitted() {
                return Err(err);
            }
            attempt += 1;
            if attempt > self.config.generation_retries {
                return Err(err);
            }
            let backoff = Duration::from_millis(500 * u64::from(attempt));
            self.emit_no_iteration(LoopEvent::Warning {
                message: format!("模型调用失败，第 {attempt} 次重试（{backoff:?} 后）: {err}"),
            });
            tokio::select! {
                () = cancel.cancelled() => return Err(CoreError::Cancelled),
                () = tokio::time::sleep(backoff) => {}
            }
        }
    }

/// 函数级说明（开发者 Jan）：执行 verify 的单一职责，并返回可供调用方继续处理的结果。
    async fn verify(
        &self,
        iteration: u32,
        state: &RunState,
        generation: &Generation,
        cancel: &CancellationToken,
    ) -> Verification {
        self.emit_no_iteration(LoopEvent::VerificationStarted { iteration, verifier: self.verifier.name().to_string() });
        let context = VerificationContext {
            iteration,
            workspace: self.config.workspace.clone(),
            changed_files: state.changed_files.iter().map(PathBuf::from).collect(),
            assistant_message: generation.content.clone(),
            cancel: cancel.clone(),
        };
        match self.verifier.verify(&context).await {
            Ok(verification) => verification,
            Err(CoreError::Cancelled) => Verification::skipped("验证被取消"),
            Err(err) => Verification::failed(0.0, format!("验证器执行失败: {err}")),
        }
    }

/// 函数级说明（开发者 Jan）：执行 execute_tool_calls 的单一职责，并返回可供调用方继续处理的结果。
    async fn execute_tool_calls(
        &self,
        session_id: &str,
        iteration: u32,
        calls: &[ToolCall],
        cancel: &CancellationToken,
        scope: Option<&BTreeSet<String>>,
    ) -> ToolBatch {
        let mut batch = ToolBatch::default();
        if calls.is_empty() {
            return batch;
        }

        let mut ready: Vec<usize> = Vec::new();
        let mut planned: Vec<PlannedCall> = Vec::with_capacity(calls.len());
        let mut needed_approval = false;

        for call in calls {
            self.emit(session_id, iteration, LoopEvent::ToolCallRequested {
                call_id: call.id.clone(),
                tool: call.name.clone(),
                arguments: call.arguments.clone(),
            });
            // 技能收窄在执行前强制生效：模型即便伪造了越界调用，也只会拿到结构化拒绝结果。
            if let Some(scope) = scope {
                if !scope.contains(&call.name) {
                    let reason = format!(
                        "工具 `{}` 不在当前技能允许范围内（可用: {}）",
                        call.name,
                        scope.iter().cloned().collect::<Vec<_>>().join("、")
                    );
                    self.emit(session_id, iteration, LoopEvent::Warning {
                        message: format!("拒绝技能范围之外的工具调用: {}", call.name),
                    });
                    planned.push(PlannedCall::Denied(reason));
                    continue;
                }
            }

            let query = PolicyQuery::new(&call.name, &call.arguments, &self.config.workspace);
            let evaluation = self.policy.evaluate(&query);
            self.emit(session_id, iteration, LoopEvent::PolicyEvaluated {
                call_id: call.id.clone(),
                tool: call.name.clone(),
                decision: evaluation.decision,
                risk: evaluation.risk,
                reason: evaluation.reason.clone(),
            });

            match evaluation.decision {
                PolicyDecision::Deny => {
                    planned.push(PlannedCall::Denied(evaluation.reason.clone()));
                    self.emit(session_id, iteration, LoopEvent::Warning {
                        message: format!("工具 {} 被策略拒绝: {}", call.name, evaluation.reason),
                    });
                }
                PolicyDecision::Allow => {
                    ready.push(planned.len());
                    planned.push(PlannedCall::Ready);
                }
                PolicyDecision::Ask => {
                    needed_approval = true;
                    if self.broker.session_grants().get(&call.name).copied().unwrap_or(false) {
                        ready.push(planned.len());
                        planned.push(PlannedCall::Ready);
                        continue;
                    }
                    let preview = match self.broker.preview(&call.name, &call.arguments, &self.config.workspace).await {
                        Ok(preview) => preview,
                        Err(err) => crate::approval::OperationPreview::new(format!("预览生成失败: {err}")),
                    };
                    let request = ApprovalRequest::new(
                        session_id,
                        &call.name,
                        call.arguments.clone(),
                        evaluation.risk,
                        evaluation.reason.clone(),
                        evaluation.matched_rule.clone(),
                        preview,
                    );
                    self.emit(session_id, iteration, LoopEvent::ApprovalRequested {
                        request_id: request.id.clone(),
                        tool: call.name.clone(),
                        risk: request.risk,
                        summary: request.preview.summary.clone(),
                    });
                    let decision = match self.broker.request(&request).await {
                        Ok(decision) => decision,
                        Err(err) => {
                            self.emit(session_id, iteration, LoopEvent::ApprovalResolved {
                                request_id: request.id.clone(),
                                status: ApprovalStatus::Cancelled,
                                decided_by: self.broker.name().to_string(),
                            });
                            batch.abort = true;
                            batch.abort_reason = Some(err.to_string());
                            planned.push(PlannedCall::Denied(err.to_string()));
                            break;
                        }
                    };
                    let (status, approved) = match decision {
                        ApprovalDecision::Approve => (ApprovalStatus::Approved, true),
                        ApprovalDecision::ApproveForSession => {
                            self.broker.grant_for_session(&call.name);
                            (ApprovalStatus::Approved, true)
                        }
                        ApprovalDecision::Deny => (ApprovalStatus::Denied, false),
                        ApprovalDecision::Abort => (ApprovalStatus::Denied, false),
                    };
                    self.emit(session_id, iteration, LoopEvent::ApprovalResolved {
                        request_id: request.id.clone(),
                        status,
                        decided_by: self.broker.name().to_string(),
                    });
                    if approved {
                        ready.push(planned.len());
                        planned.push(PlannedCall::Ready);
                    } else {
                        batch.abort |= decision == ApprovalDecision::Abort;
                        batch.abort_reason = Some("用户拒绝了该操作".to_string());
                        planned.push(PlannedCall::Denied("用户未批准该操作".to_string()));
                    }
                }
            }
        }

        let concurrency = if needed_approval { 1 } else { self.config.max_tool_concurrency.max(1) };
        let mut results: Vec<Option<ToolResult>> = vec![None; calls.len()];
        for (index, plan) in planned.iter().enumerate() {
            if let PlannedCall::Denied(reason) = plan {
                results[index] = Some(ToolResult::failure(ToolErrorKind::Denied, reason.clone()));
                self.emit(session_id, iteration, LoopEvent::ToolFinished {
                    call_id: calls[index].id.clone(),
                    tool: calls[index].name.clone(),
                    ok: false,
                    exit_code: None,
                    duration_ms: 0,
                    truncated: false,
                    error: Some(reason.clone()),
                });
            }
        }

        let context = ToolContext {
            workspace: self.config.workspace.clone(),
            cancel: cancel.clone(),
            timeout: self.config.tool_timeout,
            dry_run: false,
            guard: Arc::clone(&self.config.guard),
        };
        for (index, result) in self.run_ready_calls(session_id, iteration, calls, &ready, concurrency, context).await {
            results[index] = Some(result);
        }

        for (index, slot) in results.into_iter().enumerate() {
            let result = slot.unwrap_or_else(|| ToolResult::failure(ToolErrorKind::Failed, "工具未执行"));
            batch.results.push((calls[index].clone(), result));
        }
        batch
    }

    /// 并发执行已获准的调用，返回 `(调用下标, 执行结果)`。
    ///
    /// 返回下标而不是写回共享数组：完成顺序由并发决定，调用方仍按模型给出的顺序组装结果。
    async fn run_ready_calls(
        &self,
        session_id: &str,
        iteration: u32,
        calls: &[ToolCall],
        ready: &[usize],
        concurrency: usize,
        context: ToolContext,
    ) -> Vec<(usize, ToolResult)> {
        if ready.is_empty() {
            return Vec::new();
        }
        let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrency));
        let mut set = tokio::task::JoinSet::new();
        for &index in ready {
            let permit = match Arc::clone(&semaphore).acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let runtime = Arc::clone(&self.runtime);
            let sink = Arc::clone(&self.sink);
            let session = session_id.to_string();
            let call = calls[index].clone();
            let context = context.clone();
            let index_key = index;
            set.spawn(async move {
                let _permit = permit;
                sink.emit(&EventRecord {
                    timestamp: Utc::now(),
                    session_id: session.clone(),
                    iteration,
                    event: LoopEvent::ToolStarted { call_id: call.id.clone(), tool: call.name.clone() },
                });
                let result = runtime
                    .execute(ToolInvocation::new(call.id.clone(), call.name.clone(), call.arguments.clone()), &context)
                    .await;
                sink.emit(&EventRecord {
                    timestamp: Utc::now(),
                    session_id: session,
                    iteration,
                    event: LoopEvent::ToolFinished {
                        call_id: call.id.clone(),
                        tool: call.name.clone(),
                        ok: result.ok,
                        exit_code: result.exit_code,
                        duration_ms: result.duration_ms,
                        truncated: result.truncated,
                        error: if result.ok { None } else { Some(result.stderr.clone()) },
                    },
                });
                (index_key, result)
            });
        }
        let mut executed = Vec::with_capacity(ready.len());
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(pair) => executed.push(pair),
                Err(err) => {
                    self.emit(session_id, iteration, LoopEvent::ErrorOccurred { message: format!("工具任务异常: {err}") });
                }
            }
        }
        executed
    }

/// 函数级说明（开发者 Jan）：执行 emit 的单一职责，并返回可供调用方继续处理的结果。
    fn emit(&self, session_id: &str, iteration: u32, event: LoopEvent) {
        self.sink.emit(&EventRecord { timestamp: Utc::now(), session_id: session_id.to_string(), iteration, event });
    }

/// 函数级说明（开发者 Jan）：执行 emit_no_iteration 的单一职责，并返回可供调用方继续处理的结果。
    fn emit_no_iteration(&self, event: LoopEvent) {
        self.sink.emit(&EventRecord { timestamp: Utc::now(), session_id: String::new(), iteration: 0, event });
    }
}

