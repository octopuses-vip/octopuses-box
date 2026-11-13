/** Store 对外类型契约（开发者 Jan）。 */
import type {
  AgentItem,
  ArtifactInfo,
  Automation,
  AutomationRun,
  DiffFile,
  DirEntryInfo,
  Endpoint,
  McpServer,
  McpTool,
  Message,
  MessageAttachment,
  ModelOption,
  ModelSource,
  NavKey,
  ParallelBatch,
  ParallelItem,
  PermissionMode,
  Project,
  ProjectInput,
  RemoteModel,
  ReviewComment,
  RightTab,
  SkillItem,
  SourceItem,
  SshHost,
  SshHostInput,
  StreamItem,
  Thread,
  ThreadRunState,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UsageRecord,
  UsageSummary,
} from "./types";
import type { AgentInput, AgentUpdateInput } from "./desktop/agents";
import type { FileLocation } from "./desktop/files";
import type { GitCommandResult, GitRepositoryInfo } from "./desktop/git";
import type { McpServerInput } from "./desktop/mcp";
import type { ModelConnection } from "./desktop/connectionTypes";
import type { Platform } from "./platform";
import type { SchemePreference, ThemeId } from "./theme";

export interface AppStore {
  /* ---------- 登录与缓存路径 ---------- */
  currentUser: string | null;
  /**
   * 登录令牌（`POST /api/client/login` 下发）。
   *
   * 后续所有需要鉴权的客户端接口都靠它，随登录态一起持久化，实现重启免登录。
   */
  authToken: string | null;
  /**
   * 管理端（octopuses-server）接入地址。
   *
   * 首次启动时由用户在「配置管理端地址」页填写并持久化；为 `null` 表示从未配置过，
   * 此时路由会先停在地址页。登出不会清除它——地址是机器级配置，不属于某次登录。
   */
  endpoint: Endpoint | null;
  /**
   * 写入管理端地址。
   *
   * 地址真正发生变化时会一并清空登录态：令牌是旧服务端签发的，换服务端后必然无效。
   */
  setEndpoint: (endpoint: Endpoint) => void;
  /** 系统产生的文件与临时内容的统一落盘目录，首次登录时配置 */
  cachePath: string | null;
  /**
   * 登录：成功返回 `{ ok: true }`，失败返回 `{ ok: false, error }` 并把服务端中文文案
   * 原样交给登录页展示（凭据错误、账号被禁用、连不上服务端各有各的文案）。
   * 不抛异常，避免调用方到处写 try/catch。
   */
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  setCachePath: (path: string) => void;
  clearCachePath: () => void;

  /* ---------- 客户端版本更新 ---------- */
  /**
   * 一次更新检查的结果：服务端给出的最新版本信息；尚未检查、或服务端没有已启用版本时为 null。
   *
   * 不持久化——版本随时可能更新，每次启动都重新查询一次才准确。
   */
  updateInfo: UpdateCheckResult | null;
  /** 更新检查的进行状态；`error` 表示这次没查成（如服务端不可达），界面据此静默跳过 */
  updateCheckStatus: "idle" | "checking" | "ready" | "error";
  /**
   * 检查客户端是否有新版本。
   *
   * 接口免登录，由主界面挂载时自动调用一次；自动调用失败只在状态里留痕而不打扰用户，
   * 避免网络波动在启动瞬间弹出与用户当前操作无关的错误提示。
   * 托盘菜单「检查更新」是用户主动发起（`manual`），无论有没有新版本都要回一句明确结果。
   */
  checkUpdate: (manual?: boolean) => Promise<void>;
  /**
   * 手动检查更新的结果提示（「已是最新版本」/「检查失败」）。
   *
   * 只服务于托盘菜单这类用户主动触发的检查：查到新版本走更新弹窗，
   * 没有新版本时若什么都不显示，用户会以为菜单点了没反应。自动检查始终留空，不打扰。
   */
  updateCheckNotice: string | null;
  /** 关掉手动检查的结果提示（提示条自动消失时调用） */
  clearUpdateCheckNotice: () => void;
  /** 用户选择「稍后再说」后关掉本次更新提示；强制更新时界面不提供该入口 */
  updatePromptDismissed: boolean;
  dismissUpdatePrompt: () => void;
  /**
   * 应用内更新的执行状态：`downloading` 下载安装包中、`installing` 已交给更新进程
   * （客户端即将退出，由子进程完成安装与重启）、`error` 失败可重试。
   */
  updateInstallStatus: "idle" | "downloading" | "installing" | "error";
  /** 安装包下载进度；未开始下载时为 null */
  updateDownloadProgress: UpdateDownloadProgress | null;
  /** 更新失败的提示文案，成功后清空 */
  updateInstallError: string | null;
  /**
   * 触发更新：Windows 下由客户端自行下载安装包并交给独立进程完成安装（不弹浏览器），
   * 其余平台暂未内置更新器，退回用浏览器打开下载地址手动安装。
   */
  installUpdate: () => Promise<void>;
  /**
   * 读回上一次更新的结论并在界面上说明（开发者 Jan）。
   *
   * 更新期间客户端已经退出，安装成败只能事后读取：成功的静默略过（客户端已经带着新版本起来了），
   * 失败的给出原因与日志路径，免得用户以为「更新过了但版本没变」。
   */
  consumeUpdateOutcome: () => Promise<void>;

  /** 自动放行 Rust 后端识别出的只读或验证命令；危险命令始终拒绝 */
  trustReadOnlyCommands: boolean;
  setTrustReadOnlyCommands: (value: boolean) => void;
  /** 对模型触发的命令启用 macOS 内核级写隔离（写入只允许工作区与工具链白名单目录） */
  sandboxEnabled: boolean;
  setSandboxEnabled: (value: boolean) => void;
  /** 内核沙箱下是否允许命令访问网络；关掉会打断装包与联网检索 */
  sandboxAllowNetwork: boolean;
  setSandboxAllowNetwork: (value: boolean) => void;
  /** 用户撤销过的命令模式：命中后同类命令不再自动批准 */
  autoApprovalDenylist: string[];
  addAutoApprovalDenylist: (pattern: string) => void;
  clearAutoApprovalDenylist: () => void;

  /* ---------- 单次运行的上限 ---------- */
  /**
   * 单次运行允许的最大工具调用轮数。
   *
   * 与 CLI 的 `LoopPolicy.max_iterations` 同构：达到上限后不再向模型挂工具，强制它给出结论，
   * 并把这次运行记为「达到轮数上限」的非成功结果，而不是静默当作成功结束。
   * **0 表示不限**：不进入强制结论轮，模型想调多少轮工具就调多少轮。
   */
  maxToolRounds: number;
  setMaxToolRounds: (value: number) => void;
  /**
   * 单次运行的总时长预算（秒），与 CLI 的 `max_duration_secs` 同构。
   *
   * **0 表示不限**；轮数与时长同时不限时，本次运行没有任何自动停止条件，只能手动停止。
   */
  maxRunDurationSecs: number;
  setMaxRunDurationSecs: (value: number) => void;
  /** 单次运行的累计 token 预算；`null` 表示不限（与 CLI 的 `max_total_tokens` 同构） */
  maxRunTokens: number | null;
  setMaxRunTokens: (value: number | null) => void;

  /* ---------- 上下文自动压缩 ---------- */
  /**
   * 会话上下文自动压缩的阈值（估算 token）。
   *
   * 每次发起模型请求前估算整段上下文，超过该阈值就把最旧的若干条消息折叠进一段滚动摘要，
   * 让请求体积稳定停在阈值附近，而不是撑爆模型的上下文窗口。
   * **0 表示关闭**：不做任何估算与折叠，上下文一路涨到模型报错为止。
   */
  contextCompactThresholdTokens: number;
  setContextCompactThresholdTokens: (value: number) => void;

  /* ---------- 模型请求自动重试 ---------- */
  /**
   * 模型请求失败后的自动重试次数（开发者 Jan）。
   *
   * 0 表示关闭重试（失败立即停止任务）；默认 3 次。指数退避的重试只针对网络与
   * 服务端瞬时故障，用户主动停止不参与重试。
   */
  modelRetryCount: number;
  /** 知识库上传单文件上限，单位 MB，独立于会话附件。 */
  knowledgeFileLimitMb: number;
  setKnowledgeFileLimitMb: (value: number) => void;
  setModelRetryCount: (value: number) => void;

  /* ---------- 模型调用转储 ---------- */
  /**
   * 是否把每次模型调用的请求体与原始响应写进缓存目录（开发者 Jan）。
   *
   * 默认关闭：转储只为排查「发给模型什么 / 模型回了什么」而存在，日常对话没有理由付出
   * 写盘开销，也没有理由把上下文留在磁盘上。开启后按运行分文件写入
   * `logs/model-trace/`，可在设置页关掉。
   */
  modelTraceEnabled: boolean;
  setModelTraceEnabled: (enabled: boolean) => void;

  /* ---------- 项目 ---------- */
  /**
   * 项目列表（用户数据，持久化在本机）。
   *
   * 首次使用为空，项目由用户自己添加：一个项目对应本机的一个真实目录（也可先留空稍后补），
   * 之后差异读取、附加上下文、终端都以「当前项目」的目录为工作目录，
   * 该项目下的所有任务共享这份工作区与其中的项目规则。
   */
  projects: Project[];
  addProject: (input: ProjectInput) => string;
  updateProject: (id: string, patch: Partial<Omit<Project, "id">>) => void;
  /** 删除项目并一并删除其下的任务（内存侧；会话库记录由 useCacheSync 同步清理） */
  removeProject: (id: string) => void;
  /**
   * 项目创建 / 编辑弹窗状态（开发者 Jan）。
   *
   * 集中一处开关，侧栏 / 引导页的「新增」「编辑」按钮都调 `openProjectDialog`，
   * 弹窗本体只在 AppShell 挂载一次。`projectDialogEditId` 为 null 表示新建，非空表示编辑该项目。
   */
  projectDialogOpen: boolean;
  projectDialogEditId: string | null;
  openProjectDialog: (editId?: string | null) => void;
  closeProjectDialog: () => void;

  /* ---------- 会话 ---------- */
  threads: Thread[];
  activeThreadId: string;
  messages: Record<string, Message[]>;
  /** 每个会话独立的运行状态：交错会话可并行，同一会话仍串行 */
  threadRunStates: Record<string, ThreadRunState>;
  setThreadRunState: (threadId: string, state: ThreadRunState) => void;
  /** 是否已从缓存目录读回过会话（读回前不允许落盘，避免用初始会话覆盖磁盘记录） */
  sessionsRestored: boolean;
  sessionsRestoring: boolean;
  sessionLoadErrors: Record<string, string | undefined>;
  sessionNotices: Record<string, string | undefined>;
  ensureThreadLoaded: (id: string) => Promise<void>;
  /** 恢复失败时保留已有知识库资料，禁止拿未恢复的空列表清理索引。 */
  sessionsRestoreError: string | null;
  restoreSessions: () => Promise<void>;
  openThread: (id: string) => void;
  /**
   * 新建会话：会话是独立临时的上下文，不挂在任何项目下，因此没有项目也能用；
   * 建好后归入侧栏的「会话记录」。
   */
  newChat: () => void;
  /** 在指定项目下新建任务：任务是该项目的会话，共享项目目录与其中的项目规则 */
  newTaskInProject: (projectId: string) => void;
  /**
   * 新建一个空会话并返回其 id；focus 为 false 时不切换当前界面（供后台调度使用）。
   *
   * `agentId` 指定绑定的 Agent（新建会话选择器与自动化任务用）；`parentThreadId` 仅在
   * `run_subagent` 派生子会话时传入，用于限制派生深度与联动中断。
   */
  createThread: (
    title: string,
    projectId: string,
    focus: boolean,
    agentId?: string | null,
    parentThreadId?: string | null,
    /** 显式指定起始权限档位；只有子代理派生会传（取父会话的有效档位），其余一律走默认档位 */
    permissionMode?: PermissionMode | null,
  ) => string;
  startAssistantReply: (
    threadId: string,
    prompt: string,
    attachments: MessageAttachment[],
    regenerateFrom?: string,
  ) => string;
  patchItem: (
    threadId: string,
    messageId: string,
    itemId: string,
    updater: (item: StreamItem) => StreamItem,
  ) => void;
  /**
   * 回退到指定消息之前：删除该消息及其之后的全部消息。
   *
   * 供「重新生成」重新发起同一轮用——把该轮用户消息连同它之后的助手回复一起裁掉，
   * 随后以同一条用户消息重新运行，界面上就不会出现重复的提问。
   * 只裁内存侧，会话库记录由 useCacheSync 比对后同步清理。
   */
  rewindThreadTo: (threadId: string, messageId: string) => void;
  /** 重命名会话（空标题忽略，保持原标题） */
  renameThread: (id: string, title: string) => void;
  /** 删除会话及其消息；删除当前会话时切到同项目下最近的一条 */
  deleteThread: (id: string) => void;
  /**
   * 指定 / 更改 / 清除会话自带的工作目录（传 `null` 表示清除）。
   *
   * 独立会话没有项目也就没有工作目录，给一个目录后它才能读写文件、搜索代码、执行命令，
   * 并套用该目录的 `AGENTS.md`。项目下的任务不走这里——它们恒用项目目录（见
   * `effectiveWorkspacePath` 的优先级）。
   */
  setThreadWorkspace: (id: string, path: string | null) => void;
  /**
   * 设置**当前会话**的命令执行权限档位（开发者 Jan）。
   *
   * 档位挂在会话上而不是全局：一个任务放开到「全部自动」不该让另一个需要逐步确认的任务
   * 跟着失去拦截。作用对象是当前会话，与设置页的全局开关（只读白名单、沙箱）互不影响。
   */
  setThreadPermissionMode: (mode: PermissionMode) => void;
  /**
   * 设置**当前会话**绑定的 Agent（开发者 Jan）。
   *
   * 在输入区的 Agent 选择器里切换；传 null 即解绑，退回普通会话行为。只改当前会话，
   * 不影响项目下其他任务，也不改动自动化任务自身的绑定。
   */
  setThreadAgent: (agentId: string | null) => void;
  setThreadExecutionContext: (
    id: string,
    context: "local" | "worktree",
    worktreePath?: string | null,
    branch?: string | null,
  ) => void;
  /**
   * 写入会话的上下文压缩状态（滚动摘要 + 已覆盖的消息条数）。
   *
   * 由自动压缩流程调用：折叠完成后更新这两个字段，`buildHistory` 下次构建时就会跳过
   * 被摘要覆盖的前 N 条消息。替换 thread 对象会触发 useCacheSync 落盘，重启后压缩仍生效。
   */
  setThreadContextSummary: (threadId: string, summary: string, coveredCount: number) => void;
  createThreadWorktree: () => Promise<void>;
  removeThreadWorktree: (force: boolean) => Promise<void>;
  addReviewComment: (input: Omit<ReviewComment, "id" | "threadId" | "resolved" | "createdAt">) => void;
  resolveReviewComment: (id: string, resolved: boolean) => void;
  deleteReviewComment: (id: string) => void;

  /* ---------- 界面状态 ---------- */
  view: NavKey;
  activeProjectId: string;
  /** 当前平台；启动时先取 UA 推断值，随后由 `resolvePlatform()` 落定权威值（不持久化，每次重新探测） */
  platform: Platform;
  setPlatform: (platform: Platform) => void;
  rightPanelOpen: boolean;
  /**
   * 用户拖动分隔条后的右栏宽度（px）。
   *
   * `null` 表示从未手动调整过，宽度沿用 tokens.css 的 `--right-panel-width` 默认值——
   * 默认值因此只在一处定义，TS 侧不必再抄一份数字。
   */
  rightPanelWidth: number | null;
  /** 右栏是否最大化（吃掉中间栏）；纯界面状态，不持久化，重启即还原 */
  rightPanelMaximized: boolean;
  rightTab: RightTab;
  model: string;
  /** 可选模型列表，由后台下发的授权模型生成 */
  modelOptions: ModelOption[];
  /** 后台下发的授权模型原始列表（含 baseUrl / apiKey），仅保存在内存，每次登录重新获取 */
  remoteModels: RemoteModel[];
  /** 当前选中模型派生出的连接信息，仅保存在内存，每次登录重新获取 */
  modelConfig: ModelConnection | null;
  /**
   * 是否允许向模型输入图片（本地手动开关）。
   *
   * 仅在后台未下发 `supports_images` 时参与判定；后台下发时以接口值为准，
   * 本开关只作展示。判定统一走 `resolveSupportsImages`。
   */
  imageInputEnabled: boolean;
  /** 切换「允许图片输入」开关，并立刻重算模型选项与当前连接 */
  setImageInputEnabled: (enabled: boolean) => void;
  /**
   * 配色主题。
   *
   * 与 `imageInputEnabled` 同属设备级偏好：描述的是「这台机器上的观感」，
   * 不属于任何一次登录，因此登出与切换管理端地址都不重置它。
   */
  themeId: ThemeId;
  /** 明暗偏好：跟随系统 / 浅色 / 深色 */
  themeScheme: SchemePreference;
  /** 切换配色主题（开发者 Jan） */
  setThemeId: (id: ThemeId) => void;
  /** 切换明暗偏好（开发者 Jan） */
  setThemeScheme: (preference: SchemePreference) => void;
  modelConfigStatus: LoadStatus;
  modelConfigError: string | null;
  loadModelConfig: () => Promise<void>;
  /**
   * 模型列表来源：远程管理端下发，或读本机缓存目录下的 `models.json`。
   *
   * 属于设备级偏好（跟机器走，不跟登录走），因此登出与切换管理端地址都不重置它。
   * `null` 表示**用户还没选过**（全新安装），路由据此先停在「选择模型来源」页；
   * 老版本升级时补的是 `"remote"` 而不是 `null`，避免升级后被要求重新选择。
   */
  modelSource: ModelSource | null;
  /**
   * 切换模型来源。
   *
   * 两条源的模型列表互不相干，切换时必须清空已加载的列表与派生连接，
   * 让状态回到 `idle` 由界面重新加载；登录态本身不动，切回远程时不必重新登录。
   */
  setModelSource: (source: ModelSource) => void;
  /**
   * 校验并保存本地模型 JSON，返回校验错误列表（空数组表示成功）。
   *
   * 保存成功后立刻重新加载模型列表，用户不必再点一次「重新读取」。
   */
  saveLocalModels: (raw: string) => Promise<string[]>;
  /** 读取本地模型 JSON 原文；文件不存在返回 null，由设置页预填模板 */
  readLocalModelsText: () => Promise<string | null>;
  effort: number;
  terminalOpen: boolean;
  commandPaletteOpen: boolean;
  diffFiles: DiffFile[];
  /** 项目差异的读取状态与失败原因（差异来自项目目录上真实执行的 git diff） */
  gitDiffStatus: LoadStatus;
  gitDiffError: string | null;
  gitInfo: GitRepositoryInfo | null;
  gitStatus: LoadStatus;
  gitActionResult: GitCommandResult | null;
  gitActionError: string | null;
  loadGitDiff: () => Promise<void>;
  refreshGit: () => Promise<void>;
  stageChanges: (path?: string) => Promise<void>;
  unstageChanges: (path?: string) => Promise<void>;
  commitChanges: (message: string) => Promise<void>;
  pushChanges: () => Promise<void>;
  setView: (view: NavKey) => void;
  setActiveProject: (id: string) => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  /** 写入右栏宽度；传 `null` 表示回到默认宽度 */
  setRightPanelWidth: (width: number | null) => void;
  setRightPanelMaximized: (maximized: boolean) => void;
  setRightTab: (tab: RightTab) => void;
  setModel: (model: string) => void;
  setEffort: (effort: number) => void;
  toggleTerminal: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  /**
   * 把一次检索到的来源并入指定会话（开发者 Jan）。
   *
   * 来源是会话级数据（见 `Thread.sources`），因此按传入的 `threadId` 写入对应会话，
   * 而不是写到「当前会话」上——后台会话（定时任务）检索到的来源也要正确记进它自己那条对话。
   */
  mergeSources: (threadId: string, items: SourceItem[]) => void;

  /* ---------- 附加上下文（会话级） ---------- */
  /**
   * 给当前会话追加一条附加上下文。
   *
   * 上下文只在其所属会话内有效，因此始终写到 `activeThreadId` 指向的那条会话上；
   * 当前没有选中会话（如启动空态）时忽略，避免写出一条无人引用的附加项。
   */
  addContextEntry: (label: string) => void;
  /** 从当前会话移除一条附加上下文 */
  removeContextEntry: (id: string) => void;
  /** 清空当前会话的附加上下文 */
  clearContextEntries: () => void;

  /* ---------- 技能 ---------- */
  /** 扫描到的技能（含已停用的） */
  skills: SkillItem[];
  skillStatus: LoadStatus;
  skillError: string | null;
  skillMutationStatus: LoadStatus;
  skillMutationError: string | null;
  /** 已停用的技能 id，持久化保存；停用的技能不进清单也不可调用 */
  disabledSkillIds: string[];
  /** 已停用的内置工具名，持久化保存；停用的工具不挂进模型工具表 */
  disabledToolIds: string[];
  loadSkills: () => Promise<void>;
  toggleSkill: (id: string) => void;
  /** 切换某个内置工具的启停：在表里即停用，不在即恢复挂载 */
  toggleTool: (name: string) => void;
  createSkill: (input: { id: string; name: string; description: string; body: string; overwrite: boolean }) => Promise<void>;
  updateSkill: (input: { originalId: string; id: string; name: string; description: string; body: string; overwrite: boolean }) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  importSkill: (input: { sourceDir: string; id: string | null; overwrite: boolean }) => Promise<void>;

  /* ---------- Agent（子代理） ---------- */
  /** 扫描到的 Agent 列表 */
  agents: AgentItem[];
  agentStatus: LoadStatus;
  agentError: string | null;
  agentMutationStatus: LoadStatus;
  agentMutationError: string | null;
  loadAgents: () => Promise<void>;
  createAgent: (input: AgentInput) => Promise<void>;
  updateAgent: (input: AgentUpdateInput) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;

  /* ---------- MCP 服务 ---------- */
  /** MCP 服务列表（含已停用的） */
  mcpServers: McpServer[];
  /** 各服务声明的工具，按服务 id 缓存 */
  mcpTools: Record<string, McpTool[]>;
  mcpStatus: LoadStatus;
  mcpError: string | null;
  mcpToolsStatus: LoadStatus;
  mcpToolsError: string | null;
  mcpMutationStatus: LoadStatus;
  mcpMutationError: string | null;
  loadMcpServers: () => Promise<void>;
  /** 拉取工具；不传 serverId 时刷新全部已启用服务 */
  loadMcpTools: (serverId?: string) => Promise<void>;
  toggleMcpServer: (id: string) => Promise<void>;
  saveMcpServer: (input: McpServerInput) => Promise<void>;
  deleteMcpServer: (id: string) => Promise<void>;

  /* ---------- 远程主机（SSH） ---------- */
  /**
   * 远程 Linux 主机列表（含已停用的）。
   *
   * 与 MCP 服务同构：这里是界面与运行期共用的唯一事实来源，配置里只有连接信息，
   * 密码与私钥口令一律存在系统凭据管理器，不进前端状态。
   */
  sshHosts: SshHost[];
  sshStatus: LoadStatus;
  sshError: string | null;
  sshMutationStatus: LoadStatus;
  sshMutationError: string | null;
  loadSshHosts: () => Promise<void>;
  toggleSshHost: (id: string) => Promise<void>;
  saveSshHost: (input: SshHostInput) => Promise<void>;
  deleteSshHost: (id: string) => Promise<void>;

  /* ---------- 并行任务 ---------- */
  /** 多项目并行任务批次（落盘在缓存目录 parallel/batches.json，新的在前） */
  parallelBatches: ParallelBatch[];
  parallelStatus: LoadStatus;
  parallelError: string | null;
  /** 读取本地并行任务批次档案 */
  loadParallelBatches: () => Promise<void>;
  /**
   * 新建一个并行批次：为每个目标项目各建一个后台会话并记录条目。
   *
   * 只负责建批次与建会话，返回待运行的任务清单；实际的模型调用由页面用 `useAgentRun().run`
   * 并行发起（store 不与 React hook 耦合），运行结束后用 `updateParallelItem` 回写状态。
   */
  createParallelBatch: (
    prompt: string,
    projects: { id: string; name: string }[],
  ) => { batchId: string; prompt: string; jobs: { threadId: string; projectId: string }[] } | null;
  /** 回写批次里某个项目的运行状态并落盘 */
  updateParallelItem: (
    batchId: string,
    threadId: string,
    patch: Partial<Pick<ParallelItem, "status" | "error" | "finishedAt">>,
  ) => void;
  removeParallelBatch: (id: string) => Promise<void>;

  /* ---------- 用量观测 ---------- */
  /** 当前会话的累计 token 用量（来自会话库 run_usage 表，非本地估算） */
  threadUsage: UsageSummary | null;
  /** 当前项目的累计 token 用量 */
  projectUsage: UsageSummary | null;
  usageStatus: LoadStatus;
  usageError: string | null;
  /** 重新汇总当前会话与当前项目的用量 */
  loadUsage: () => Promise<void>;
  /** 记录一次运行的用量并刷新汇总（写失败只影响统计，不抛出） */
  recordRunUsage: (record: UsageRecord) => Promise<void>;

  /* ---------- 自动化 ---------- */
  /** 自动化任务（落盘在缓存目录 automations/tasks.json） */
  automations: Automation[];
  /** 运行记录（落盘在 automations/runs.json，本地保留最近若干条） */
  automationRuns: AutomationRun[];
  automationStatus: LoadStatus;
  automationError: string | null;
  loadAutomations: () => Promise<void>;
  createAutomation: (input: {
    name: string;
    prompt: string;
    projectId: string;
    intervalMinutes: number;
    cron?: string | null;
    /** 绑定的 Agent id；不填表示用普通会话运行 */
    agentId?: string | null;
  }) => void;
  updateAutomation: (id: string, patch: Partial<Omit<Automation, "id">>) => void;
  toggleAutomation: (id: string) => void;
  removeAutomation: (id: string) => void;
  /** 停用全部任务：与「移除全部后台定时项」配套，避免清理后又被重新注册 */
  disableAllAutomations: () => void;
  /** 复用任务的会话并排队运行记录，返回会话与运行记录 id */
  startAutomationRun: (
    id: string,
    trigger: AutomationRun["trigger"],
  ) => { threadId: string; runId: string; prompt: string } | null;
  updateAutomationRun: (
    runId: string,
    patch: Partial<Pick<AutomationRun, "status" | "finishedAt" | "error" | "suggestions">>,
  ) => void;

  /* ---------- 产物 ---------- */
  /**
   * 当前会话产物目录下的产物文件（按写入时间倒序）。
   *
   * 目录由 [`effectiveArtifactDir`] 决定：项目会话在项目根下的 `output/`，
   * 独立会话在缓存区的 `outputs/<会话创建日>/`。切换会话必须清空重读。
   */
  artifacts: ArtifactInfo[];
  artifactStatus: LoadStatus;
  artifactError: string | null;
  /**
   * 右栏当前选中的产物：文本类给 `content`，图片 / PDF 类给 `objectUrl`（blob 预览地址）。
   * 二进制产物的 `objectUrl` 在切换或取消选中时会被 revoke，避免内存泄漏。
   */
  activeArtifact:
  | (ArtifactInfo & { content: string; objectUrl: string | null })
  | null;
  loadArtifacts: () => Promise<void>;
  selectArtifact: (name: string | null) => Promise<void>;
  /**
   * 打开一个应用内文件位置（开发者 Jan）：Markdown 相对链接导航的落点。
   * 产物位置走 `selectArtifact`；工作区位置按扩展名分流字节 / 文本通道后
   * 写进 `activeArtifact`，渲染层与产物预览共用同一形状。
   */
  openFileLocation: (target: FileLocation) => Promise<void>;
  /**
   * 旧版共享产物目录 `<缓存>/artifacts/` 是否已迁移过（每次启动最多一次）。
   *
   * 产物目录改成按会话定位后，历史产物留在旧目录里，右栏按新目录列就什么都看不到；
   * 见 [`AppStore.migrateLegacyArtifacts`]。
   */
  legacyMigrationDone: boolean;
  /** 把旧版共享产物目录里的历史产物按会话归属搬回各自产物目录 */
  migrateLegacyArtifacts: () => Promise<void>;

  /* ---------- 图纸（右栏「3D」） ---------- */
  /**
   * 当前会话工作目录 `imports/` 下的文件。
   *
   * 与产物一样是「会话级」资料：切换会话必须清空重读，否则会把上一个会话的图纸带过来。
   * 列表里可能有非图纸文件（用户手动往 `imports/` 里放了别的东西），由上层按扩展名筛。
   */
  workspaceImports: DirEntryInfo[];
  importsStatus: LoadStatus;
  /** 当前选中的图纸条目 key（`artifact:` / `import:` 前缀，见 `model/drawingSources`） */
  activeDrawing: string | null;
  loadWorkspaceImports: () => Promise<void>;
  selectDrawing: (key: string | null) => void;

  /* ---------- 全局轻提示 ---------- */
  /** 导入 / 导出这类一次性结果的提示文案；null 表示不显示 */
  notice: string | null;
  /** 显示一条轻提示，几秒后自动消失；重复调用以最后一条为准 */
  showNotice: (text: string) => void;
}

/** 模型连接信息 / 技能扫描的加载状态 */
export type LoadStatus = "idle" | "loading" | "ready" | "error";
