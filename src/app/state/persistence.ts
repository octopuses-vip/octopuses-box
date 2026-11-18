/** 状态辅助层：persistence。不依赖 Store 实例，调用方显式传入上下文。 */
import { normalizeKnowledgeFileMb } from "../../knowledge/importLimits";
import { type AppStore } from "../storeTypes";
import {
  normalizeRunLimit,
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS_CEILING,
  DEFAULT_MAX_RUN_DURATION_SECS,
  MAX_RUN_DURATION_CEILING_SECS,
  normalizeRunTokens,
  DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS,
  CONTEXT_COMPACT_THRESHOLD_CEILING_TOKENS,
  normalizeModelRetryCount,
} from "./preferences";

/** 持久化结构版本号：4 补齐知识库单文件上传大小配置。 */
export const STORE_PERSIST_VERSION = 4;

/**
 * 从完整 store 里挑出需要落盘的字段（开发者 Jan）。
 *
 * 只落「设备级偏好与会话无关的配置」：模型连接、会话、右栏开关都不落盘，
 * 分别由授权模型列表、缓存目录与界面状态在启动时重建。登录态（账号、令牌、管理端地址）
 * 由服务端授权版沿用，一并落盘以实现重启免登录。
 */
export function selectPersistedState(state: AppStore) {
  return {
    currentUser: state.currentUser,
    // 令牌随登录态一起落盘实现重启免登录；模型列表与派生连接不持久化，
    // 每次登录（或启动后处于登录态时）重新从后台获取，避免用上已被后台收窄的旧列表
    authToken: state.authToken,
    // 管理端地址同样落盘：漏掉会导致每次启动都被重新询问一次地址
    endpoint: state.endpoint,
    // 模型来源同样是设备级偏好：本机跑本地模型的用户不该每次启动都被切回远程
    modelSource: state.modelSource,
    // 拖动过的右栏宽度跟着落盘：重启后仍保持用户调好的分栏比例
    rightPanelWidth: state.rightPanelWidth,
    projects: state.projects,
    cachePath: state.cachePath,
    trustReadOnlyCommands: state.trustReadOnlyCommands,
    sandboxEnabled: state.sandboxEnabled,
    sandboxAllowNetwork: state.sandboxAllowNetwork,
    autoApprovalDenylist: state.autoApprovalDenylist,
    // 单次运行的上限是设备级偏好：用户调过的轮数 / 时长 / token 预算重启后继续生效
    maxToolRounds: state.maxToolRounds,
    maxRunDurationSecs: state.maxRunDurationSecs,
    maxRunTokens: state.maxRunTokens,
    // 压缩阈值同样是设备级偏好：调过的阈值重启后继续生效
    contextCompactThresholdTokens: state.contextCompactThresholdTokens,
    // 模型请求重试次数是设备级偏好：重启后保持用户调过的值
    modelRetryCount: state.modelRetryCount,
    knowledgeFileLimitMb: state.knowledgeFileLimitMb,
    // 图片输入手动开关跟着落盘：它是设备级偏好，重启后不应被重置
    imageInputEnabled: state.imageInputEnabled,
    videoModelCode: state.videoModelCode,
    audioModelCode: state.audioModelCode,
    // 模型调用转储开关同样是设备级偏好：重启后保持用户的选择
    modelTraceEnabled: state.modelTraceEnabled,
    // 主题同样是设备级偏好：重启后保持用户挑好的外观
    themeId: state.themeId,
    themeScheme: state.themeScheme,
    disabledSkillIds: state.disabledSkillIds,
    // 内置工具启停同样是设备级偏好：重启后保持用户关掉的工具不回来自挂
    disabledToolIds: state.disabledToolIds,
  };
}

/**
 * 升级旧持久化结构（开发者 Jan）。
 *
 * 1 版以前没有单次运行上限与转储开关，这里为它们补上默认值并收敛非法取值；
 * 登录态（账号、令牌、管理端地址）属于服务端授权版既定字段，原样保留、不在升级范围内。
 */
export function migratePersistedState(persisted: unknown): ReturnType<typeof selectPersistedState> {
  const next = { ...(persisted as Record<string, unknown>) };
  // 旧配置不再进入运行期，也不再随其他偏好重新写回磁盘。
  delete next.autoReviewEnabled;
  delete next.autoReviewModel;
  delete next.autoReviewMaxPerRun;
  delete next.autoReviewMaxPerSession;
  next.maxToolRounds = normalizeRunLimit(
    next.maxToolRounds,
    DEFAULT_MAX_TOOL_ROUNDS,
    MAX_TOOL_ROUNDS_CEILING,
  );
  next.maxRunDurationSecs = normalizeRunLimit(
    next.maxRunDurationSecs,
    DEFAULT_MAX_RUN_DURATION_SECS,
    MAX_RUN_DURATION_CEILING_SECS,
  );
  next.maxRunTokens = normalizeRunTokens(next.maxRunTokens);
  // 压缩阈值缺失时补默认值；0 是用户显式关闭，不能被悄悄改回默认
  next.contextCompactThresholdTokens = normalizeRunLimit(
    next.contextCompactThresholdTokens,
    DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS,
    CONTEXT_COMPACT_THRESHOLD_CEILING_TOKENS,
  );
  // 转储只在显式为 true 时开启：缺字段、取到字符串或别的旧值一律按关闭处理
  next.modelTraceEnabled = next.modelTraceEnabled === true;
  // 模型请求重试次数：缺字段补默认值（旧数据升级不应静默变成「从不重试」），非法取值收敛到合法区间
  next.modelRetryCount = normalizeModelRetryCount(next.modelRetryCount);
  next.knowledgeFileLimitMb = normalizeKnowledgeFileMb(next.knowledgeFileLimitMb);
  // 模型来源分两种缺省，语义完全不同，不能合并处理：
  // - 存储里压根没有这个键 = 老版本升级上来，按历史唯一行为补 "remote"，不要求用户重新选择；
  // - 有键但取值为 null / 非法 = 用户看过选择页却没做选择，保持 null，路由会重新停在选择页。
  //   把 null 收敛成 "remote" 等于替用户做决定，他下次可能莫名其妙被要求填管理端地址并登录。
  if (!("modelSource" in next)) {
    next.modelSource = "remote";
  } else if (next.modelSource !== "local" && next.modelSource !== "remote") {
    next.modelSource = null;
  }
  // 旧版本的项目没有 mcpIds / skillIds / sshHostIds / prompt：补默认值，避免运行期读到 undefined。
  // 注意补的是空数组，而空数组在严格白名单语义下是「该项目不使用该类资源」——
  // 老项目升级后需要用户去项目编辑里重新勾选，这是刻意为之，不要在这里回填全部 id。
  if (Array.isArray(next.projects)) {
    next.projects = (next.projects as Record<string, unknown>[]).map((project) => ({
      ...project,
      folders: Array.isArray(project.folders) ? project.folders.filter((p): p is string => typeof p === "string" && Boolean(p.trim())) : [],
      mcpIds: Array.isArray(project.mcpIds) ? project.mcpIds : [],
      skillIds: Array.isArray(project.skillIds) ? project.skillIds : [],
      sshHostIds: Array.isArray(project.sshHostIds) ? project.sshHostIds : [],
      prompt: typeof project.prompt === "string" ? project.prompt : "",
    }));
  }
  return next as unknown as ReturnType<typeof selectPersistedState>;
}
