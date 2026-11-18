import { STORE_PERSIST_KEY } from "./persist";

/**
 * 主题注册表与主题运行时（开发者 Jan）。
 *
 * 本模块是「有哪些主题、主题如何落定」的唯一事实来源，但**不含任何色值**：
 * 所有颜色都在 `src/styles/themes.css` 里按 `data-theme` / `data-scheme` 声明，
 * TypeScript 侧一个十六进制都不出现，新增主题只需「注册表加一条 + themes.css 加两块」。
 *
 * 刻意不依赖 store：依赖方向固定为 store → hook → theme，避免循环引用。
 */

/** 主题 id：与 themes.css 中选择器的 data-theme 取值一一对应 */
export type ThemeId = "graphite" | "ocean" | "forest" | "sunset";

/** 用户选择的明暗偏好：system 表示跟随系统 */
export type SchemePreference = "system" | "light" | "dark";

/** 落定后的实际明暗模式（不含 system） */
export type ResolvedScheme = "light" | "dark";

export interface ThemePreset {
  id: ThemeId;
  /** 设置页展示的中文名 */
  label: string;
  /** 一句话定位，作为主题卡片的副标题 */
  description: string;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "graphite", label: "极简石墨", description: "中性灰阶，专注会话与工作内容" },
  { id: "ocean", label: "海洋蓝", description: "冷调蓝，长时间阅读更轻松" },
  { id: "forest", label: "森林绿", description: "低饱和绿，偏自然护眼" },
  { id: "sunset", label: "暖阳橙", description: "暖调橙，傍晚使用更柔和" },
];

export const DEFAULT_THEME_ID: ThemeId = "graphite";
export const DEFAULT_SCHEME_PREFERENCE: SchemePreference = "system";

/** 明暗模式选项：结构与 Segmented 的 `{ value, label }` 对齐，可直接传入 */
export const SCHEME_OPTIONS: { value: SchemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** 系统深浅色的媒体查询条件：读取当前值与订阅变化共用同一份，避免两处写错 */
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** 校验任意值是否为已知主题 id（开发者 Jan）：用于兜住持久化数据里的脏值 */
export function isThemeId(value: unknown): value is ThemeId {
  return THEME_PRESETS.some((preset) => preset.id === value);
}

/** 校验任意值是否为合法明暗偏好（开发者 Jan） */
export function isSchemePreference(value: unknown): value is SchemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** 把「用户偏好 + 系统当前模式」折叠成最终模式（开发者 Jan） */
export function resolveScheme(
  preference: SchemePreference,
  system: ResolvedScheme,
): ResolvedScheme {
  return preference === "system" ? system : preference;
}

/** 读取系统当前的深浅色（开发者 Jan） */
export function readSystemScheme(): ResolvedScheme {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

/**
 * 订阅系统深浅色变化，返回取消订阅函数（开发者 Jan）。
 *
 * 使用 addEventListener 而非已废弃的 addListener；由调用方在卸载时取消订阅。
 */
export function watchSystemScheme(listener: (scheme: ResolvedScheme) => void): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
/** 函数级说明（开发者 Jan）：执行 handleChange 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleChange = (event: MediaQueryListEvent) => {
    listener(event.matches ? "dark" : "light");
  };
  query.addEventListener("change", handleChange);
  return () => query.removeEventListener("change", handleChange);
}

/**
 * 把主题与明暗模式写到 `<html>` 上（开发者 Jan）。
 *
 * 这是全局唯一的 DOM 写入入口：样式层只认这两个属性，因此「切换主题」在样式侧
 * 只是一次属性变更，不存在逐个组件适配。`color-scheme` 由 CSS 按属性声明，
 * 不在这里写内联样式，保持「JS 管属性、CSS 管表现」的分工。
 */
export function applyTheme(themeId: ThemeId, scheme: ResolvedScheme): void {
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.scheme = scheme;
}

/**
 * 校验 index.html 的首屏防闪脚本与本模块常量是否漂移（开发者 Jan）。
 *
 * 防闪脚本必须先于样式表执行，因此无法 import 本模块，只能把「落盘键」与
 * 「默认主题」写在 `<html>` 属性上再由脚本读取。这里在开发模式下比对一次，
 * 任何一侧改名都会立刻在控制台报出，而不是等到用户报告「主题不生效」。
 */
export function assertBootContract(): void {
  if (!import.meta.env.DEV) return;
  const root = document.documentElement;
  const persistedKey = root.dataset.persistKey;
  const defaultTheme = root.dataset.defaultTheme;
  if (persistedKey !== STORE_PERSIST_KEY) {
    console.error(
      `主题启动契约不一致：<html data-persist-key="${persistedKey}"> 与 STORE_PERSIST_KEY="${STORE_PERSIST_KEY}" 不匹配`,
    );
  }
  if (defaultTheme !== DEFAULT_THEME_ID) {
    console.error(
      `主题启动契约不一致：<html data-default-theme="${defaultTheme}"> 与 DEFAULT_THEME_ID="${DEFAULT_THEME_ID}" 不匹配`,
    );
  }
}
