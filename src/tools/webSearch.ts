/**
 * `web_search` 工具：让模型自己发起一次检索。
 *
 * 检索走 Bing 的 HTML 结果页（当前网络下可用；Google / DuckDuckGo 不可达）。抓取已改由
 * Rust 侧原生请求完成（见 `./webFetch`），因此不再受各平台 shell 引号规则差异的影响，
 * 也能绕开 WebView 的同源策略；本模块只保留「拼地址 + 解析结果 + 回填文本」这些纯逻辑。
 */

import type { ShellSandbox } from "../app/desktop/shell";
import type { SourceItem } from "../app/types";
import type { ChatTool } from "../model/client";
import { decodeEntities, stripTags } from "./htmlText";
import { loadWebPage } from "./webFetch";

/** 检索入口 */
const BING_ENDPOINT = "https://www.bing.com/search";
/** 检索结果的语言偏好 */
const BING_LANG_PARAM = "zh-CN";
/** 单次检索返回的结果条数上限 */
const MAX_RESULTS = 6;
/** 结果块定位：`<li>` 的 class 中含 `b_algo`（放宽写法以容忍页面改版） */
const RESULT_BLOCK_PATTERN =
  /<li\b[^>]*class=(?:"[^"]*\bb_algo\b[^"]*"|'[^']*\bb_algo\b[^']*')[^>]*>/gi;
/** 只接受真实网页链接，过滤 Bing 的站内跳转与锚点 */
const HTTP_URL_PATTERN = /^https?:\/\//i;

export const WEB_SEARCH_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "联网检索：输入查询词，返回标题、链接与摘要。需要最新信息（版本发布、报错原因、文档现状）时使用；" +
      "结果里的链接可以引用给用户，也可以用 read_url 读取正文。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，尽量具体" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

/** 工具说明，注入系统提示，告诉模型什么时候该检索 */
export function buildWebSearchHint(): string {
  return [
    "工具 web_search：需要最新信息时先检索再回答，不要凭记忆猜测版本号、接口现状这类会变的内容。",
    "检索结果会同时展示在右栏「来源」里，回答时可以引用其中的链接；要展开某一条时用 read_url 读正文。",
  ].join("\n");
}

/**
 * 拼装检索地址（开发者 Jan）：查询词交给 `encodeURIComponent` 编码，避免特殊字符影响请求。
 */
function buildSearchUrl(query: string): string {
  return `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&setlang=${BING_LANG_PARAM}`;
}

/**
 * 解析 Bing 结果页。
 *
 * 只依赖 `<li class="b_algo">` → `<h2><a href>` → 首个 `<p>` 这层最常见结构；
 * 页面改版导致解析不到时返回空数组，由调用方把「没有解析到结果」如实回报给模型。
 */
export function parseBingResults(html: string, limit = MAX_RESULTS): SourceItem[] {
  const out: SourceItem[] = [];
  const blocks = html.split(RESULT_BLOCK_PATTERN).slice(1);
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    const url = decodeEntities(anchor[1]).trim();
    if (!HTTP_URL_PATTERN.test(url)) continue;
    const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({
      title: stripTags(anchor[2]) || url,
      url,
      snippet: paragraph ? stripTags(paragraph[1]) : "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 把来源列表排成回填给模型的文本 */
export function formatSearchOutput(query: string, sources: SourceItem[]): string {
  if (sources.length === 0) {
    return `检索「${query}」未解析到结果（可能被搜索引擎限流或页面结构变化），可以换个更具体的查询词重试。`;
  }
  const lines = sources.map(
    (source, index) => `${index + 1}. ${source.title}\n   ${source.url}\n   ${source.snippet}`,
  );
  return `检索「${query}」的结果：\n${lines.join("\n")}`;
}

/** 一次检索的结果：回填给模型的文本 + 可展示在右栏的来源 */
export interface WebSearchResult {
  ok: boolean;
  output: string;
  sources: SourceItem[];
}

/** 执行一次真实检索；`sandbox` 为会话沙箱策略，网络被关闭时会直接拒绝联网（开发者 Jan） */
export async function runWebSearch(
  argumentsJson: string,
  sandbox?: ShellSandbox | null,
): Promise<WebSearchResult> {
  let query = "";
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as { query?: unknown };
    if (typeof parsed.query === "string") query = parsed.query.trim();
  } catch {
    // 参数不完整时按下面的空查询处理
  }
  if (query.length === 0) {
    return { ok: false, output: "web_search 缺少 query 参数。", sources: [] };
  }

  try {
    const page = await loadWebPage(buildSearchUrl(query), { sandbox });
    if (page.status < 200 || page.status >= 300) {
      return { ok: false, output: `检索失败：检索服务返回 HTTP ${page.status}。`, sources: [] };
    }
    const sources = parseBingResults(page.body);
    return { ok: sources.length > 0, output: formatSearchOutput(query, sources), sources };
  } catch (error) {
    return {
      ok: false,
      output: `检索失败：${error instanceof Error ? error.message : String(error)}`,
      sources: [],
    };
  }
}