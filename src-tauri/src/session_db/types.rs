use serde::{Deserialize, Serialize};

/// 一个消息片段（会话内最小持久化单元）
///
/// `kind` 是片段类型（`text` / `reasoning` / `tool_call` / `question` / `diff` / `sources`），
/// `payload` 是该片段完整内容的 JSON 原文，Rust 侧不解析其内部结构，保证无损往返。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    /// 片段 id
    pub id: String,
    /// 片段在所属消息内的顺序
    pub seq: i64,
    /// 片段类型
    pub kind: String,
    /// 片段完整内容的 JSON 原文
    pub payload: String,
}

/// 一条消息（用户或助手）
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    /// 消息 id
    pub id: String,
    /// 角色：`user` / `assistant`
    pub role: String,
    /// 消息在所属会话内的顺序
    pub seq: i64,
    /// 附件数组的 JSON 原文，无附件为 `None`
    pub attachments: Option<String>,
    /// 消息片段（按 `seq` 升序）
    pub items: Vec<StoredItem>,
}

/// 一个会话（含全部消息与片段）
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConversation {
    /// 会话 id
    pub id: String,
    /// 会话标题
    pub title: String,
    /// 所属项目 id
    pub project_id: String,
    /// 本会话附加上下文数组的 JSON 原文（会话级：只在所属会话内有效）
    pub context_entries: String,
    /// 本会话检索到的来源数组的 JSON 原文（会话级：只在所属会话内有效）
    pub sources: String,
    /// 是否归档
    pub archived: bool,
    /// 展示用的更新时间文案
    pub updated_at_label: String,
    /// 执行上下文：local / worktree
    pub execution_context: String,
    /// 会话自带的工作目录：独立会话由用户挑选，项目下的任务为空（走项目目录）
    pub workspace_path: Option<String>,
    /// 绑定的 worktree 路径
    pub worktree_path: Option<String>,
    /// 绑定的任务分支
    pub branch: Option<String>,
    /// 审阅评论数组 JSON
    pub review_comments: String,
    /// 绑定的 Agent id：NULL 表示普通会话（开发者 Jan）
    pub agent_id: Option<String>,
    /// 父会话 id：仅 `run_subagent` 派生的子会话有值（开发者 Jan）
    pub parent_thread_id: Option<String>,
    /// 会话早段内容的滚动摘要：上下文自动压缩的产物，空串表示未压缩过（开发者 Jan）
    pub context_summary: String,
    /// 摘要已覆盖的消息条数：重建上下文时跳过前 N 条原文（开发者 Jan）
    pub context_covered_count: i64,
    /// 创建时间（Unix 秒）
    pub created_at: i64,
    /// 更新时间（Unix 秒）
    pub updated_at: i64,
    /// 会话消息列表
    pub messages: Vec<StoredMessage>,
}

/// 会话库信息
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDbInfo {
    /// 库文件绝对路径
    pub path: String,
    /// 本次调用是否新建了库文件
    pub created: bool,
    /// 库中会话数量
    pub conversations: usize,
    pub legacy_migrated: bool,
}

/// 一次模型运行的 token 用量。
///
/// 由前端在流式响应里读到服务端回传的 `usage` 后写入，同一次运行重复写入按 `id` 覆盖，
/// 因此中断重试或多轮工具调用只会计一次，不会重复累计。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    /// 运行 id（同一次运行重复写入时覆盖旧值）
    pub id: String,
    /// 运行所属会话 id
    pub conversation_id: String,
    /// 运行所属项目 id，未选择项目时为空串
    pub project_id: String,
    /// 实际使用的模型 id
    pub model: String,
    /// 计入的输入 token（含 system / 历史 / 工具结果与图片）
    pub prompt_tokens: i64,
    /// 生成的输出 token
    pub completion_tokens: i64,
    /// 输出 token 中的思考 token（已包含在 completion 内）
    pub reasoning_tokens: i64,
    /// 服务端给出的总 token
    pub total_tokens: i64,
    /// 运行开始时间（Unix 秒）
    pub created_at: i64,
}

/// 一段作用域内的用量汇总（按会话、项目或全库过滤）
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// 计入的运行次数
    pub runs: i64,
    /// 输入 token 合计
    pub prompt_tokens: i64,
    /// 输出 token 合计
    pub completion_tokens: i64,
    /// 思考 token 合计
    pub reasoning_tokens: i64,
    /// 总 token 合计
    pub total_tokens: i64,
    /// 最近一次运行时间（Unix 秒），无记录为 `None`
    pub last_at: Option<i64>,
}
