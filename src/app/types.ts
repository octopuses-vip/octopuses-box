/** 应用领域模型定义（纯界面层的展示数据） */

export type ToolKind =
  | "plan"
  | "exec_command"
  | "apply_patch"
  | "read_file"
  | "write_file"
  | "write_artifact"
  | "image_gen"
  | "video_gen"
  | "search_code"
  | "test_runner"
  | "web_search"
  | "knowledge_search"
  | "read_url"
  | "read_skill"
  | "mcp"
  | "browser"
  | "computer"
  | "vision"
  | "cv"
  | "ssh"
  | "subagent"
  | "ask_user";

export type ToolStatus = "running" | "success" | "error";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface SourceItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 用户附加的一条上下文。
 *
 * `label` 是用户输入的原始值：相对项目目录的路径（如 `src/app/store.ts`）或 `https://` 网址。
 * 运行前由 `src/context/attach.ts` 解析成文本注入请求，因此这里只保留「用户输入了什么」。
 */
export interface ContextEntry {
  id: string;
  label: string;
  kind: "file" | "folder" | "url";
}

/** 追问选项：标签用于提交，说明用于解释选择影响 */
export interface QuestionOption {
  label: string;
  description: string;
}

/** 需求确认追问：一次请求可包含 1-3 个问题 */
export interface ClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
}

/** 每题答案：选项标签 + 可选的 user_note */
export type QuestionAnswers = Record<string, string[]>;

/**
 * 一次运行结束的原因。
 *
 * 与 CLI 侧 `TerminationReason` 的成功语义对齐：只有 `completed`（模型自行收束）算成功；
 * 轮数 / 时长 / token 预算耗尽属于被上限截停，`error` 属于请求或执行出错，
 * 二者与 `userInterrupted` 一并记为非成功结果，并给出可读提示而不是静默结束。
 */
export type RunStopReason =
  | "completed"
  | "maxRounds"
  | "timeBudget"
  | "tokenBudget"
  | "userInterrupted"
  | "error";

/** 每轮回答的执行事实快照，随消息 payload 保存，不读取当前设置还原历史。 */
export interface ExecutionDetails {
  runId: string;
  agentId: string;
  agentName: string;
  selectedAgentId: string | null;
  requestedModel: string | null;
  actualModel: string | null;
  fallbackReason: string | null;
  projectId: string;
  outcome: "running" | "success" | "failed" | "aborted";
  stopReason?: RunStopReason;
  tools: { callId: string; name: string; status: "running" | "success" | "error" | "skipped"; reason?: string }[];
}

export type StreamItem =
  | { id: string; type: "execution_details"; details: ExecutionDetails }
  | { id: string; type: "reasoning"; text: string; done: boolean }
  | {
      id: string;
      type: "tool_call";
      kind: ToolKind;
      title: string;
      command: string | null;
      status: ToolStatus;
      /** 界面上展示的工具输出：过长时按展示需要截断 */
      output: string;
      durationMs: number | null;
      /**
       * 协议层还原字段（旧会话可能整体缺失）。
       *
       * 工具卡片本身只存展示信息，但跨轮次重建上下文时要发出合法的
       * `assistant(tool_calls)` + `role: "tool"` 配对，缺了这些字段就无法配对；
       * 缺字段的旧会话在 `buildHistory` 里被跳过，绝不发出畸形请求。
       */
      callId?: string;
      name?: string;
      arguments?: string;
      /** 工具结果的完整内容（`output` 只保留展示所需的一段） */
      result?: string;
      videoJobId?: string;
      plan?: { step: string; status: "pending" | "in_progress" | "completed" }[];
    }
  | {
      id: string;
      type: "notice";
      /** 提示语气：warn 用于「运行被上限截停」，info 用于一般说明 */
      tone: "warn" | "info";
      text: string;
    }
  | { id: string; type: "diff"; files: DiffFile[] }
  | { id: string; type: "sources"; items: SourceItem[] }
  | {
      id: string;
      type: "question";
      /** 一次追问里的 1-3 个问题 */
      questions: ClarificationQuestion[];
      /** 已提交的答案；未提交为 null */
      answers: QuestionAnswers | null;
    }
  | {
      id: string;
      type: "approval";
      command: string;
      reason: string;
      /** 命令的稳定模式：同类命令共享同一取值，用于撤销后的自动审批名单 */
      pattern: string;
      status: "pending" | "approved" | "denied" | "expired";
      /** 是否自动放行；旧会话反序列化时缺省视为 false */
      auto: boolean;
      /** 用户是否已撤销该次自动批准（撤销后同类命令不再自动通过） */
      revoked?: boolean;
      /** 卡片来自子代理时标注其标题：镜像到最外层会话时，用于区分是哪个子代理在等审批 */
      source?: string;
    }
  | {
      id: string;
      type: "checkpoint";
      checkpointId: string;
      workspacePath?: string;
      status: "ready" | "rollingBack" | "rolledBack" | "error";
      detail: string;
    }
  | { id: string; type: "text"; text: string; streaming: boolean }
  | {
      id: string;
      type: "usage";
      /** 该轮模型服务返回的模型 id */
      model: string;
      /** 本轮合计的 token 用量（含全部工具调用轮次） */
      usage: TokenUsage;
      /** 本轮请求轮数，用于说明多次工具往返回产生的累计 */
      rounds: number;
    };

/** 一段 token 用量（服务端口径） */
export interface TokenUsage {
  /** 输入 token（system + 历史 + 工具结果 + 图片） */
  promptTokens: number;
  /** 输出 token */
  completionTokens: number;
  /** 输出中的思考 token（已含在 completionTokens 内） */
  reasoningTokens: number;
  /** 服务端给出的总 token */
  totalTokens: number;
}

/** 一次运行的用量记录，落库到会话库的 `run_usage` 表 */
export interface UsageRecord extends TokenUsage {
  /** 运行 id，同一次运行重复写入按此覆盖 */
  id: string;
  conversationId: string;
  projectId: string;
  model: string;
  /** 运行开始时间（Unix 秒） */
  createdAt: number;
}

/** 一段作用域内的用量汇总（按会话 / 项目 / 全库） */
export interface UsageSummary extends TokenUsage {
  /** 计入的运行次数 */
  runs: number;
  /** 最近一次运行时间（Unix 秒），无记录为 null */
  lastAt: number | null;
}

/** 用户消息携带的附件：粘贴或拖拽进入，图片走多模态入参，文本文件内联为文本 */
export interface MessageAttachment {
  id: string;
  /** 文件名，剪贴板图片会给一个默认名 */
  name: string;
  /** MIME 类型 */
  mime: string;
  /** 字节数 */
  size: number;
  kind: "image" | "file";
  /** 图片的 data URL，非图片为 null */
  dataUrl: string | null;
  /** 文本文件的内容，图片与二进制文件为 null */
  text: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  items: StreamItem[];
  /** 仅用户消息可能有附件 */
  attachments?: MessageAttachment[];
  /** Alternate answers belong to the user turn; only the selected answer enters model context and exports. */
  answerVersions?: { id: string; messages: Message[] }[];
}

export type ExecutionContext = "local" | "worktree";

export interface ReviewComment {
  id: string;
  threadId: string;
  path: string;
  line: number;
  side: "old" | "new" | "context";
  context: string;
  text: string;
  resolved: boolean;
  createdAt: number;
}

/**
 * 命令执行权限档位（开发者 Jan）。
 *
 * 三档对应闸门（`src/approval/gate.ts`）三条互斥的分支，档位是**会话级**的：
 * 同一个「可以放开跑」的任务不该影响另一个需要逐步确认的任务。取值语义见
 * `src/approval/permission.ts` 的档位表。
 */
export type PermissionMode = "ask" | "auto-readonly" | "auto-all";

export interface Thread {
  id: string;
  title: string;
  /** 归属的项目 id；为空串表示独立会话——不挂任何项目，归入侧栏「会话记录」（见 [`STANDALONE_PROJECT_ID`]） */
  projectId: string;
  /**
   * 会话创建时间（Unix 秒），首次创建后不再变化。
   *
   * 独立会话的产物落在缓存区 `outputs/<日期>/` 下，这个日期就取创建日而不是「今天」——
   * 否则跨天再打开旧会话，右栏会指向一个新日期目录，看不到上次那批产物。
   */
  createdAt: number;
  updatedAtLabel: string;
  /**
   * 本会话的附加上下文：要注入模型的文件 / 目录 / 网址。
   *
   * 上下文是独立的临时上下文，只在所属会话内有效——挂在会话上而不是放在全局 store，
   * 切换会话看到的就是目标会话自己的附加项，互不串味。随会话一起落库（见 `cache/sessionDb.ts`），
   * 重启客户端后原样恢复。
   */
  contextEntries: ContextEntry[];
  /**
   * 本会话检索到的来源（`web_search` / `read_url` 的产出，供右栏「来源」tab 展示）。
   *
   * 与附加上下文同理：来源是会话级数据，挂在会话上而不是放在全局 store——切换会话看到的是
   * 目标会话自己检索到的结果，互不串味，并随会话一起落库（见 `cache/sessionDb.ts`），
   * 重启客户端后原样恢复。
   */
  sources: SourceItem[];
  executionContext: ExecutionContext;
  /**
   * 会话自带的工作目录（开发者 Jan）。
   *
   * 项目是多个任务共享的上下文与资源，其目录由项目统一决定；会话是独立临时的上下文，
   * 不挂项目时就没有目录可用——此时由用户给这条会话单独指定一个目录，工程工具（读写文件、
   * 搜索代码、执行命令）与 `AGENTS.md` 规则才有生效的根。项目下的任务恒用项目目录，
   * 会话级目录只在项目目录缺失时兜底（见 `effectiveWorkspacePath`）。
   */
  workspacePath: string | null;
  worktreePath: string | null;
  branch: string | null;
  /**
   * 本会话的命令执行权限档位（开发者 Jan）。
   *
   * 只存在内存里、不落库：它是**临时授权**而不是长期偏好——所有会话在每次启动时都回到
   * 默认档位，避免上次为了跑通某个任务放开的「全部自动」在重启后继续默默生效。
   * 切会话各自独立，新建会话取 [`DEFAULT_PERMISSION_MODE`]。
   */
  permissionMode: PermissionMode;
  reviewComments: ReviewComment[];
  /**
   * 本会话绑定的 Agent id（开发者 Jan）。
   *
   * 为 null 表示普通会话：模型、工具集、权限档都按会话自身设置走。绑定后，运行时会用 Agent
   * 声明的模型覆写、把 persona 追加进系统提示、并把工具集收敛到其白名单（见 `useAgentRun`）。
   * 随会话一起落库，重启后原样恢复。
   */
  agentId: string | null;
  /**
   * 父会话 id（开发者 Jan）。
   *
   * 仅 `run_subagent` 派生出的子会话会带该字段，用于把子任务的产出挂回父会话、限制派生深度，
   * 以及父会话中断时联动终止。普通会话为 null。
   */
  parentThreadId: string | null;
  /**
   * 会话早段内容的滚动摘要（开发者 Jan）。
   *
   * 上下文自动压缩的产物：会话过长时，最早若干条消息被归纳成这段摘要并注入系统提示，
   * 原文不再进入请求（见 `contextCoveredCount` 与 `context/compact.ts`）。空串表示尚未压缩过。
   * 随会话一起落库，重启后继续生效——压缩不能只活一次运行。
   */
  contextSummary: string;
  /**
   * 摘要已覆盖的消息条数（从会话首条算起，开发者 Jan）。
   *
   * 重建上下文时跳过前 N 条原文、改注入 `contextSummary`。压缩只增不减：后续再压缩时
   * N 继续变大、摘要滚动更新。0 表示没有压缩过。
   */
  contextCoveredCount: number;
}

export interface Project {
  folders?: string[];
  id: string;
  name: string;
  path: string;
  /**
   * 绑定的 MCP 服务 id 白名单（开发者 Jan）。
   *
   * **严格白名单**：空数组 = 本项目不使用任何 MCP；非空时本项目下的会话只挂载所选且已启用的
   * MCP 工具，且绑定不会启用一个全局停用的服务。独立会话（无项目归属）不受该字段约束，
   * 仍沿用全局启用集合。
   */
  mcpIds: string[];
  /**
   * 绑定的技能 id 白名单（开发者 Jan）；语义同 `mcpIds`，空 = 本项目不使用任何技能。
   */
  skillIds: string[];
  /**
   * 绑定的远程主机 id 白名单（开发者 Jan）；语义同 `mcpIds`，空 = 本项目不使用任何远程主机。
   *
   * 非空时本项目下的会话只挂载所选且已启用主机的 SSH 工具，系统提示里也只列出这些主机；
   * 模型点名一台未绑定的主机会在运行期被直接拒绝，连审批卡都不弹。
   */
  sshHostIds: string[];
  /**
   * 项目级提示词（开发者 Jan）。
   *
   * 作为一段系统说明注入本项目下所有会话，位置在项目规则（AGENTS.md）之后、Agent persona 之前；
   * 空串不注入。用于把「这个项目统一要遵守的约定」固化下来，而不必每次在会话里重复交代。
   */
  prompt: string;
}

/**
 * 新建 / 编辑项目时的入参（开发者 Jan）。
 *
 * `id` 由 store 生成，不在入参内；`mcpIds` / `skillIds` / `sshHostIds` / `prompt` 可缺省，缺省按空处理，
 * 即该项目不使用对应类别的任何资源（见 `Project` 各字段的严格白名单语义）。
 */
export interface ProjectInput {
  folders?: string[];
  name: string;
  path: string;
  mcpIds?: string[];
  skillIds?: string[];
  sshHostIds?: string[];
  prompt?: string;
}

/**
 * 右栏 tab。
 *
 * Review 仅在当前会话存在未解决评论时出现，「图片」仅在有图片产物时出现，
 * 「3D」仅在会话内有可预览的图纸（产物或 `imports/` 下的导入文件）时出现。
 */
export type RightTab = "files" | "web" | "media" | "model" | "diff" | "review" | "sources" | "pulls" | "tasks" | "browser";

export type NavKey =
  | "newchat"
  | "search"
  | "knowledge"
  | "mcp"
  | "ssh"
  | "automations"
  | "skills"
  | "agents"
  | "tools"
  | "projects"
  | "chats"
  | "settings";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  /** 是否支持图片输入，决定能否粘贴/拖拽图片 */
  supportsImages: boolean;
}

/**
 * 后台下发给当前登录用户的模型（`GET /api/client/models` 的元素）。
 *
 * 列表由服务端按「已授权 + 已启用」过滤并按 id 升序返回，客户端不做二次筛选，
 * 管理台取消勾选后模型会在下次拉取时自然消失。
 */
export interface RemoteModel {
  /** 模型 ID */
  id: number;
  /** 模型标识，作为调用时的模型名 */
  code: string;
  /** 模型展示名称 */
  name: string;
  /** 供应商，可能为空字符串 */
  provider: string;
  /** 接入地址（OpenAI 兼容协议的基础 URL） */
  baseUrl: string;
  /** 接入密钥，可能为空字符串 */
  apiKey: string;
  /** 模型描述，可能为空字符串 */
  description: string;
  /**
   * 该模型是否支持图片输入。
   *
   * 老版本后台不返回该字段，因此为「可选」：`undefined` 表示后台未声明，
   * 此时由用户在设置页的手动开关决定，判定入口见 `resolveSupportsImages`。
   */
  supportsImages?: boolean;
}

/**
 * 管理端（octopuses-server）接入地址。
 *
 * 客户端首次启动时由用户填写并随配置持久化，之后每次调用客户端接口都显式带上它；
 * 环境变量 `OCTOPUSES_HOST` / `OCTOPUSES_PORT` 只在首次配置时作为表单预填值。
 */
export interface Endpoint {
  /** 主机：可带 http(s)://，不含路径；内网默认 HTTP，公网默认 HTTPS */
  host: string;
  /** 端口：1-65535 的十进制数字串 */
  port: string;
}

/**
 * 模型列表的来源（开发者 Jan）。
 *
 * `remote` 是历史行为：配置管理端地址、登录后由 `/api/client/models` 下发。
 * `local` 表示不连管理端，模型列表改从缓存目录下的 `models.json` 读取，
 * 该文件与 `RemoteModel` 同构，用户可自行填写接入地址与密钥；
 * 此模式下不需要登录，也不检查客户端更新。
 *
 * 两者都不是新装用户的默认值——首次启动由「选择模型来源」页让用户自己挑，
 * store 里用 `ModelSource | null` 表达「还没选」，本类型只描述选完的取值。
 */
export type ModelSource = "remote" | "local";

/**
 * 一次「检查更新」的结果（`GET /api/client/version/check`）。
 *
 * 该接口免登录，客户端进入主界面后自动查询；服务端在一次响应里同时给出「有无更新」
 * 与最新版本的展示信息，界面直接据此渲染提示，无需再查一次版本详情。
 */
export interface UpdateCheckResult {
  /** 客户端上报的当前版本号，服务端原样回显 */
  currentVersion: string;
  /** 是否存在比当前版本更新的已启用版本 */
  hasUpdate: boolean;
  /** 最新版本号；无已启用版本时空字符串 */
  latestVersion: string;
  /** 更新说明，可能为空字符串 */
  description: string;
  /** 安装包字节数；无已启用版本时为 0 */
  fileSize: number;
  /** 是否强制更新：仅当确有更新且该版本被管理员标记为强制时为真 */
  forceUpdate: boolean;
  /** 安装包下载地址；无已启用版本时空字符串 */
  downloadUrl: string;
  /** 最新版本的发布时间，可能为空字符串 */
  publishedAt: string;
}

/**
 * 更新安装包的下载进度（Rust 侧 `update-download-progress` 事件的负载）。
 *
 * 安装包由客户端自身下载（不弹浏览器），下载中界面按此渲染进度条；
 * `total` 为 0 表示服务端未给出体积，此时只展示已下载量。
 */
export interface UpdateDownloadProgress {
  /** 已下载字节数 */
  downloaded: number;
  /** 安装包总字节数；未知时为 0 */
  total: number;
  /** 下载百分比（0-100）；总量未知时为 0 */
  percent: number;
}

/**
 * 一条 MCP（Model Context Protocol）服务配置。
 *
 * 配置落盘在缓存目录的 `mcp/servers.json`，声明如何启动一个本地 MCP 服务进程；
 * 启用的服务会列出其工具并包装成模型可调用的函数（工具名形如 `mcp_<服务id>__<工具名>`）。
 */
export interface McpServer {
  id: string;
  name: string;
  /** 启动命令（可执行文件路径或 PATH 中的命令名） */
  command: string;
  /** 启动参数，逐项传给进程，不经 shell 解析 */
  args: string[];
  /** 追加的环境变量，叠加在继承环境之上 */
  env: Record<string, string>;
  /** 是否启用；停用的服务不向模型暴露工具 */
  enabled: boolean;
}

/** 一个 MCP 工具（来自服务端 tools/list） */
export interface McpTool {
  name: string;
  description: string;
  /** 入参 JSON Schema，直接作为模型工具的 parameters */
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用结果：ok 为 false 时 output 是可读的失败原因 */
export interface McpCallResult {
  ok: boolean;
  output: string;
}

/**
 * 一条远程 Linux 主机配置。
 *
 * 非敏感字段落盘在缓存目录的 `ssh/hosts.json`；密码与私钥口令只存在系统凭据管理器里，
 * 任何情况下都不会出现在这个结构体中（`hasSecret` 只是「是否已保存凭据」的提示位）。
 */
export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 认证方式：私钥文件或密码 */
  auth: SshAuthKind;
  /** 私钥文件路径（auth 为 key 时必填），只存路径不存内容 */
  keyPath: string | null;
  /** 已信任的主机密钥 SHA256 指纹；为空表示尚未建立信任 */
  hostKeyFingerprint: string | null;
  enabled: boolean;
  /**
   * 该主机的「执行限制」提示词：模型每次对这台主机发起远程调用时回灌进上下文，
   * 用来限定哪些命令禁止执行（如生产机禁 `rm -rf`、禁改 systemd 单元）。
   * 为 null 表示未设置；它只是提示层，兜底仍是人工审批与 Rust 侧的静态拒绝清单。
   */
  guardPrompt: string | null;
  /** 系统凭据管理器中是否已保存该主机的凭据 */
  hasSecret: boolean;
}

export type SshAuthKind = "key" | "password";

/** 保存主机入参；secret 为空表示不修改已保存的凭据 */
export interface SshHostInput {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthKind;
  keyPath: string | null;
  secret: string | null;
  clearSecret: boolean;
  enabled: boolean;
  /** 执行限制提示词；空串或全空白表示清除该主机的限制 */
  guardPrompt: string | null;
  overwrite: boolean;
}

/** 凭据状态：本机凭据管理器是否可用 + 该主机是否已保存凭据 */
export interface SshSecretStatus {
  available: boolean;
  hasSecret: boolean;
}

/** 连接自检结果 */
export interface SshTestResult {
  ok: boolean;
  message: string;
  fingerprint: string | null;
}

/** 远程命令执行结果 */
export interface SshExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** 远程目录条目 */
export interface SshDirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

/** 远程文件内容 */
export interface SshFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * 一条自动化任务：按计划把提示词交给模型运行，也可以随时手动触发。
 *
 * 应用开着时由 Rust 进程内调度器到点触发；应用完全退出后由注册到系统的后台定时项（LaunchAgent）
 * 重新唤起本应用执行——两条路径共用同一条运行链路，且都复用任务的 `threadId` 对应的会话。
 */
export type AutomationKind = "agent" | "knowledge-index";

export interface Automation {
  id: string;
  name: string;
  /** 任务执行器：默认交给模型，也可由本地知识库索引器直接执行。 */
  kind?: AutomationKind;
  /** 任务提示词，触发时作为用户消息发给模型 */
  prompt: string;
  /** 运行归属的项目 id，决定新会话挂在哪个项目下 */
  projectId: string;
  /** 触发间隔（分钟）；0 表示只手动触发。`cron` 为空时按它推导计划 */
  intervalMinutes: number;
  /** 类 cron 表达式（分 时 日 月 周，5 段）；为空时按 `intervalMinutes` 推导 */
  cron: string | null;
  /** 任务创建时的本机时区标识，仅作记录；调度始终按本机时区计算 */
  timezone: string | null;
  /** 下次计划触发时间（毫秒）；暂无计划（手动触发或表达式无法排程）为 null */
  nextRunAt: number | null;
  /** 复用的会话 id：首轮运行创建后回写，之后每轮接在同一会话里，上下文连续且省 token */
  threadId: string | null;
  /**
   * 绑定运行的 Agent id（开发者 Jan）；null 表示用普通会话。
   *
   * 无人值守的任务最需要「工具集与权限档被显式收窄」，绑定 Agent 后运行时按它的白名单与档位上限执行。
   */
  agentId: string | null;
  enabled: boolean;
  /** 最近一次触发时间（毫秒），从未触发为 null */
  lastRunAt: number | null;
}

/**
 * 会话队列里的一条待执行请求（开发者 Jan）。
 *
 * 只承载展示所需的信息：事实源仍是 `useAgentRun` 里按会话分槽的运行队列，
 * 这里每次状态刷新时重新生成，界面据此把「一个会话排了哪几条对话」显示出来。
 */
export interface ThreadQueuedItem {
  /** 请求 id（运行队列内唯一，作列表 key） */
  id: string;
  /** 提问预览：压成单行并截断 */
  preview: string;
  /** 来源：用户提交或自动化触发 */
  source: "user" | "automation";
  /** 附件数量 */
  attachmentCount: number;
}

/** 某个会话当前的运行状态（不同会话可并行，各自独立） */
export interface ThreadRunState {
  status: "idle" | "queued" | "running";
  queuedCount: number;
  /** 排队内容（按入队顺序）：界面用它显示会话里排队的多条请求 */
  queuedItems: ThreadQueuedItem[];
  /** 本次运行开始时间（毫秒），未在运行为 null */
  startedAt: number | null;
}

export interface AutomationRun {
  id: string;
  /** 任务 id；任务被删除后记录仍可读 */
  automationId: string;
  /** 任务名快照 */
  name: string;
  /** 触发方式 */
  trigger: "manual" | "schedule";
  /** 入队时间（毫秒） */
  startedAt: number;
  status: "queued" | "running" | "success" | "failed" | "aborted";
  finishedAt: number | null;
  error: string | null;
  /** 运行所在的会话 id，可跳转查看 */
  threadId: string;
  /** 运行结束后模型给出的 1–3 条后续建议；无建议为空数组 */
  suggestions: AutomationSuggestion[];
}

/** 一条「接着做」的后续建议：标题用于展示，prompt 可直接作为新任务执行 */
export interface AutomationSuggestion {
  title: string;
  prompt: string;
}

/** 并行任务里某个项目的运行状态 */
export type ParallelItemStatus = "queued" | "running" | "success" | "failed" | "aborted";

/** 并行任务批次里的一个项目运行条目 */
export interface ParallelItem {
  /** 目标项目 id */
  projectId: string;
  /** 项目名快照：项目改名或删除后，历史批次仍能辨认当初发去了哪 */
  projectName: string;
  /** 该项目本次运行所在的会话 id，可跳转查看 */
  threadId: string;
  status: ParallelItemStatus;
  /** 失败原因，成功或未结束时为 null */
  error: string | null;
  /** 结束时间（Unix 毫秒），未结束为 null */
  finishedAt: number | null;
}

/**
 * 一个并行任务批次：把同一条提示词分发给多个项目，各自独立会话并行执行。
 *
 * 档案落盘在缓存目录 `parallel/batches.json`，重启后可回看「哪条任务发给了哪些项目、各自跑成什么样」。
 */
export interface ParallelBatch {
  id: string;
  /** 分发给各项目的任务提示词 */
  prompt: string;
  /** 创建时间（Unix 毫秒） */
  createdAt: number;
  items: ParallelItem[];
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  /** SKILL.md 全文，显式调用或模型读取时整篇注入上下文 */
  body: string;
  /** SKILL.md 的绝对路径，便于排查 */
  path: string;
  /** 技能目录内 SKILL.md 之外的参考文档（相对技能目录），用 read_skill 的 file 参数读取 */
  files: string[];
}

/** `read_skill` 工具的读取结果：ok 为 false 时 output 是可读的失败原因 */
export interface SkillReadResult {
  ok: boolean;
  output: string;
}

/**
 * 一个 Agent（子代理）的元信息（开发者 Jan）。
 *
 * Agent 统一放在缓存目录下的 `agents/<agentId>/AGENT.md`：frontmatter 是本结构的前五个字段，
 * 正文是 `systemAppend`。Agent 只描述「用什么模型、能碰哪些工具、最高放到哪一档权限、注入什么角色」，
 * 具体编排仍走既有的会话运行链路。
 */
export interface AgentItem {
  /** 目录名，作为唯一标识 */
  id: string;
  name: string;
  description: string;
  /** 指定模型 code；空串表示跟随会话当前模型 */
  model: string;
  /**
   * 工具白名单：类别键（`workspace` / `ssh` / `cv` / `vision` / `control` / `mcp`）
   * 或单个工具名，也可用 `*` 表示全量；空数组表示不限制（全量工具）。
   */
  tools: string[];
  /** 权限档上限：`ask` / `auto-readonly` / `auto-all`；空串表示不限制 */
  permissionMode: string;
  /** 注入系统提示的 persona 正文（AGENT.md 正文部分） */
  systemAppend: string;
  /** AGENT.md 的绝对路径，便于排查 */
  path: string;
}

/**
 * 产物种类：文本走文本预览、图片走 blob 预览、PDF 走内置阅读器、二进制只展示元信息。
 * 由文件扩展名派生（后端 `artifact_kind`），两端口径一致。
 */
export type ArtifactKind = "text" | "image" | "video" | "pdf" | "binary";

/** 产物目录下的一个产物文件（项目会话在项目 `output/`，独立会话在缓存 `outputs/<日期>/`） */
export interface ArtifactInfo {
  /** 产物文件名（不含路径，产物只平铺一层） */
  name: string;
  /** 字节数 */
  bytes: number;
  /** 最后写入时间（Unix 秒） */
  modifiedAt: number;
  /** 产物种类，决定预览方式 */
  kind: ArtifactKind;
}

/**
 * 工作区某个目录下的一项文件（后端 `workspace_list_dir` 的元素）。
 *
 * 与 [`ArtifactInfo`] 同形但少一个 `kind`：目录里可能是任何东西，
 * 种类由上层按扩展名自己判断（如「图纸」tab 只挑 STEP / IGES / DWG）。
 */
export interface DirEntryInfo {
  /** 文件名（不含路径） */
  name: string;
  bytes: number;
  /** 最后写入时间（Unix 秒） */
  modifiedAt: number;
}

export interface TerminalLine {
  kind: "cmd" | "out" | "err";
  text: string;
}

/** 后端持久 PTY 会话摘要 */
export interface PtySessionInfo {
  sessionId: string;
  cwd: string;
  shell: string;
}

/** 统一的 PTY 实时事件，使用 sessionId 区分并存会话 */
export interface PtyEvent {
  sessionId: string;
  kind: "output" | "exit" | "error";
  data: string | null;
  exitCode: number | null;
}

/** 集成终端中一条命令的执行结果 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  /** 进程退出码；被信号终止等场景为 null */
  exitCode: number | null;
  /** 是否因超时被强制终止 */
  timedOut: boolean;
}

/** 一次网页抓取的结果（对应 Rust 侧 `web_fetch` 的返回） */
export interface WebFetchResult {
  /** 跟随重定向后的最终地址 */
  url: string;
  /** HTTP 状态码；非 2xx 同样会正常返回，由调用方判断 */
  status: number;
  /** 已按响应字符集解码的响应体文本 */
  body: string;
  /** 原始 Content-Type */
  contentType: string;
  /** 是否因触达体积上限而被截断 */
  truncated: boolean;
}

/** 场景脚本：驱动一次模拟的 agent 运行 */
export type ScenarioEvent =
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      kind: ToolKind;
      title: string;
      command: string | null;
      output: string;
      durationMs: number;
    }
  | { type: "diff"; files: DiffFile[] }
  | { type: "sources"; items: SourceItem[] }
  | { type: "answer"; text: string };

export interface Scenario {
  id: string;
  events: ScenarioEvent[];
}
