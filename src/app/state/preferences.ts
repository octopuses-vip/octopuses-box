/** 状态辅助层：preferences。不依赖 Store 实例，调用方显式传入上下文。 */

/**
 * 右栏被重新唤起时校正宽度（开发者 Jan）。
 *
 * 只有正数才是有效的右栏宽度：0 说明上一次是被分隔条拖没的（等价于隐藏），
 * 原样打开只会得到一块看不见内容的面板；非数字则来自异常的历史持久化数据。
 * 这两种情况一律回落成 `null`（默认宽度）。
 */
export function reviveRightPanelWidth(width: number | null): number | null {
  return typeof width === "number" && width > 0 ? width : null;
}

/** 单次运行的默认轮数上限：与 CLI `LoopPolicy.max_iterations` 的取值对齐 */
export const DEFAULT_MAX_TOOL_ROUNDS = 10;

/** 单次运行的默认时长预算（秒）：与 CLI `LoopPolicy.max_duration_secs` 的取值对齐 */
export const DEFAULT_MAX_RUN_DURATION_SECS = 1800;

/** 轮数上限的天花板：防止一份损坏的持久化数据写出一个实际等于「不限」的数字 */
export const MAX_TOOL_ROUNDS_CEILING = 1000;

/** 时长上限的天花板（秒），24 小时；超过即视为不限的极端值 */
export const MAX_RUN_DURATION_CEILING_SECS = 86_400;

/**
 * 上下文自动压缩的默认阈值（估算 token）。
 *
 * 10 万 token 大致对应主流 128k~200k 上下文模型的安全区间：留出系统提示、工具定义与
 * 本轮回复的余量，又不至于让长会话频繁触发压缩。
 */
export const DEFAULT_CONTEXT_COMPACT_THRESHOLD_TOKENS = 100_000;

/** 压缩阈值的天花板：超过 200 万 token 的模型尚不存在，更大的值按损坏数据处理 */
export const CONTEXT_COMPACT_THRESHOLD_CEILING_TOKENS = 2_000_000;

/** 模型请求失败后的默认自动重试次数 */
export const DEFAULT_MODEL_RETRY_COUNT = 3;

/** 重试次数的天花板：再多就只是把故障放大成更长的无响应等待 */
export const MAX_MODEL_RETRY_COUNT = 20;

/**
 * 收敛模型请求重试次数（开发者 Jan）。
 *
 * 与 `normalizeRunLimit` 语义不同：这里 **0 是合法取值**（显式关闭重试，失败立即停止任务），
 * 因此「非正数收 0」而不是「非正数视为不限」。负数视为损坏数据收 0；
 * 字段不是数字时回落到默认值——不能收 0，否则旧数据缺字段会静默变成「从不重试」。
 */
export function normalizeModelRetryCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MODEL_RETRY_COUNT;
  const rounded = Math.floor(value);
  if (rounded <= 0) return 0;
  return Math.min(rounded, MAX_MODEL_RETRY_COUNT);
}

/**
 * 收敛单次运行的轮数 / 时长上限（开发者 Jan）。
 *
 * 取值语义为「**非正数即不限**」，与 token 预算把非正数视为「不限」的约定一致：用户在设置页
 * 把某个上限填 0 就是显式关掉它，不能再被悄悄改成一个有限值。
 *
 * 除此之外还剩一条兜底规则：字段不是数字（缺失、字符串、损坏的持久化数据）时回落到默认值。
 * 这一条不能改成 0——否则旧数据里缺字段就会静默变成「不限」，正好是相反的方向。
 * 正数则向下取整并受天花板约束，避免异常大的数字事实上等于不限。
 */
export function normalizeRunLimit(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded <= 0) return 0;
  return Math.min(rounded, ceiling);
}

/** 收敛 token 预算：`null`、非有限数与非正数一律视为「不限」 */
export function normalizeRunTokens(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded < 1 ? null : rounded;
}
