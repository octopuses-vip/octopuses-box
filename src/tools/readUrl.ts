/**
 * `read_url` 工具：让模型读取一个网页的正文。
 *
 * 与 `web_search` 互补：检索只给标题与摘要，模型拿到链接后需要展开时用本工具。
 * 抓取同样走 Rust 原生请求（见 `./webFetch`），正文抽取复用 `./htmlText` 的纯函数，
 * 因此本模块只负责参数解析与回填文本的拼装。
 */

import type { ShellSandbox } from "../app/desktop/shell";
import type { SourceItem } from "../app/types";
import type { ChatTool } from "../model/client";
import { extractTitle, htmlToText } from "./htmlText";
import { loadWebPage } from "./webFetch";

/** 工具名：与 `web_search` 区分，便于运行循环按名分发 */
export const READ_URL_TOOL_NAME = "read_url";
/** 右栏「来源」里摘要的字符上限：正文前若干字符足够让用户认出是哪一页 */
const SNIPPET_CHARS = 200;

export const READ_URL_TOOL: ChatTool = {
  type: "function",
  function: {
    name: READ_URL_TOOL_NAME,
    description:
      "读取一个网页的正文：输入网址，返回标题与已去除标签的正文文本。" +
      "需要核对某条链接的具体内容（而不是只看标题与摘要）时使用。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要读取的网页地址，以 http:// 或 https:// 开头" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

/** 工具说明（开发者 Jan）：注入系统提示，告诉模型该在什么时候读正文 */
export function buildReadUrlHint(): string {
  return "工具 read_url：拿到具体链接后用它读取正文再回答，不要只凭链接标题猜测内容。";
}

/** 一次网页读取的结果：回填给模型的文本 + 可展示在右栏的来源 */
export interface ReadUrlResult {
  ok: boolean;
  output: string;
  sources: SourceItem[];
}

/** 从工具参数里取出网址（开发者 Jan）；参数不合法时返回空串，由调用方回填可读错误 */
function readUrlArgument(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url.trim() : "";
  } catch {
    return "";
  }
}

/** 执行一次网页正文读取（开发者 Jan） */
export async function runReadUrl(
  argumentsJson: string,
  sandbox?: ShellSandbox | null,
): Promise<ReadUrlResult> {
  const url = readUrlArgument(argumentsJson);
  if (url.length === 0) {
    return { ok: false, output: "read_url 缺少 url 参数。", sources: [] };
  }

  try {
    const page = await loadWebPage(url, { sandbox });
    if (page.status < 200 || page.status >= 300) {
      return { ok: false, output: `读取失败：目标站点返回 HTTP ${page.status}。`, sources: [] };
    }
    const title = extractTitle(page.body) || page.url;
    const text = htmlToText(page.body);
    if (text.length === 0) {
      return {
        ok: false,
        output: `读取「${page.url}」没有取到可读正文，可能是脚本渲染的页面或非 HTML 内容。`,
        sources: [],
      };
    }
    const truncatedNote = page.truncated ? "\n（内容过长，已在抓取阶段截断）" : "";
    return {
      ok: true,
      output: `网页「${title}」的正文：\n地址：${page.url}\n\n${text}${truncatedNote}`,
      sources: [{ title, url: page.url, snippet: text.slice(0, SNIPPET_CHARS) }],
    };
  } catch (error) {
    return {
      ok: false,
      output: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      sources: [],
    };
  }
}