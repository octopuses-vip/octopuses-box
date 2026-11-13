/** 桌面适配层：control。运行环境差异在此处理，界面只调用公开函数。 */
import { isDesktopRuntime } from "./runtime";
import { openExternal } from "./system";

/* ============================ 浏览器与电脑自动化 ============================ */

/** 一条自动化调用的结果；ok 为 false 时 output 是可读的失败原因 */
export interface ControlResult {
  ok: boolean;
  output: string;
}

/** 浏览器名称：仅支持本机已安装的 Chrome 与 Safari */
export type ControlBrowser = "chrome" | "safari";

/** 浏览器动作：`navigate` 打开网址，`eval` 在当前标签页执行 JS 并取回结果 */
export type ControlBrowserAction = "navigate" | "eval";

/** 用系统默认浏览器打开网址；浏览器演示环境退化为新标签页 */
export async function openInBrowser(url: string): Promise<ControlResult> {
  if (!isDesktopRuntime()) {
    try {
      await openExternal(url);
      return { ok: true, output: `已在浏览器打开：${url}` };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ControlResult>("control_open_in_browser", { url });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** 用 AppleScript 驱动本机 Chrome / Safari 导航或执行 JS；仅在桌面端可用 */
export async function runBrowserScript(
  browser: ControlBrowser,
  action: ControlBrowserAction,
  value: string,
): Promise<ControlResult> {
  if (!isDesktopRuntime()) {
    return { ok: false, output: "浏览器自动化仅在桌面端可用，请在桌面端运行。" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ControlResult>("control_browser_script", { browser, action, value });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** 执行一段 AppleScript 以操作本机应用（点击、输入、切换应用等）；仅在桌面端可用 */
export async function runComputerScript(script: string): Promise<ControlResult> {
  if (!isDesktopRuntime()) {
    return { ok: false, output: "电脑自动化仅在桌面端可用，请在桌面端运行。" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ControlResult>("control_computer_script", { script });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/* ============================ 调试浏览器（CDP）与截图 ============================ */

/** 一个可被 CDP 驱动的目标（通常是一个标签页） */
export interface CdpTarget {
  id: string;
  /** 目标类型：`page` 是标签页，其余类型不建议直接驱动 */
  type: string;
  title: string;
  url: string;
  /** 协议 WebSocket 地址；调用前必须再校验一次 host 是否为 127.0.0.1 */
  webSocketDebuggerUrl: string;
}

/** 一次屏幕截图的结果 */
export interface ScreenshotResult {
  ok: boolean;
  output: string;
  /** PNG 的 base64；`ok` 为 false 时是空串 */
  base64: string;
  /** PNG 像素宽（Retina 下是逻辑点的 2 倍） */
  width: number;
  /** PNG 像素高度 */
  height: number;
  mime: string;
}

/**
 * 启动一个仅用于调试协议的浏览器实例（独立 profile），并等待调试端口就绪。
 *
 * 浏览器协议本身由前端原生 WebSocket 直连，这里只负责进程与端口就绪。
 */
export async function cdpLaunch(port?: number): Promise<ControlResult> {
  if (!isDesktopRuntime()) {
    return { ok: false, output: "调试浏览器仅在桌面端可用，请在桌面端运行。" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ControlResult>("control_cdp_launch", { port: port ?? null });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** 列出调试浏览器的可驱动目标；失败时抛出可读错误 */
export async function cdpTargets(port?: number): Promise<CdpTarget[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CdpTarget[]>("control_cdp_targets", { port: port ?? null });
}

/** 关闭由本应用启动的调试浏览器 */
export async function cdpClose(): Promise<ControlResult> {
  if (!isDesktopRuntime()) {
    return { ok: false, output: "调试浏览器仅在桌面端可用，请在桌面端运行。" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ControlResult>("control_cdp_close");
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** 截取全屏图；权限被拒时返回可读的授权指引 */
export async function takeScreenshot(): Promise<ScreenshotResult> {
  if (!isDesktopRuntime()) {
    return {
      ok: false,
      output: "屏幕截图仅在桌面端可用，请在桌面端运行。",
      base64: "",
      width: 0,
      height: 0,
      mime: "image/png",
    };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ScreenshotResult>("control_screenshot");
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      base64: "",
      width: 0,
      height: 0,
      mime: "image/png",
    };
  }
}

/**
 * 按截图像素坐标点击屏幕。
 *
 * `imageWidth` 是模型看到的截图宽度：Retina 屏上截图像素是逻辑点的两倍，
 * 由后端据它换算成系统坐标，避免点偏一倍。
 */
export async function computerClick(
  x: number,
  y: number,
  imageWidth?: number,
): Promise<ControlResult> {
  if (!isDesktopRuntime()) {
    return { ok: false, output: "模拟点击仅在桌面端可用，请在桌面端运行。" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ControlResult>("control_computer_click", {
      x,
      y,
      imageWidth: imageWidth ?? null,
    });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
