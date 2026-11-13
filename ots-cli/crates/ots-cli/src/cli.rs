//! 命令行接口定义（clap derive）。
//!
//! 这里只描述「有哪些参数」，不做任何业务判断；参数到配置的映射集中在 [`crate::app`]，
//! 使帮助文本与生效行为始终由同一份定义推导出来。

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

/// ots-cli —— 在本地终端里工作的软件工程 Agent。
///
/// 它以「生成 → 执行 → 验证」循环驱动模型调用工具，并在执行前经过策略与人工审批，
/// 在沙箱中运行。配置文件优先级：内置默认 < 用户级 < 项目级 < `--config` < 环境变量 < 命令行。
#[derive(Debug, Parser)]
#[command(
    name = "ots",
    version = ots_core::VERSION,
    about = "基于「生成-执行-测试」循环的本地软件工程 Agent",
    long_about = None,
    propagate_version = true,
    max_term_width = 100
)]
pub struct Cli {
    /// 显式指定的配置文件（也可用环境变量 OTS_CONFIG）
    #[arg(short = 'c', long, global = true, value_name = "FILE", env = "OTS_CONFIG")]
    pub config: Option<PathBuf>,

    /// 工作区根目录，默认为当前目录
    #[arg(short = 'C', long, global = true, value_name = "DIR")]
    pub workspace: Option<PathBuf>,

    /// 覆盖模型名（llm.model）
    #[arg(short = 'm', long, global = true, value_name = "MODEL")]
    pub model: Option<String>,

    /// 覆盖日志级别（trace/debug/info/warn/error，或 tracing 过滤器表达式）
    #[arg(long, global = true, value_name = "LEVEL")]
    pub log_level: Option<String>,

    /// 日志与事件输出格式
    #[arg(long, global = true, value_enum, value_name = "FORMAT")]
    pub log_format: Option<LogFormatArg>,

    /// 以 JSON 输出（等价于 --log-format json）
    #[arg(long, global = true)]
    pub json: bool,

    /// 自动批准所有需要审批的操作（非交互场景，请确认风险后再使用）
    #[arg(short = 'y', long, global = true)]
    pub yes: bool,

    /// 覆盖权限模式（approval.mode）
    #[arg(long, global = true, value_enum, value_name = "MODE")]
    pub permission_mode: Option<PermissionModeArg>,

    /// 覆盖沙箱后端（sandbox.backend），none 表示关闭沙箱
    #[arg(long, global = true, value_enum, value_name = "BACKEND")]
    pub sandbox: Option<SandboxBackendArg>,

    /// 关闭单行进度显示
    #[arg(long, global = true)]
    pub no_progress: bool,

    /// 显示模型的推理（思维链）增量
    #[arg(long, global = true)]
    pub show_reasoning: bool,

    /// 关闭「按技能声明收窄可用工具」：技能正文照常加载，但不再限制模型可调用的工具
    #[arg(long, global = true)]
    pub no_skill_scope: bool,

    /// 跳过启动前的配置校验（不推荐）
    #[arg(long, global = true)]
    pub skip_validate: bool,

    /// 子命令
    #[command(subcommand)]
    pub command: Command,
}

/// 子命令。
#[derive(Debug, Subcommand)]
pub enum Command {
    /// 运行「生成-执行-测试」循环，直到达成终止条件
    Run(RunArgs),
    /// 只执行一轮：生成 + 工具调用，不进入验证循环
    Exec(ExecArgs),
    /// 查看与手动调用工具
    #[command(subcommand)]
    Tools(ToolsCommand),
    /// 查看技能
    #[command(subcommand)]
    Skills(SkillsCommand),
    /// 查看与处理人工审批
    #[command(subcommand)]
    Approvals(ApprovalsCommand),
    /// 查看沙箱配置与操作预览
    #[command(subcommand)]
    Sandbox(SandboxCommand),
    /// 管理配置文件
    #[command(subcommand)]
    Config(ConfigCommand),
}

/// `ots run` 参数。
#[derive(Debug, clap::Args)]
pub struct RunArgs {
    /// 任务目标描述（用引号包裹）
    #[arg(value_name = "GOAL")]
    pub goal: String,

    /// 最大迭代轮数
    #[arg(long, value_name = "N")]
    pub max_iterations: Option<u32>,

    /// 质量阈值（0~1，验证得分达到即终止）
    #[arg(long, value_name = "RATIO")]
    pub quality_threshold: Option<f64>,

    /// 总时长预算（秒，0 表示不限制）
    #[arg(long, value_name = "SECS")]
    pub max_duration: Option<u64>,

    /// 累计 token 预算（0 表示不限制）
    #[arg(long, value_name = "N")]
    pub max_total_tokens: Option<u64>,

    /// 连续无进展轮数上限（0 表示禁用该条件）
    #[arg(long, value_name = "N")]
    pub stall_patience: Option<u32>,

    /// 验证命令（agent.test_command）
    #[arg(long, value_name = "CMD")]
    pub test_command: Option<String>,

    /// 验证方式
    #[arg(long, value_enum, value_name = "KIND")]
    pub verifier: Option<VerifierArg>,

    /// 不做客观验证（等价于 --verifier none）
    #[arg(long)]
    pub no_verify: bool,

    /// 单次工具调用超时（秒）
    #[arg(long, value_name = "SECS")]
    pub tool_timeout: Option<u64>,

    /// 工具并发上限
    #[arg(long, value_name = "N")]
    pub tool_concurrency: Option<usize>,
}

/// `ots exec` 参数。
#[derive(Debug, clap::Args)]
pub struct ExecArgs {
    /// 任务目标描述（用引号包裹）
    #[arg(value_name = "GOAL")]
    pub goal: String,

    /// 单次工具调用超时（秒）
    #[arg(long, value_name = "SECS")]
    pub tool_timeout: Option<u64>,
}

/// `ots tools` 子命令。
#[derive(Debug, Subcommand)]
pub enum ToolsCommand {
    /// 列出全部可用工具
    List,
    /// 打印某个工具的参数 JSON Schema
    Schema {
        /// 工具名
        name: String,
    },
    /// 手动调用一个工具（同样经过策略与审批）
    Run {
        /// 工具名
        name: String,
        /// 调用参数（JSON）
        #[arg(long, value_name = "JSON", default_value = "{}")]
        args: String,
        /// 只计算影响、不产生副作用（需要工具支持预演）
        #[arg(long)]
        dry_run: bool,
    },
}

/// `ots skills` 子命令。
#[derive(Debug, Subcommand)]
pub enum SkillsCommand {
    /// 列出已装载的技能（名称、来源、工具范围、说明）
    List,
    /// 查看某个技能的元数据与正文
    Show {
        /// 技能名
        name: String,
    },
}

/// `ots approvals` 子命令。
#[derive(Debug, Subcommand)]
pub enum ApprovalsCommand {
    /// 列出审批记录
    List {
        /// 只列出仍在等待决策的请求
        #[arg(long)]
        pending: bool,
    },
    /// 查看单个审批请求
    Show {
        /// 请求 id
        id: String,
    },
    /// 批准一个请求
    Approve {
        /// 请求 id
        id: String,
        /// 备注
        #[arg(long)]
        note: Option<String>,
    },
    /// 拒绝一个请求
    Deny {
        /// 请求 id
        id: String,
        /// 备注
        #[arg(long)]
        note: Option<String>,
    },
}

/// `ots sandbox` 子命令。
#[derive(Debug, Subcommand)]
pub enum SandboxCommand {
    /// 预览一次工具调用的影响范围（不执行、不落盘）
    Preview {
        /// 工具名
        tool: String,
        /// 调用参数（JSON）
        #[arg(long, value_name = "JSON", default_value = "{}")]
        args: String,
    },
    /// 打印当前生效的 Seatbelt profile（macOS）
    Profile,
    /// 检查一条命令或一个路径是否会被沙箱拦截
    Check {
        /// 待检查的 shell 命令
        #[arg(long, value_name = "CMD")]
        command: Option<String>,
        /// 待检查的路径
        #[arg(long, value_name = "PATH")]
        path: Option<PathBuf>,
        /// 路径访问方式
        #[arg(long, value_enum, default_value = "write")]
        access: AccessArg,
    },
}

/// `ots config` 子命令。
#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// 生成配置文件（写入当前生效配置，保证初始化后行为不变）
    Init {
        /// 写入用户级配置（`dirs::config_dir()` 下，macOS 为 `~/Library/Application Support/octopuses/config.toml`）而不是项目级
        #[arg(long)]
        user: bool,
        /// 覆盖已存在的文件
        #[arg(long)]
        force: bool,
    },
    /// 展示合并后的生效配置与来源
    Show,
    /// 校验配置
    Validate,
    /// 打印各级配置文件路径
    Path,
}

/// 日志格式取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum LogFormatArg {
    /// 人类可读
    Text,
    /// 结构化 JSON
    Json,
}

/// 权限模式取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum PermissionModeArg {
    /// 只读：拒绝一切写操作
    ReadOnly,
    /// 自动：低风险放行，其余进入审批
    Auto,
    /// 完全放行：跳过审批（仍受沙箱硬性规则约束）
    FullAccess,
}

/// 沙箱后端取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SandboxBackendArg {
    /// 逻辑沙箱
    Logical,
    /// 逻辑沙箱 + macOS Seatbelt
    Seatbelt,
    /// 关闭沙箱
    None,
}

/// 验证方式取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum VerifierArg {
    /// 执行配置的测试命令
    TestCommand,
    /// 不做客观验证
    None,
}

/// 路径访问方式取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AccessArg {
    /// 读取
    Read,
    /// 写入
    Write,
}

impl LogFormatArg {
    /// 映射为配置层类型。
    pub fn to_config(self) -> ots_config::LogFormat {
        match self {
            Self::Text => ots_config::LogFormat::Text,
            Self::Json => ots_config::LogFormat::Json,
        }
    }
}

impl PermissionModeArg {
    /// 映射为配置可接受的字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::Auto => "auto",
            Self::FullAccess => "full-access",
        }
    }
}

impl SandboxBackendArg {
    /// 映射为配置可接受的字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Logical => "logical",
            Self::Seatbelt => "seatbelt",
            Self::None => "none",
        }
    }
}

impl VerifierArg {
    /// 映射为配置可接受的字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TestCommand => "test-command",
            Self::None => "none",
        }
    }
}

impl AccessArg {
    /// 映射为守卫层的访问意图。
    pub fn to_access(self) -> ots_core::Access {
        match self {
            Self::Read => ots_core::Access::Read,
            Self::Write => ots_core::Access::Write,
        }
    }
}
