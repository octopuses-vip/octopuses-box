/** preferences 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { DEFAULT_KNOWLEDGE_FILE_MB, normalizeKnowledgeFileMb } from "../../../knowledge/importLimits";
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  normalizeRunLimit,
  MAX_TOOL_ROUNDS_CEILING,
  DEFAULT_MAX_RUN_DURATION_SECS,
  MAX_RUN_DURATION_CEILING_SECS,
  normalizeRunTokens,
  DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS,
  CONTEXT_COMPACT_THRESHOLD_CEILING_TOKENS,
  DEFAULT_MODEL_RETRY_COUNT,
  normalizeModelRetryCount,
} from "../preferences";

export const createPreferencesSlice: StoreSlice<
  | "trustReadOnlyCommands"
  | "setTrustReadOnlyCommands"
  | "sandboxEnabled"
  | "setSandboxEnabled"
  | "sandboxAllowNetwork"
  | "setSandboxAllowNetwork"
  | "autoApprovalDenylist"
  | "addAutoApprovalDenylist"
  | "clearAutoApprovalDenylist"
  | "maxToolRounds"
  | "setMaxToolRounds"
  | "maxRunDurationSecs"
  | "setMaxRunDurationSecs"
  | "maxRunTokens"
  | "setMaxRunTokens"
  | "contextCompactThresholdTokens"
  | "setContextCompactThresholdTokens"
  | "modelTraceEnabled"
  | "setModelTraceEnabled"
  | "modelRetryCount"
  | "knowledgeFileLimitMb"
  | "setKnowledgeFileLimitMb"
  | "setModelRetryCount"
> = (set) => ({
  trustReadOnlyCommands: true,

  setTrustReadOnlyCommands: (value) => set({ trustReadOnlyCommands: value }),

  sandboxEnabled: true,

  setSandboxEnabled: (value) => set({ sandboxEnabled: value }),

  sandboxAllowNetwork: true,

  setSandboxAllowNetwork: (value) => set({ sandboxAllowNetwork: value }),

  autoApprovalDenylist: [],

  addAutoApprovalDenylist: (pattern) =>
    set((state) =>
      pattern.trim().length === 0 || state.autoApprovalDenylist.includes(pattern)
        ? state
        : { autoApprovalDenylist: [...state.autoApprovalDenylist, pattern] },
    ),

  clearAutoApprovalDenylist: () => set({ autoApprovalDenylist: [] }),

  // 单次运行的上限默认对齐 CLI 的 LoopPolicy：10 轮 / 30 分钟 / token 不限
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,

  setMaxToolRounds: (value) =>
    set({
      maxToolRounds: normalizeRunLimit(value, DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_CEILING),
    }),

  maxRunDurationSecs: DEFAULT_MAX_RUN_DURATION_SECS,

  setMaxRunDurationSecs: (value) =>
    set({
      maxRunDurationSecs: normalizeRunLimit(
        value,
        DEFAULT_MAX_RUN_DURATION_SECS,
        MAX_RUN_DURATION_CEILING_SECS,
      ),
    }),

  maxRunTokens: null,

  setMaxRunTokens: (value) => set({ maxRunTokens: normalizeRunTokens(value) }),

  // 压缩阈值默认 10 万 token；0 表示关闭自动压缩
  contextCompactThresholdTokens: DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS,

  setContextCompactThresholdTokens: (value) =>
    set({
      contextCompactThresholdTokens: normalizeRunLimit(
        value,
        DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS,
        CONTEXT_COMPACT_THRESHOLD_CEILING_TOKENS,
      ),
    }),

  // 默认关闭：转储是排查手段，开启与否属于这台机器上的偏好，因此跟着落盘
  modelTraceEnabled: false,

  setModelTraceEnabled: (modelTraceEnabled) => set({ modelTraceEnabled }),

  // 模型请求失败后的自动重试次数：默认 3 次；0 表示失败立即停止任务
  modelRetryCount: DEFAULT_MODEL_RETRY_COUNT,

  knowledgeFileLimitMb: DEFAULT_KNOWLEDGE_FILE_MB,

  setKnowledgeFileLimitMb: (value) => set({ knowledgeFileLimitMb: normalizeKnowledgeFileMb(value) }),

  setModelRetryCount: (value) => set({ modelRetryCount: normalizeModelRetryCount(value) })
});
