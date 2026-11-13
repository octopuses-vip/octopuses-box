/**
 * 联网抓取的统一入口（开发者 Jan）。
 *
 * 联网检索、读取网页正文、附加上上下文三处都从这里出发，因此「沙箱是否放行网络」
 * 与「桌面端 / 浏览器演示环境」这两件环境差异只在这一处判定，调用方不必各自关心。
 *
 * 抓取失败（网络不可达、网址非法、沙箱禁止联网）会抛出可读的中文错误；非 2xx 属于
 * 正常返回，由调用方决定如何向模型或用户解释。
 */

import { fetchWebPage } from "../app/desktop/web";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { type ShellSandbox } from "../app/desktop/shell";

/** 桌面端缺省抓取超时（秒）；与 Rust 侧 `DEFAULT_TIMEOUT_SECONDS` 对齐 */
const DEFAULT_TIMEOUT_SECONDS = 25;
/** 浏览器演示环境的抓取超时（毫秒） */
const BROWSER_TIMEOUT_MS = 15_000;
/** 沙箱已开启且未放行网络时的提示：避免「设置里关了网络却照样联网」的静默越权 */
const SANDBOX_NETWORK_BLOCKED =
  "当前沙箱已关闭网络访问，联网操作被跳过；可在设置中放行网络后重试。";
/** 仅放行这两种 scheme，与 Rust 侧校验保持一致 */
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;

/** 一次网页加载的结果 */
export interface LoadedPage {
  /** 跟随重定向后的最终地址 */
  url: string;
  /** HTTP 状态码 */
  status: number;
  /** 已解码的响应体文本 */
  body: string;
  /** 原始 Content-Type */
  contentType: string;
  /** 是否因体积上限被截断 */
  truncated: boolean;
}

/** 加载选项 */
export interface LoadPageOptions {
  /** 抓取超时（秒）；不传用默认值 */
  timeoutSeconds?: number;
  /** 会话沙箱策略；开启且未放行网络时直接拒绝联网 */
  sandbox?: ShellSandbox | null;
}

/** 校验并规整网址（开发者 Jan）；非 http/https 一律拒绝 */
function normalizeUrl(url: string): string {
  const value = url.trim();
  if (value.length === 0) throw new Error("网页地址不能为空。");
  if (!HTTP_SCHEME_PATTERN.test(value)) {
    throw new Error("只支持 http:// 或 https:// 开头的网址。");
  }
  return value;
}

/** 沙箱是否禁止联网（开发者 Jan） */
function isNetworkBlocked(sandbox?: ShellSandbox | null): boolean {
  if (!sandbox || !sandbox.enabled) return false;
  return sandbox.allowNetwork === false;
}

/** 浏览器演示环境的等价实现（开发者 Jan）：受同源策略限制，能否取到由目标站点决定 */
async function loadInBrowser(url: string, timeoutMs: number): Promise<LoadedPage> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      url: response.url || url,
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? "",
      truncated: false,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 加载一个 http/https 页面（开发者 Jan）。
 *
 * 桌面端走 Rust 原生请求，绕开 WebView 的同源策略并拿到正确的响应字符集；
 * 浏览器演示环境退化为本窗口 fetch，保证 vite dev 下仍可跑通。
 */
export async function loadWebPage(
  url: string,
  options: LoadPageOptions = {},
): Promise<LoadedPage> {
  const target = normalizeUrl(url);
  if (isNetworkBlocked(options.sandbox)) throw new Error(SANDBOX_NETWORK_BLOCKED);

  if (!isDesktopRuntime()) return loadInBrowser(target, BROWSER_TIMEOUT_MS);
  return fetchWebPage(target, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
}