//! 配置模型定义。
//!
//! 所有结构体都带 `#[serde(default)]`，因此任意层级的配置文件都可以只写想覆盖的字段；
//! 未写出的字段由默认值补齐。`deny_unknown_fields` 保证拼写错误会被 `ots config validate` 抓到。

use std::collections::BTreeMap;
use std::path::PathBuf;

use ots_core::{PermissionMode, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 顶层配置。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OtsConfig {
    /// 模型接入。
    pub llm: LlmConfig,
    /// Agent 循环。
    pub agent: AgentConfig,
    /// 工具。
    pub tools: ToolsConfig,
    /// 技能。
    pub skills: SkillsConfig,
    /// 审批。
    pub approval: ApprovalConfig,
    /// 沙箱。
    pub sandbox: SandboxConfig,
    /// 日志与审计。
    pub logging: LoggingConfig,
    /// 项目相关。
    pub project: ProjectConfig,
}

/// 模型接入配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LlmConfig {
    /// provider 标识（当前仅 `openai-compatible`）。
    pub provider: String,
    /// API 基础地址（不含 `/chat/completions`）。
    pub base_url: String,
    /// 模型名。
    pub model: String,
    /// 从哪个环境变量读取 API Key。
    pub api_key_env: String,
    /// 直接写入的 API Key（不推荐，优先级高于环境变量）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 组织标识，填则会发送 `OpenAI-Organization`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    /// 采样温度。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// 最大输出 token。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// 单次请求超时（秒）。
    pub timeout_secs: u64,
    /// 是否使用流式响应。
    pub stream: bool,
    /// 失败重试次数。
    pub max_retries: u32,
    /// 额外请求头。
    pub extra_headers: BTreeMap<String, String>,
    /// 额外请求体字段（透传给服务端，如 `top_p`）。
    pub extra_body: BTreeMap<String, Value>,
}

impl Default for LlmConfig {
    /// 模型接口默认值（开发者 Jan）。
    ///
    /// 默认指向 OpenAI 兼容端点与 600 秒超时，并开启流式与 3 次重试；
    /// model 留空是有意的——模型名必须由使用者显式指定，猜一个默认模型只会在运行时才暴露问题。
    fn default() -> Self {
        Self {
            provider: "openai-compatible".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: String::new(),
            api_key_env: "OPENAI_API_KEY".to_string(),
            api_key: None,
            organization: None,
            temperature: None,
            max_tokens: None,
            timeout_secs: 600,
            stream: true,
            max_retries: 3,
            extra_headers: BTreeMap::new(),
            extra_body: BTreeMap::new(),
        }
    }
}

/// Agent 循环配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AgentConfig {
    /// 最大迭代轮数。
    pub max_iterations: u32,
    /// 质量阈值（0~1）。
    pub quality_threshold: f64,
    /// 验证通过即终止。
    pub stop_on_verification_pass: bool,
    /// 总时长预算（秒），`null` 表示不限制。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_duration_secs: Option<u64>,
    /// 累计 token 预算，`null` 表示不限制。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_total_tokens: Option<u64>,
    /// 连续无进展轮数上限，0 表示禁用。
    pub stall_patience: u32,
    /// 验证未通过时注入给模型的模板，占位符 `{iteration}` `{score}` `{summary}` `{details}`。
    pub continue_prompt: String,
    /// 追加到系统提示末尾的用户要求。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_extra: Option<String>,
    /// 需要读取并注入系统提示的项目指令文件（相对工作区）。
    pub instructions_files: Vec<String>,
    /// 工具并发上限。
    pub max_tool_concurrency: usize,
    /// 单次工具调用超时（秒）。
    pub tool_timeout_secs: u64,
    /// 验证方式。
    pub verifier: VerifierKind,
    /// 测试命令；`verifier = "test-command"` 时必填。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_command: Option<String>,
}

impl Default for AgentConfig {
    /// Agent 循环默认值（开发者 Jan），与桌面端 LoopPolicy 的默认档位对齐：8 轮 / 30 分钟 / token 不限。
    ///
    /// 默认带 30 分钟时长上限而不设 token 上限：时长能兜住「跑飞了」的情况，
    /// 而 token 上限在长任务里很容易误伤，留给使用者按需收紧。
    /// stall_patience 默认 2，表示连续两轮没有进展就注入继续提示。
    fn default() -> Self {
        Self {
            max_iterations: 8,
            quality_threshold: 0.9,
            stop_on_verification_pass: true,
            max_duration_secs: Some(1800),
            max_total_tokens: None,
            stall_patience: 2,
            continue_prompt: ots_core::looping::DEFAULT_CONTINUE_PROMPT.to_string(),
            system_prompt_extra: None,
            instructions_files: vec!["AGENTS.md".to_string()],
            max_tool_concurrency: 4,
            tool_timeout_secs: 120,
            verifier: VerifierKind::TestCommand,
            test_command: None,
        }
    }
}

/// 验证方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerifierKind {
    /// 执行配置的测试命令，按退出码与输出判定。
    TestCommand,
    /// 不做客观验证（模型停止调用工具即视为完成）。
    None,
}

/// 工具配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ToolsConfig {
    /// 白名单：非空时只启用列出的工具。
    pub enabled: Vec<String>,
    /// 黑名单：优先级高于白名单。
    pub disabled: Vec<String>,
    /// 工具输出截断阈值（字节）。
    pub max_output_bytes: usize,
    /// 传给子进程的环境变量白名单。
    pub env_allowlist: Vec<String>,
    /// 通过配置注册的外部工具。
    pub external: Vec<ExternalToolConfig>,
}

impl Default for ToolsConfig {
    /// 工具配置默认值（开发者 Jan）：默认启用全部工具，仅保留一份够用的环境变量白名单。
    ///
    /// 白名单刻意只放 PATH / HOME / LANG 这类运行必需品，不整份继承父进程环境，
    /// 避免把密钥、令牌之类的变量顺手透传给模型可调用的子进程。
    fn default() -> Self {
        Self {
            enabled: Vec::new(),
            disabled: Vec::new(),
            max_output_bytes: 65_536,
            env_allowlist: vec![
                "PATH".to_string(),
                "HOME".to_string(),
                "LANG".to_string(),
                "LC_ALL".to_string(),
                "TMPDIR".to_string(),
                "TERM".to_string(),
                "USER".to_string(),
                "SHELL".to_string(),
            ],
            external: Vec::new(),
        }
    }
}

/// 技能配置。
///
/// 技能以 `<技能根>/<目录名>/SKILL.md` 组织，`SKILL.md` 由 YAML 前置区（`---`）与正文组成。
/// 搜索顺序（后者覆盖前者）：用户级 → 项目级 → `paths[]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SkillsConfig {
    /// 是否启用技能；关闭后既不扫描目录也不注册 `use_skill`。
    pub enabled: bool,
    /// 黑名单：列出的技能一律不加载。
    pub disabled: Vec<String>,
    /// 额外的技能根目录（相对工作区或绝对路径），优先级最高。
    pub paths: Vec<PathBuf>,
    /// 单个技能正文的最大字节数，超出部分截断。
    pub max_body_bytes: usize,
}

impl Default for SkillsConfig {
    /// 技能配置默认值（开发者 Jan）：默认开启，单份技能正文上限 32 KiB。
    ///
    /// 限长是因为技能正文会被注入上下文，一份超大技能足以挤掉真正的任务信息；
    /// 超出部分截断而非报错，让技能仍可被读到关键部分。
    fn default() -> Self {
        Self { enabled: true, disabled: Vec::new(), paths: Vec::new(), max_body_bytes: 32 * 1024 }
    }
}

/// 外部工具定义（`ots tools run <name>` / 模型可直接调用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalToolConfig {
    /// 工具名。
    pub name: String,
    /// 面向模型的描述。
    pub description: String,
    /// 可执行文件。
    pub command: String,
    /// 参数模板，元素中可使用 `{{参数名}}` 占位。
    #[serde(default)]
    pub args: Vec<String>,
    /// 参数 JSON Schema。
    #[serde(default = "default_external_parameters")]
    pub parameters: Value,
    /// 风险等级。
    #[serde(default = "default_risk")]
    pub risk: RiskLevel,
    /// 是否修改工作区。
    #[serde(default)]
    pub mutating: bool,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 超时（秒），为空时使用 `agent.tool_timeout_secs`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// 附加环境变量。
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// 外部工具参数的默认 JSON Schema（开发者 Jan）。
///
/// 默认给一个「接受任意对象」的空 schema：外部工具的参数形态千差万别，
/// 没写 schema 时按宽松处理，好过因为缺字段就拒绝加载整个配置。
fn default_external_parameters() -> Value {
    serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": true })
}

/// 外部工具的默认风险等级（开发者 Jan）：取 Medium，即需要审批但不属于高危
fn default_risk() -> RiskLevel {
    RiskLevel::Medium
}

/// 审批配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ApprovalConfig {
    /// 权限模式。
    pub mode: PermissionMode,
    /// 允许直接放行的路径 glob（相对工作区或绝对路径均可）。
    pub allow_paths: Vec<String>,
    /// 直接拒绝的路径 glob。
    pub deny_paths: Vec<String>,
    /// 允许直接放行的命令前缀。
    pub allow_commands: Vec<String>,
    /// 直接拒绝的命令前缀。
    pub deny_commands: Vec<String>,
    /// 是否允许执行「受限」级别操作（Critical）。
    pub allow_critical: bool,
    /// 强化确认需要原样输入的短语。
    pub elevated_phrase: String,
    /// 非交互模式下等待外部审批的时长（秒）。
    pub deferred_wait_secs: u64,
    /// 审批记录存储路径；默认 `<工作区>/.octopuses/approvals.jsonl`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_path: Option<PathBuf>,
}

impl Default for ApprovalConfig {
    /// 审批配置默认值（开发者 Jan）：默认 Auto 模式，配一组够用的路径与命令黑白名单。
    ///
    /// 默认拒绝项聚焦「一旦执行就不可逆」的操作：提权、关机、格式化、整盘删除等；
    /// allow_critical 默认关闭，elevated_phrase 给一句中文确认短语，
    /// 让高风险操作必须由人原样输入短语才能通过。
    /// deferred_wait_secs 默认 600 秒，是「落盘等另一个终端审批」的最长等待。
    fn default() -> Self {
        Self {
            mode: PermissionMode::Auto,
            allow_paths: vec![".octopuses/tmp/**".to_string()],
            deny_paths: vec![
                ".git/objects/**".to_string(),
                "**/*.pem".to_string(),
                "**/.env".to_string(),
            ],
            allow_commands: vec!["ls".to_string(), "cat".to_string(), "git status".to_string(), "git diff".to_string()],
            deny_commands: vec![
                "sudo".to_string(),
                "shutdown".to_string(),
                "reboot".to_string(),
                "mkfs".to_string(),
                "dd if=".to_string(),
                "rm -rf /".to_string(),
                "chmod -R 777 /".to_string(),
            ],
            allow_critical: false,
            elevated_phrase: "我确认执行".to_string(),
            deferred_wait_secs: 600,
            store_path: None,
        }
    }
}

/// 沙箱配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxConfig {
    /// 是否启用沙箱。
    pub enabled: bool,
    /// 沙箱后端。
    pub backend: SandboxBackend,
    /// 是否允许子进程访问网络。
    pub allow_network: bool,
    /// 额外可写路径（相对工作区或绝对路径）。
    pub writable_paths: Vec<String>,
    /// 额外可读路径（工作区之外）。
    pub readable_paths: Vec<String>,
    /// 额外可写的系统路径，例如 `/private/tmp`。
    pub writable_system_paths: Vec<String>,
    /// 追加到 Seatbelt profile 的原始规则。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seatbelt_profile_extra: Option<String>,
}

impl Default for SandboxConfig {
    /// 沙箱配置默认值（开发者 Jan）：默认开启逻辑沙箱、允许网络，并预置临时目录白名单。
    ///
    /// 默认后端取 Logical 而不是 Seatbelt：逻辑沙箱在所有平台一致可用，
    /// 内核级隔离需要显式开启，避免在未预期的环境里因 sandbox-exec 不可用而直接失败。
    /// /private/tmp 与 /tmp 是 macOS 与 Linux 上临时文件的两种写法，同时放行以免工具链报错。
    fn default() -> Self {
        Self {
            enabled: true,
            backend: SandboxBackend::Logical,
            allow_network: true,
            writable_paths: Vec::new(),
            readable_paths: Vec::new(),
            writable_system_paths: vec!["/private/tmp".to_string(), "/tmp".to_string()],
            seatbelt_profile_extra: None,
        }
    }
}

/// 沙箱后端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxBackend {
    /// 仅逻辑沙箱：路径规范化 + 越界拦截 + 环境变量白名单。
    Logical,
    /// 逻辑沙箱 + macOS `sandbox-exec`（Seatbelt）。
    Seatbelt,
    /// 不做任何限制（仅用于受控环境）。
    None,
}

/// 日志与审计配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LoggingConfig {
    /// 日志级别或 `tracing` 过滤器表达式。
    pub level: String,
    /// 输出格式。
    pub format: LogFormat,
    /// 是否显示单行进度。
    pub progress: bool,
    /// 审计 JSONL 落盘路径；默认 `<工作区>/.octopuses/audit.jsonl`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit_path: Option<PathBuf>,
}

impl Default for LoggingConfig {
    /// 日志配置默认值（开发者 Jan）：info 级、文本格式、显示进度条。
    ///
    /// 审计路径默认留空，由工作区推导出 .octopuses/audit.jsonl；
    /// 这样同一个工作区跑多次不会因为配置里写死绝对路径而把审计写到别处。
    fn default() -> Self {
        Self {
            level: "info".to_string(),
            format: LogFormat::Text,
            progress: true,
            audit_path: None,
        }
    }
}

/// 日志格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    /// 人类可读。
    Text,
    /// 结构化 JSON。
    Json,
}

/// 项目配置。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProjectConfig {
    /// 覆盖工作区根目录。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<PathBuf>,
}
