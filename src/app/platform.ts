/**
 * 平台探测与能力谓词（开发者 Jan）：全前端唯一的平台事实来源。
 *
 * 各组件禁止自行判断 userAgent —— 所有平台分支集中在这里，避免同一判断散落多处后互相不一致。
 *
 * 探测分两步：
 * 1. 模块加载时用 `detectPlatformSync()` 从 `navigator.userAgent` 推断一个同步初值。三个平台的
 *    WebView 内核 UA 都带稳定的标志串（WebView2 → `Windows NT`、WKWebView → `Macintosh`、
 *    WebKitGTK → `Linux`），因此浏览器演示环境（`pnpm dev`）同样能得到正确结果。
 * 2. 桌面端启动后 `resolvePlatform()` 动态加载 `@tauri-apps/plugin-os` 取权威值（该调用是同步返回，
 *    编译期定值）；插件不可用或非桌面环境时保持同步初值。
 *
 * 派生谓词（`isMac` / `supportsKernelSandbox` 等）读取模块内当前平台，因此必须在 `resolvePlatform()`
 * 之后使用才能拿到权威值；涉及渲染的分支应同时依赖 store 的 `platform` 以获得重渲染。
 */

import { isDesktopRuntime } from "./desktop/runtime";

/** 平台标识；`unknown` 用于无法识别的 UA（如部分嵌入式 WebView） */
export type Platform = "macos" | "windows" | "linux" | "unknown";

/**
 * 从 userAgent 同步推断平台（开发者 Jan）。
 *
 * 先判 Android 再判 Linux：Android UA 里同样含 `Linux`，若不先排除会误判成 Linux 桌面。
 */
export function detectPlatformSync(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Windows NT/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Android/i.test(ua)) return "unknown";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

/** 当前平台（模块内状态，由 `resolvePlatform()` 更新） */
let current: Platform = detectPlatformSync();

/** 归一化插件返回值（开发者 Jan）：只认三个已知值，其余回落到 UA 推断 */
function normalize(value: string): Platform {
  if (value === "macos" || value === "windows" || value === "linux") return value;
  return detectPlatformSync();
}

/** 把平台写到 `<html data-platform="...">`（开发者 Jan）：让 CSS 直接按平台分支，无需组件内条件判断 */
export function applyPlatformAttribute(platform: Platform): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.platform = platform;
  }
}

// 模块加载即先套用同步推断值：CSS 变量（如 macOS 红绿灯留白）在桌面端拿到权威值之前就已生效
applyPlatformAttribute(current);

/**
 * 解析权威平台并更新模块内状态（开发者 Jan），同时同步 `<html data-platform>`。
 *
 * 桌面端走 `@tauri-apps/plugin-os` 的编译期定值；失败或浏览器演示环境回落 UA 推断值。
 */
export async function resolvePlatform(): Promise<Platform> {
  if (isDesktopRuntime()) {
    try {
      const { platform } = await import("@tauri-apps/plugin-os");
      current = normalize(platform());
      applyPlatformAttribute(current);
      return current;
    } catch {
      // 插件不可用（权限缺失 / 旧版本）时回落到 UA 推断，界面不应因此中断
    }
  }
  current = detectPlatformSync();
  applyPlatformAttribute(current);
  return current;
}

/** 当前平台值（开发者 Jan）；不触发 React 重渲染，渲染分支请用 store 的 platform */
export function currentPlatform(): Platform {
  return current;
}

/** 是否 macOS（开发者 Jan） */
export function isMac(): boolean {
  return current === "macos";
}

/** 是否 Windows（开发者 Jan） */
export function isWindows(): boolean {
  return current === "windows";
}

/** 是否 Linux（开发者 Jan） */
export function isLinux(): boolean {
  return current === "linux";
}

/**
 * 快捷键文案（开发者 Jan）：macOS 用 `⌘`，其余平台用 `Ctrl+`。
 *
 * 只负责生成展示文案；按键判断走 `metaKey || ctrlKey`（见 AppShell）。
 */
export function shortcutHint(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`;
}

/** 是否支持 macOS 内核级写隔离沙箱（开发者 Jan）；Seatbelt / `sandbox-exec` */
export function supportsKernelSandbox(): boolean {
  return isMac() || isLinux() || isWindows();
}

/** 是否支持桌面自动化（开发者 Jan）；AppleScript 系脚本、截图、按坐标点击 */
export function supportsDesktopAutomation(): boolean {
  return isMac() || isLinux() || isWindows();
}

/** 是否支持系统级后台定时（开发者 Jan）；应用关闭后由系统唤起，macOS 走 LaunchAgent */
export function supportsBackgroundAgents(): boolean {
  return isMac() || isLinux() || isWindows();
}