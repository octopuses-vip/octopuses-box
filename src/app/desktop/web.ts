/** 桌面适配层：web。运行环境差异在此处理，界面只调用公开函数。 */
import { type WebFetchResult } from "../types";
import { isDesktopRuntime } from "./runtime";

/**
 * 抓取一个 http/https 页面并返回解码后的文本。
 *
 * 桌面端走 Rust 的 `web_fetch`：WebView 里直接 fetch 第三方站点会被同源策略拦下，
 * 且拿不到响应字符集（中文站点常为 GBK），因此统一交给原生请求处理。
 * 只有 http/https 之外的 scheme 会被后端拒绝，非 2xx 属正常返回。
 */
export async function fetchWebPage(url: string, timeoutSeconds?: number): Promise<WebFetchResult> {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器演示环境无法抓取网页，请在桌面端（pnpm tauri dev）使用联网能力。");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WebFetchResult>("web_fetch", { url, timeoutSecs: timeoutSeconds ?? null });
}
