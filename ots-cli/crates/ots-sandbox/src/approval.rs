//! 审批流程：操作预览、审批记录持久化，以及交互式 / 跨进程两种审批通道。
//!
//! 审批是本项目的「人工闸门」：策略引擎判定为 [`ots_core::PolicyDecision::Ask`] 的调用
//! 必须经过 [`ApprovalBroker`] 才能执行。这里提供三种实现：
//!
//! - [`InteractiveBroker`]：在当前终端展示预览并要求确认，按 [`ots_core::ApprovalLevel`]
//!   分级决定确认强度（常规确认 / 需原样输入确认短语）；
//! - [`DeferredBroker`]：把请求写入 [`ApprovalStore`]，由另一个终端执行
//!   `ots approvals approve <id>` 完成审批，适合非交互场景；
//! - [`ots_core::FixedBroker`]：直接批准或拒绝，用于 `--yes` 与测试。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use ots_config::ApprovalConfig;
use ots_core::{
    ApprovalBroker, ApprovalDecision, ApprovalLevel, ApprovalRequest, ApprovalStatus, CoreError, CoreResult,
    OperationPreview,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::preview::PreviewBuilder;

/// 默认的审批记录目录（相对工作区）。
pub const DEFAULT_STORE_DIR: &str = ".octopuses";
/// 默认的审批记录文件名。
pub const DEFAULT_STORE_FILE: &str = "approvals.jsonl";
/// 等待外部审批时的轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 默认审批记录路径 `<工作区>/.octopuses/approvals.jsonl`。
pub fn default_store_path(workspace: &Path) -> PathBuf {
    workspace.join(DEFAULT_STORE_DIR).join(DEFAULT_STORE_FILE)
}

/// 落盘记录：请求与决策分成两条依次追加，读取时按顺序回放出最新状态。
///
/// 之所以采用「追加 + 回放」而不是「读取-修改-写回」，是为了让
/// 「Agent 写请求」与「审批终端写决策」这两个进程无需任何锁即可共存。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "record", rename_all = "snake_case")]
enum ApprovalRecord {
    /// 新建审批请求。
    ///
    /// 请求本体远大于决策记录，装箱以免每条决策记录都跟着背负几百字节。
    /// `Box` 在 serde 中是透明的，落盘格式与直接内联完全一致。
    Request {
        /// 请求本体。
        request: Box<ApprovalRequest>,
    },
    /// 对某个请求作出决策。
    Decision {
        /// 请求 id。
        id: String,
        /// 决策。
        decision: ApprovalDecision,
        /// 决策后的状态（超时为 `expired`）。
        status: ApprovalStatus,
        /// 决策来源。
        decided_by: String,
        /// 备注。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        /// 决策时间。
        decided_at: DateTime<Utc>,
    },
}

/// 请求的最新状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalEntry {
    /// 请求本体（`status` / `decided_by` / `decided_at` / `note` 已回放为最新值）。
    pub request: ApprovalRequest,
    /// 决策内容；`None` 表示仍在等待。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<ApprovalDecision>,
}

impl ApprovalEntry {
    /// 是否仍在等待决策。
    pub fn is_pending(&self) -> bool {
        self.request.status == ApprovalStatus::Pending
    }
}

/// 审批记录存储：单文件 JSONL，追加写入。
///
/// 每次写入都是一次 `O_APPEND` 的整行写入，因此多个进程可以安全地并发追加；
/// 读取时会跳过损坏的行（例如进程被杀导致写了一半），以免个别坏行让整段审批历史不可用。
#[derive(Debug, Clone)]
pub struct ApprovalStore {
    path: PathBuf,
}

impl ApprovalStore {
    /// 指定存储文件路径。
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 依据审批配置确定存储路径，未配置时使用 [`default_store_path`]。
    pub fn from_config(config: &ApprovalConfig, workspace: &Path) -> Self {
        let path = match &config.store_path {
            Some(path) if path.is_absolute() => path.clone(),
            Some(path) => workspace.join(path),
            None => default_store_path(workspace),
        };
        Self::new(path)
    }

    /// 存储文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 写入一条审批请求。
    ///
    /// # Errors
    /// 目录创建失败或写入失败时返回 [`CoreError::Other`]。
    pub async fn append(&self, request: &ApprovalRequest) -> CoreResult<()> {
        self.append_record(&ApprovalRecord::Request { request: Box::new(request.clone()) }).await
    }

    /// 记录一次人工决策。
    ///
    /// # Errors
    /// 写入失败时返回 [`CoreError::Other`]。
    pub async fn decide(
        &self,
        id: &str,
        decision: ApprovalDecision,
        decided_by: &str,
        note: Option<&str>,
    ) -> CoreResult<()> {
        self.append_record(&ApprovalRecord::Decision {
            id: id.to_string(),
            decision,
            status: decision.status(),
            decided_by: decided_by.to_string(),
            note: note.map(str::to_string),
            decided_at: Utc::now(),
        })
        .await
    }

    /// 记录一次超时失效。
    ///
    /// # Errors
    /// 写入失败时返回 [`CoreError::Other`]。
    pub async fn expire(&self, id: &str, reason: &str) -> CoreResult<()> {
        self.append_record(&ApprovalRecord::Decision {
            id: id.to_string(),
            decision: ApprovalDecision::Deny,
            status: ApprovalStatus::Expired,
            decided_by: "timeout".to_string(),
            note: Some(reason.to_string()),
            decided_at: Utc::now(),
        })
        .await
    }

    /// 全部审批请求（按发起顺序，状态为最新值）。
    ///
    /// # Errors
    /// 读取失败时返回 [`CoreError::Other`]。
    pub async fn list(&self) -> CoreResult<Vec<ApprovalEntry>> {
        let text = match tokio::fs::read_to_string(&self.path).await {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(CoreError::other(format!("读取审批记录 {} 失败: {err}", self.path.display()))),
        };
        Ok(replay(&text))
    }

    /// 单个请求的最新状态。
    ///
    /// # Errors
    /// 读取失败时返回 [`CoreError::Other`]。
    pub async fn get(&self, id: &str) -> CoreResult<Option<ApprovalEntry>> {
        Ok(self.list().await?.into_iter().find(|entry| entry.request.id == id))
    }

    /// 仍在等待决策的请求。
    ///
    /// # Errors
    /// 读取失败时返回 [`CoreError::Other`]。
    pub async fn pending(&self) -> CoreResult<Vec<ApprovalEntry>> {
        Ok(self.list().await?.into_iter().filter(ApprovalEntry::is_pending).collect())
    }

    /// 向 JSONL 追加一条审批记录（开发者 Jan）。
    ///
    /// 采用追加而非整体重写：审批可能被多个进程并发读写（前端落盘、另一个终端决策），
    /// 追加写天然不覆盖彼此的记录，配合 [`replay`] 按行回放即可还原最新状态。
    ///
    /// # Errors
    /// 目录创建、序列化或写入失败时返回 [`CoreError::Other`]。
    async fn append_record(&self, record: &ApprovalRecord) -> CoreResult<()> {
        use tokio::io::AsyncWriteExt;

        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| CoreError::other(format!("创建审批目录 {} 失败: {err}", parent.display())))?;
        }
        let mut line = serde_json::to_string(record).map_err(|err| CoreError::other(format!("序列化审批记录失败: {err}")))?;
        line.push('\n');
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(|err| CoreError::other(format!("打开审批记录 {} 失败: {err}", self.path.display())))?;
        file.write_all(line.as_bytes())
            .await
            .map_err(|err| CoreError::other(format!("写入审批记录 {} 失败: {err}", self.path.display())))?;
        Ok(())
    }
}

/// 回放 JSONL 文本，得到每个请求的最新状态。
fn replay(text: &str) -> Vec<ApprovalEntry> {
    let mut entries: Vec<ApprovalEntry> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record: ApprovalRecord = match serde_json::from_str(line) {
            Ok(record) => record,
            Err(err) => {
                tracing::warn!("跳过审批记录第 {} 行（解析失败: {err}）", index + 1);
                continue;
            }
        };
        match record {
            ApprovalRecord::Request { request } => {
                if entries.iter().any(|entry| entry.request.id == request.id) {
                    continue;
                }
                entries.push(ApprovalEntry { request: *request, decision: None });
            }
            ApprovalRecord::Decision { id, decision, status, decided_by, note, decided_at } => {
                if let Some(entry) = entries.iter_mut().find(|entry| entry.request.id == id) {
                    entry.request.status = status;
                    entry.request.decided_by = Some(decided_by);
                    entry.request.note = note;
                    entry.request.decided_at = Some(decided_at);
                    entry.decision = Some(decision);
                }
            }
        }
    }
    entries
}

/// 交互式提问通道。
///
/// 抽出这一层是为了让审批逻辑可以在没有真实终端的情况下被测试。
#[async_trait]
pub trait Prompter: Send + Sync {
    /// 展示提示并读取一行回答。
    ///
    /// # Errors
    /// 读取失败或输入流结束（EOF，视为用户中断）时返回错误。
    async fn ask(&self, prompt: &str) -> CoreResult<String>;
}

/// 基于标准输入输出的提问通道。
pub struct StdioPrompter {
    stdin: tokio::sync::Mutex<tokio::io::BufReader<tokio::io::Stdin>>,
}

impl StdioPrompter {
    /// 新建。
    pub fn new() -> Self {
        Self { stdin: tokio::sync::Mutex::new(tokio::io::BufReader::new(tokio::io::stdin())) }
    }
}

impl Default for StdioPrompter {
    /// 默认构造（开发者 Jan）：与 [`StdioPrompter::new`] 等价，便于直接当作默认通道使用
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Prompter for StdioPrompter {
    /// 打印提示并读一行（开发者 Jan）：读到 EOF 视为用户中断（Ctrl-D），转成 [`CoreError::Cancelled`]
    async fn ask(&self, prompt: &str) -> CoreResult<String> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let mut stdout = tokio::io::stdout();
        stdout
            .write_all(prompt.as_bytes())
            .await
            .map_err(|err| CoreError::other(format!("写入终端失败: {err}")))?;
        stdout.flush().await.map_err(|err| CoreError::other(format!("刷新终端失败: {err}")))?;

        let mut line = String::new();
        let mut stdin = self.stdin.lock().await;
        let read = stdin
            .read_line(&mut line)
            .await
            .map_err(|err| CoreError::other(format!("读取输入失败: {err}")))?;
        if read == 0 {
            return Err(CoreError::Cancelled);
        }
        Ok(line.trim_end_matches(['\n', '\r']).to_string())
    }
}

/// 交互式审批代理。
///
/// 确认强度直接来自 [`ApprovalLevel`]：常规确认接受 `y/n/a/q`，
/// 强化确认与受限操作必须原样输入配置中的确认短语。
pub struct InteractiveBroker {
    prompt: Arc<dyn Prompter>,
    previews: Arc<PreviewBuilder>,
    elevated_phrase: String,
    grants: Mutex<BTreeMap<String, bool>>,
}

impl InteractiveBroker {
    /// 构造交互式审批代理。
    pub fn new(
        prompt: Arc<dyn Prompter>,
        previews: Arc<PreviewBuilder>,
        config: &ApprovalConfig,
    ) -> Self {
        Self {
            prompt,
            previews,
            elevated_phrase: config.elevated_phrase.clone(),
            grants: Mutex::new(BTreeMap::new()),
        }
    }
}

#[async_trait]
impl ApprovalBroker for InteractiveBroker {
    /// 生成操作预览（开发者 Jan）：交给共用的 PreviewBuilder，让「将要执行什么」在提问前就可见
    async fn preview(&self, tool: &str, arguments: &Value, cwd: &Path) -> CoreResult<OperationPreview> {
        Ok(self.previews.build(tool, arguments, cwd).await)
    }

    /// 交互式征求审批（开发者 Jan）。
    ///
    /// 确认强度按 [`ApprovalLevel`] 分档：
    /// - Automatic 直接放行，不问；
    /// - Standard 接受 y / n / a / q，其中 a 表示本会话内总是批准该工具；
    /// - Elevated 与 Restricted 必须**原样输入**配置里的确认短语，其余任何输入都视为拒绝。
    ///
    /// 之所以对高风险档位不提供简写：这类操作一旦误批代价很大，
    /// 强制用户完整输入短语本身就是一道「确认自己看清楚了」的心理关卡。
    async fn request(&self, request: &ApprovalRequest) -> CoreResult<ApprovalDecision> {
        if request.level == ApprovalLevel::Automatic {
            return Ok(ApprovalDecision::Approve);
        }
        let question = match request.level {
            ApprovalLevel::Automatic => String::new(),
            ApprovalLevel::Standard => "批准执行？[y=批准 / n=拒绝 / a=本会话内总是批准 / q=终止循环] ".to_string(),
            ApprovalLevel::Elevated | ApprovalLevel::Restricted => format!(
                "这是{}操作，请输入 `{}` 以确认（其它任何输入都视为拒绝）：",
                request.level.label(),
                self.elevated_phrase
            ),
        };
        let answer = self.prompt.ask(&format!("{}\n{question}", request.render())).await?;
        let answer = answer.trim();

        if matches!(request.level, ApprovalLevel::Elevated | ApprovalLevel::Restricted) {
            return Ok(if answer == self.elevated_phrase {
                ApprovalDecision::Approve
            } else {
                ApprovalDecision::Deny
            });
        }

        Ok(match answer.to_ascii_lowercase().as_str() {
            "y" | "yes" => ApprovalDecision::Approve,
            "a" | "all" => ApprovalDecision::ApproveForSession,
            "q" | "quit" | "abort" => ApprovalDecision::Abort,
            _ => ApprovalDecision::Deny,
        })
    }

    /// 返回本会话已授权的工具集合（开发者 Jan）：供上层在后续调用时跳过重复提问
    fn session_grants(&self) -> BTreeMap<String, bool> {
        self.grants.lock().expect("审批授权锁未中毒").clone()
    }

    /// 把某个工具标记为本会话内总是批准（开发者 Jan），对应提问时的 a 选项
    fn grant_for_session(&self, tool: &str) {
        self.grants.lock().expect("审批授权锁未中毒").insert(tool.to_string(), true);
    }

    /// 代理标识（开发者 Jan）：用于在日志与审批记录里区分不同审批通道
    fn name(&self) -> &str {
        "interactive"
    }
}

/// 跨进程审批代理：请求落盘后等待另一个终端处理。
pub struct DeferredBroker {
    store: ApprovalStore,
    previews: Arc<PreviewBuilder>,
    wait: Duration,
    grants: Mutex<BTreeMap<String, bool>>,
}

impl DeferredBroker {
    /// 构造跨进程审批代理，`wait_secs` 为最长等待秒数。
    pub fn new(store: ApprovalStore, previews: Arc<PreviewBuilder>, wait_secs: u64) -> Self {
        Self {
            store,
            previews,
            wait: Duration::from_secs(wait_secs),
            grants: Mutex::new(BTreeMap::new()),
        }
    }

    /// 审批记录存储。
    pub fn store(&self) -> &ApprovalStore {
        &self.store
    }
}

#[async_trait]
impl ApprovalBroker for DeferredBroker {
    /// 生成操作预览（开发者 Jan）：与交互式代理共用同一套预览构造，保证两种通道看到的信息一致
    async fn preview(&self, tool: &str, arguments: &Value, cwd: &Path) -> CoreResult<OperationPreview> {
        Ok(self.previews.build(tool, arguments, cwd).await)
    }

    /// 落盘后轮询等待另一个终端给出决策（开发者 Jan）。
    ///
    /// 这条通道给「无人值守但需要审批」的场景用：请求写进审批记录后，
    /// 由用户在另一个终端执行 `ots approvals approve/deny <id>` 来决策，
    /// 这里以固定间隔轮询记录，直到拿到决策或超过最长等待时间。
    /// 超时不是静默失败：会把该请求标记为过期并返回审批拒绝，
    /// 否则一次挂起会让整轮运行永远卡住。
    ///
    /// # Errors
    /// 等待超时返回 [`CoreError::ApprovalDenied`]；读写审批记录失败时返回 [`CoreError::Other`]。
    async fn request(&self, request: &ApprovalRequest) -> CoreResult<ApprovalDecision> {
        self.store.append(request).await?;
        tracing::warn!(
            "等待人工审批：请在另一个终端执行 `ots approvals approve {}` 或 `ots approvals deny {}`，最长等待 {} 秒",
            request.id,
            request.id,
            self.wait.as_secs()
        );

        let deadline = Instant::now() + self.wait;
        loop {
            if let Some(entry) = self.store.get(&request.id).await? {
                if let Some(decision) = entry.decision {
                    if decision == ApprovalDecision::ApproveForSession {
                        self.grant_for_session(&request.tool);
                    }
                    return Ok(decision);
                }
            }
            if Instant::now() >= deadline {
                let reason = format!("等待审批超时（{} 秒）", self.wait.as_secs());
                self.store.expire(&request.id, &reason).await?;
                return Err(CoreError::ApprovalDenied(reason));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// 返回本会话已授权的工具集合（开发者 Jan）：跨进程通道同样支持「本会话内总是批准」
    fn session_grants(&self) -> BTreeMap<String, bool> {
        self.grants.lock().expect("审批授权锁未中毒").clone()
    }

    /// 把某个工具标记为本会话内总是批准（开发者 Jan）
    fn grant_for_session(&self, tool: &str) {
        self.grants.lock().expect("审批授权锁未中毒").insert(tool.to_string(), true);
    }

    /// 代理标识（开发者 Jan）：固定为 store，表明决策来自落盘的审批记录
    fn name(&self) -> &str {
        "store"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_config::OtsConfig;
    use ots_core::{ApprovalRequest, OperationPreview, RiskLevel, SkillRegistry, ToolLimits, ToolRuntime};
    use ots_tools::build_registry;
    use serde_json::json;

    #[derive(Default)]
    struct ScriptedPrompter {
        answers: Mutex<Vec<String>>,
        asked: Mutex<Vec<String>>,
    }

    impl ScriptedPrompter {
        fn new(answers: &[&str]) -> Self {
            Self {
                answers: Mutex::new(answers.iter().map(|answer| (*answer).to_string()).collect()),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn last_question(&self) -> String {
            self.asked.lock().expect("提示锁未中毒").last().cloned().unwrap_or_default()
        }
    }

    #[async_trait]
    impl Prompter for ScriptedPrompter {
        async fn ask(&self, prompt: &str) -> CoreResult<String> {
            self.asked.lock().expect("提示锁未中毒").push(prompt.to_string());
            let mut answers = self.answers.lock().expect("答案锁未中毒");
            if answers.is_empty() {
                return Err(CoreError::Cancelled);
            }
            Ok(answers.remove(0))
        }
    }

    fn previews(workspace: &Path) -> Arc<PreviewBuilder> {
        let config = OtsConfig::default();
        let runtime = Arc::new(ToolRuntime::new(
            build_registry(&config, Arc::new(SkillRegistry::new())).expect("构造成功"),
            ToolLimits::default(),
        ));
        let guard = crate::guard::build_guard(&config, workspace).expect("构造成功");
        Arc::new(PreviewBuilder::new(runtime, guard, workspace))
    }

    fn broker(prompter: Arc<dyn Prompter>, workspace: &Path) -> InteractiveBroker {
        InteractiveBroker::new(prompter, previews(workspace), &ApprovalConfig::default())
    }

    fn request(risk: RiskLevel) -> ApprovalRequest {
        ApprovalRequest::new(
            "s1",
            "write_file",
            json!({ "path": "a.txt", "content": "x" }),
            risk,
            "需要确认",
            None,
            OperationPreview::new("写文件"),
        )
    }

    #[tokio::test]
    async fn 常规确认回答y即批准() {
        let dir = tempfile::tempdir().expect("临时目录");
        let prompter = Arc::new(ScriptedPrompter::new(&["y"]));
        let broker = broker(prompter.clone(), dir.path());
        let decision = broker.request(&request(RiskLevel::Medium)).await.expect("请求成功");
        assert_eq!(decision, ApprovalDecision::Approve);
        assert!(prompter.last_question().contains("批准执行"));
    }

    #[tokio::test]
    async fn 常规确认回答a记住本会话授权() {
        let dir = tempfile::tempdir().expect("临时目录");
        let broker = broker(Arc::new(ScriptedPrompter::new(&["a"])), dir.path());
        let decision = broker.request(&request(RiskLevel::Medium)).await.expect("请求成功");
        assert_eq!(decision, ApprovalDecision::ApproveForSession);
        broker.grant_for_session("write_file");
        assert_eq!(broker.session_grants().get("write_file"), Some(&true));
    }

    #[tokio::test]
    async fn 常规确认回答其它内容即拒绝() {
        let dir = tempfile::tempdir().expect("临时目录");
        for answer in ["n", "no", ""] {
            let broker = broker(Arc::new(ScriptedPrompter::new(&[answer])), dir.path());
            let decision = broker.request(&request(RiskLevel::Medium)).await.expect("请求成功");
            assert_eq!(decision, ApprovalDecision::Deny, "回答 `{answer}` 应被拒绝");
        }
    }

    #[tokio::test]
    async fn 回答q终止整个循环() {
        let dir = tempfile::tempdir().expect("临时目录");
        let broker = broker(Arc::new(ScriptedPrompter::new(&["q"])), dir.path());
        let decision = broker.request(&request(RiskLevel::Medium)).await.expect("请求成功");
        assert_eq!(decision, ApprovalDecision::Abort);
    }

    #[tokio::test]
    async fn 强化确认必须原样输入短语() {
        let dir = tempfile::tempdir().expect("临时目录");
        let config = ApprovalConfig::default();

        let prompter = Arc::new(ScriptedPrompter::new(&["y"]));
        let broker = InteractiveBroker::new(prompter.clone(), previews(dir.path()), &config);
        assert_eq!(
            broker.request(&request(RiskLevel::High)).await.expect("请求成功"),
            ApprovalDecision::Deny,
            "简单回答 y 不足以通过强化确认"
        );
        assert!(prompter.last_question().contains(&config.elevated_phrase));

        let prompter = Arc::new(ScriptedPrompter::new(&[config.elevated_phrase.as_str()]));
        let broker = InteractiveBroker::new(prompter, previews(dir.path()), &config);
        assert_eq!(
            broker.request(&request(RiskLevel::High)).await.expect("请求成功"),
            ApprovalDecision::Approve
        );
    }

    #[tokio::test]
    async fn 预览包含越界路径提示() {
        let dir = tempfile::tempdir().expect("临时目录");
        let broker = broker(Arc::new(ScriptedPrompter::new(&["n"])), dir.path());
        let preview = broker
            .preview("write_file", &json!({ "path": "/etc/hosts", "content": "x" }), dir.path())
            .await
            .expect("预览成功");
        assert_eq!(preview.out_of_scope.len(), 1);
    }

    #[tokio::test]
    async fn 审批记录可落盘并回放决策() {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = ApprovalStore::new(dir.path().join("approvals.jsonl"));
        let request = request(RiskLevel::Medium);
        store.append(&request).await.expect("写入成功");
        assert_eq!(store.pending().await.expect("读取成功").len(), 1);

        store
            .decide(&request.id, ApprovalDecision::ApproveForSession, "tty2", Some("人工确认"))
            .await
            .expect("写入成功");

        let entry = store.get(&request.id).await.expect("读取成功").expect("存在");
        assert_eq!(entry.request.status, ApprovalStatus::Approved);
        assert_eq!(entry.decision, Some(ApprovalDecision::ApproveForSession));
        assert_eq!(entry.request.decided_by.as_deref(), Some("tty2"));
        assert!(store.pending().await.expect("读取成功").is_empty());
    }

    #[tokio::test]
    async fn 未出现的存储文件视为空列表() {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = ApprovalStore::new(dir.path().join("nope.jsonl"));
        assert!(store.list().await.expect("读取成功").is_empty());
    }

    #[tokio::test]
    async fn 跨进程审批在外部写入决策后返回() {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = ApprovalStore::new(dir.path().join("approvals.jsonl"));
        let broker = DeferredBroker::new(store.clone(), previews(dir.path()), 30);
        let request = request(RiskLevel::Medium);

        // 模拟「另一个终端」：等待请求落盘后写入决策。
        let approver = {
            let store = store.clone();
            let id = request.id.clone();
            tokio::spawn(async move {
                loop {
                    if store.get(&id).await.expect("读取成功").is_some() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                store.decide(&id, ApprovalDecision::Approve, "tty2", None).await.expect("写入成功");
            })
        };

        let decision = broker.request(&request).await.expect("请求成功");
        approver.await.expect("等待审批终端结束");
        assert_eq!(decision, ApprovalDecision::Approve);
        assert_eq!(broker.name(), "store");
    }

    #[tokio::test]
    async fn 等待超时后记为过期() {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = ApprovalStore::new(dir.path().join("approvals.jsonl"));
        let broker = DeferredBroker::new(store.clone(), previews(dir.path()), 0);
        let request = request(RiskLevel::Medium);

        let err = broker.request(&request).await.expect_err("应超时");
        assert!(matches!(err, CoreError::ApprovalDenied(_)));
        let entry = store.get(&request.id).await.expect("读取成功").expect("存在");
        assert_eq!(entry.request.status, ApprovalStatus::Expired);
    }

    #[tokio::test]
    async fn 配置指定的存储路径相对工作区解析() {
        let dir = tempfile::tempdir().expect("临时目录");
        let config = ApprovalConfig {
            store_path: Some(PathBuf::from("tmp/approvals.jsonl")),
            ..ApprovalConfig::default()
        };
        let store = ApprovalStore::from_config(&config, dir.path());
        assert_eq!(store.path(), dir.path().join("tmp/approvals.jsonl"));

        let store = ApprovalStore::from_config(&ApprovalConfig::default(), dir.path());
        assert_eq!(store.path(), dir.path().join(DEFAULT_STORE_DIR).join(DEFAULT_STORE_FILE));
    }
}
