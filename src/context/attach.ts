/**
 * 附加上下文解析：把用户在输入区附加的路径 / 网址读成文本，注入模型请求。
 *
 * 本地路径走限长的原生只读通道，按文档格式提取文字；网址走
 * `./tools/webFetch` 的原生抓取，绕开 WebView 的同源策略并抽出正文。两种读取失败时
 * 都会在解析结果里如实写明原因，而不是静默丢弃——用户能立刻看到「附加了但没生效」。
 */

import { readContextPath } from "../app/desktop/files";
import { type ShellSandbox } from "../app/desktop/shell";
import type { ContextEntry } from "../app/types";
import { clampText, htmlToText } from "../tools/htmlText";
import { loadWebPage } from "../tools/webFetch";
import { readContextFile } from "./fileText";

/** 每条附加上下文的字符上限，避免一次附加大文件把上下文撑爆 */
const PER_ENTRY_LIMIT = 8_000;
/** 全部附加内容的总字符上限 */
const TOTAL_LIMIT = 24_000;

/** 由用户输入推断上下文类型：网址 / 目录 / 文件 */
export function inferKind(label: string): ContextEntry["kind"] {
  const value = label.trim();
  if (/^https?:\/\//i.test(value)) return "url";
  if (/[\\/]$/.test(value)) return "folder";
  return "file";
}

/** 校验一条附加上下文：id / label 齐备且类型合法才算数 */
function isContextEntry(value: unknown): value is ContextEntry {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    (item.kind === "file" || item.kind === "folder" || item.kind === "url")
  );
}

/**
 * 解析读回的附加上下文数组（开发者 Jan）。
 *
 * 由「会话库读回」与「旧版本地持久化数据读回」两处共用，因此放在附加上下文自己的模块里，
 * 而不是各自写一份校验。结构不符的条目直接丢弃，坏数据不至于让整条会话打不开。
 */
export function parseContextEntries(value: unknown): ContextEntry[] {
  return Array.isArray(value) ? value.filter(isContextEntry) : [];
}

/** 目录自动识别，不要求手动补斜杠；文件按类型提取文字。 */
async function resolvePath(
  label: string,
  base: string | null,
  readPath: typeof readContextPath,
) {
  const result = await readPath(label, base);
  if (result.kind === "folder") {
    return clampText(`目录 ${label} 下的条目（${result.entries.length} 项${result.truncated ? "，已截断" : ""}）：\n${result.entries.join("\n")}`, PER_ENTRY_LIMIT);
  }
  const text = await readContextFile(result.name, result.bytes);
  return clampText(text || "（空文件）", PER_ENTRY_LIMIT);
}

/** 解析网址：抓取页面并抽成正文（网络失败时抛出可读原因） */
async function resolveUrl(label: string, sandbox?: ShellSandbox | null): Promise<string> {
  const page = await loadWebPage(label, { sandbox });
  if (page.status < 200 || page.status >= 300) throw new Error(`HTTP ${page.status}`);
  return htmlToText(page.body, PER_ENTRY_LIMIT);
}

/**
 * 把附加的上下文拼成一段系统消息；没有任何附加项时返回 null。
 *
 * `projectPath` 是当前项目在项目编辑弹窗里选定的目录，相对路径按它拼接。
 */
export async function buildContextMessage(
  entries: ContextEntry[],
  projectPath: string | null,
  sandbox?: ShellSandbox | null,
  readPath: typeof readContextPath = readContextPath,
): Promise<string | null> {
  if (entries.length === 0) return null;
  const parts: string[] = [];
  let used = 0;
  for (const entry of entries) {
    let body: string;
    try {
      body =
        entry.kind === "url"
          ? await resolveUrl(entry.label, sandbox)
          : await resolvePath(entry.label, projectPath, readPath);
    } catch (error) {
      body = `（读取失败：${error instanceof Error ? error.message : String(error)}）`;
    }
    const source = entry.label.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const block = `<context source="${source}">\n${body}\n</context>`;
    if (used + block.length > TOTAL_LIMIT) {
      parts.push("（其余附加内容超出总长度上限，未注入）");
      break;
    }
    used += block.length;
    parts.push(block);
  }
  return [
    "下面是用户主动附加的上下文，请优先结合这些内容理解任务：",
    ...parts,
  ].join("\n\n");
}
