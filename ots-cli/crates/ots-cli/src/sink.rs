//! 事件呈现层：控制台渲染、JSON 事件流与审计落盘。
//!
//! 循环内核只产生 [`LoopEvent`]，如何呈现完全由这里决定：
//! 同一个循环既能输出给人看的多行日志，也能输出给机器消费的 JSON 流，
//! 并独立地把「关键事实」追加进审计文件（不含逐 token 的高频增量）。

use std::fs::OpenOptions;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ots_config::LogFormat;
use ots_core::{ApprovalStatus, EventRecord, EventSink, LoopEvent};
use tracing_subscriber::EnvFilter;

/// 审计文件相对于工作区的默认位置。
pub const AUDIT_RELATIVE_PATH: &str = ".octopuses/audit.jsonl";

/// 初始化日志订阅器。
///
/// 日志一律写 stderr，stdout 留给事件流与命令结果，便于 `ots ... > result.json`。
/// 重复初始化会被忽略，因此库使用者可以放心调用。
pub fn init_tracing(level: &str, format: LogFormat) {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|err| {
        eprintln!("日志级别 `{level}` 无法解析（{err}），回退为 info");
        EnvFilter::new("info")
    });
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr);
    match format {
        LogFormat::Json => {
            let _ = builder.json().try_init();
        }
        LogFormat::Text => {
            let _ = builder.try_init();
        }
    }
}

/// 把多个接收器组合成一个（例如「控制台 + 审计文件」）。
pub struct MultiSink {
    sinks: Vec<Arc<dyn EventSink>>,
}

impl MultiSink {
    /// 组合若干接收器。
    pub fn new(sinks: Vec<Arc<dyn EventSink>>) -> Self {
        Self { sinks }
    }
}

impl EventSink for MultiSink {
    /// 广播一条事件给所有子接收器（开发者 Jan）：逐个转发，单个接收器失败不影响其余
    fn emit(&self, record: &EventRecord) {
        for sink in &self.sinks {
            sink.emit(record);
        }
    }

    /// 广播进度文本（开发者 Jan）
    fn progress(&self, text: &str) {
        for sink in &self.sinks {
            sink.progress(text);
        }
    }

    /// 广播清除进度（开发者 Jan）
    fn clear_progress(&self) {
        for sink in &self.sinks {
            sink.clear_progress();
        }
    }
}

/// 控制台渲染状态。
#[derive(Default)]
struct ConsoleState {
    /// 流式正文是否停在半行（未换行）。
    mid_line: bool,
}

/// 面向人的控制台渲染。
pub struct ConsoleEventSink {
    state: Mutex<ConsoleState>,
    color: bool,
    progress: bool,
    show_reasoning: bool,
}

impl ConsoleEventSink {
    /// 构造控制台接收器。
    ///
    /// `progress` 控制单行进度；`show_reasoning` 控制是否输出推理增量。
    pub fn new(progress: bool, show_reasoning: bool) -> Self {
        Self {
            state: Mutex::new(ConsoleState::default()),
            color: std::io::stdout().is_terminal(),
            progress,
            show_reasoning,
        }
    }

    /// 输出一整行（必要时先结束挂起的流式正文行）。
    fn line(&self, text: &str) {
        let mut state = self.state.lock().expect("控制台状态锁未中毒");
        if state.mid_line {
            println!();
            state.mid_line = false;
        }
        println!("{text}");
    }

    /// 按需着色。
    fn paint(&self, code: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }
}

impl EventSink for ConsoleEventSink {
    /// 把一条事件渲染成人可读的控制台输出（开发者 Jan）。
    ///
    /// 按事件类型分派：轮次与目标打印成小标题，模型正文直接流式打印（不换行，
    /// 因此要记 mid_line 以便后续整行输出前先补一个换行），推理增量走 stderr
    /// 并按 show_reasoning 开关决定是否显示——推理是过程性内容，默认不干扰正文阅读。
    fn emit(&self, record: &EventRecord) {
        match &record.event {
            LoopEvent::LoopStarted { goal, max_iterations } => {
                self.line(&format!("目标: {goal}"));
                self.line(&format!("最大迭代: {max_iterations} 轮"));
            }
            LoopEvent::IterationStarted { iteration } => {
                self.line("");
                self.line(&format!("── 第 {iteration} 轮 ──"));
            }
            LoopEvent::GenerationStarted { model, message_count, tool_count } => {
                tracing::debug!("调用模型 {model}（{message_count} 条消息，{tool_count} 个工具）");
            }
            LoopEvent::GenerationDelta { text } => {
                print!("{text}");
                let _ = std::io::stdout().flush();
                self.state.lock().expect("控制台状态锁未中毒").mid_line = true;
            }
            LoopEvent::ReasoningDelta { text } => {
                if self.show_reasoning {
                    let mut state = self.state.lock().expect("控制台状态锁未中毒");
                    if state.mid_line {
                        println!();
                        state.mid_line = false;
                    }
                    eprint!("{}", self.paint("2", text));
                }
            }
            LoopEvent::GenerationFinished { content_chars, tool_call_count, usage, .. } => {
                let mut state = self.state.lock().expect("控制台状态锁未中毒");
                if state.mid_line {
                    println!();
                    state.mid_line = false;
                }
                drop(state);
                if *tool_call_count > 0 {
                    self.line(&format!(
                        "（本轮 {content_chars} 字，请求 {tool_call_count} 个工具调用，tokens {}/{}）",
                        usage.prompt_tokens, usage.completion_tokens
                    ));
                }
            }
            LoopEvent::ToolCallRequested { .. } => {}
            LoopEvent::PolicyEvaluated { tool, decision, reason, .. } => {
                if *decision == ots_core::PolicyDecision::Deny {
                    self.line(&format!("策略拒绝: {tool} —— {reason}"));
                } else {
                    tracing::debug!("策略裁决 {tool}: {decision:?} —— {reason}");
                }
            }
            LoopEvent::ApprovalRequested { tool, summary, .. } => {
                self.line(&format!("等待人工审批: {tool} —— {summary}"));
            }
            LoopEvent::ApprovalResolved { status, decided_by, .. } => {
                self.line(&format!("审批结果: {}（来源 {decided_by}）", approval_status_label(*status)));
            }
            LoopEvent::ToolStarted { tool, .. } => {
                if self.progress {
                    self.progress(&format!("执行 {tool} …"));
                }
            }
            LoopEvent::ToolFinished { tool, ok, duration_ms, error, .. } => {
                self.clear_progress();
                if *ok {
                    self.line(&format!("[完成] {tool}（{duration_ms} ms）"));
                } else {
                    let reason = error.as_deref().map(first_line).unwrap_or("未知原因");
                    self.line(&format!("[失败] {tool}（{duration_ms} ms）: {reason}"));
                }
            }
            LoopEvent::FileChanged { path, kind } => {
                self.line(&format!("  [{}] {path}", kind.marker()));
            }
            LoopEvent::VerificationStarted { verifier, .. } => {
                if self.progress {
                    self.progress(&format!("执行验证（{verifier}）…"));
                }
            }
            LoopEvent::VerificationFinished { passed, score, skipped, summary, .. } => {
                self.clear_progress();
                let verdict = if *skipped {
                    "已跳过".to_string()
                } else if *passed {
                    format!("通过（得分 {score:.2}）")
                } else {
                    format!("未通过（得分 {score:.2}）")
                };
                self.line(&format!("验证{verdict}: {summary}"));
            }
            LoopEvent::SkillLoaded { name, allowed_tools, scope_applied } => {
                if *scope_applied && allowed_tools.is_empty() {
                    self.line(&format!("技能 {name} 已加载（未开放任何工具）"));
                } else if *scope_applied {
                    self.line(&format!("技能 {name} 已加载（工具范围: {}）", allowed_tools.join("、")));
                } else {
                    self.line(&format!("技能 {name} 已加载"));
                }
            }
            LoopEvent::Warning { message } => self.line(&format!("警告: {message}")),
            LoopEvent::ErrorOccurred { message } => self.line(&format!("错误: {message}")),
            LoopEvent::LoopFinished { reason, iterations, usage } => {
                self.line("");
                self.line(&format!(
                    "循环结束: {}（{iterations} 轮，tokens 合计 {}）",
                    reason.label(),
                    usage.total_tokens
                ));
            }
        }
    }

    /// 在 stderr 上原地刷新单行进度（开发者 Jan）。
    ///
    /// 走 stderr 而非 stdout，是为了不污染 stdout 的正文与 JSON 事件流；
    /// 先发 \r 与清行控制符再写文本，才能原地覆盖上一行而不刷屏。
    /// progress 关闭时直接返回，便于在管道里使用时保持输出干净。
    fn progress(&self, text: &str) {
        if !self.progress {
            return;
        }
        let mut stderr = std::io::stderr();
        let _ = write!(stderr, "\r\x1b[2K{text}");
        let _ = stderr.flush();
    }

    /// 清除当前进度行（开发者 Jan）：同样先回到行首再清整行，让后续正式输出不被残留文字污染
    fn clear_progress(&self) {
        if !self.progress {
            return;
        }
        let mut stderr = std::io::stderr();
        let _ = write!(stderr, "\r\x1b[2K");
        let _ = stderr.flush();
    }
}

/// 逐行输出 JSON 事件流（含流式增量），供其它程序消费。
pub struct JsonEventSink;

impl EventSink for JsonEventSink {
    /// 每个事件输出一行 JSON（开发者 Jan）。
    ///
    /// 含逐 token 的流式增量：这条通道就是给程序消费的，
    /// 增量不能丢，否则消费方无法重建完整的流式过程。
    /// 序列化失败时把原因写到 stderr，不让单条坏事件中断整个事件流。
    fn emit(&self, record: &EventRecord) {
        match serde_json::to_string(record) {
            Ok(line) => println!("{line}"),
            Err(err) => eprintln!("事件序列化失败: {err}"),
        }
    }
}

/// 审计日志：把关键事实追加进 JSONL 文件。
///
/// 逐 token 的流式增量（[`LoopEvent::is_high_frequency`]）不落盘，避免审计文件被噪声淹没。
pub struct AuditWriter {
    path: PathBuf,
    file: Mutex<Option<std::fs::File>>,
}

impl AuditWriter {
    /// 打开（或创建）审计文件。
    ///
    /// # Errors
    /// 目录创建失败或文件无法打开时返回错误。
    pub fn open(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self { path, file: Mutex::new(Some(file)) })
    }

    /// 审计文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl EventSink for AuditWriter {
    /// 把一条事件追加进审计文件（开发者 Jan）。
    ///
    /// 逐 token 的流式增量（is_high_frequency）直接跳过：它们数量巨大且没有审计价值，
    /// 落盘只会把真正关键的决策与工具调用淹没。
    /// 序列化或写入失败都只记一条 warn，不向上抛——审计是旁路，
    /// 不能因为它出问题就让整轮运行失败。
    fn emit(&self, record: &EventRecord) {
        if record.event.is_high_frequency() {
            return;
        }
        let line = match serde_json::to_string(record) {
            Ok(line) => line,
            Err(err) => {
                tracing::warn!("审计事件序列化失败: {err}");
                return;
            }
        };
        let mut guard = self.file.lock().expect("审计文件锁未中毒");
        let Some(file) = guard.as_mut() else {
            return;
        };
        if let Err(err) = writeln!(file, "{line}") {
            tracing::warn!("写入审计文件 {} 失败: {err}", self.path.display());
            *guard = None;
        }
    }
}

/// 审批状态的中文名。
pub fn approval_status_label(status: ApprovalStatus) -> &'static str {
    match status {
        ApprovalStatus::Pending => "等待中",
        ApprovalStatus::Approved => "已批准",
        ApprovalStatus::Denied => "已拒绝",
        ApprovalStatus::Expired => "已过期",
        ApprovalStatus::Cancelled => "已取消",
    }
}

/// 取文本的第一行并限制长度，用于单行摘要。
pub fn first_line(text: &str) -> &str {
    text.lines().find(|line| !line.trim().is_empty()).map(str::trim).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn record(event: LoopEvent) -> EventRecord {
        EventRecord { timestamp: Utc::now(), session_id: "s1".to_string(), iteration: 1, event }
    }

    #[test]
    fn 审计文件跳过高频增量() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("audit.jsonl");
        let writer = AuditWriter::open(&path).expect("打开成功");
        writer.emit(&record(LoopEvent::GenerationDelta { text: "逐字".to_string() }));
        writer.emit(&record(LoopEvent::Warning { message: "重要".to_string() }));

        let text = std::fs::read_to_string(&path).expect("读回成功");
        assert_eq!(text.lines().count(), 1, "只应写入非高频事件: {text}");
        assert!(text.contains("重要"));
    }

    #[test]
    fn 组合接收器同时分发() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("audit.jsonl");
        let audit = Arc::new(AuditWriter::open(&path).expect("打开成功"));
        let sink = MultiSink::new(vec![audit]);
        sink.emit(&record(LoopEvent::LoopStarted { goal: "目标".to_string(), max_iterations: 3 }));
        sink.progress("进行中");
        sink.clear_progress();
        let text = std::fs::read_to_string(&path).expect("读回成功");
        assert!(text.contains("loop_started"));
        assert!(text.contains("目标"));
    }

    #[test]
    fn 首行摘要忽略空行() {
        assert_eq!(first_line("\n\n  第一行  \n第二行"), "第一行");
        assert_eq!(first_line("   "), "");
    }
}
