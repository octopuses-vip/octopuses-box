/** 状态辅助层：sessions。不依赖 Store 实例，调用方显式传入上下文。 */
import { DEFAULT_PERMISSION_MODE } from "../../approval/permission";
import { parseSources, toStoredConversation } from "../../cache/sessionDb";
import { parseContextEntries } from "../../context/attach";
import { readCacheFile } from "../desktop/cache";
import { type StoredConversation } from "../desktop/sessions";
import { nextId } from "../ids";
import { type MessageAttachment, type Message, type Thread, type ReviewComment } from "../types";

export const loadingSessions = new Map<string, Promise<void>>();

/**
 * 构造一条用户消息（开发者 Jan）。
 *
 * 会话内所有「用户说了什么」都经这里生成，因此 id 前缀、角色与附件字段的形状只在一处定义；
 * 附件随消息一起存进会话库，重建上下文时能还原用户当时贴了哪些文件。
 */
export function userMessage(text: string, attachments: MessageAttachment[]): Message {
  return {
    id: nextId("msg"),
    role: "user",
    items: text.length > 0 ? [{ id: nextId("item"), type: "text", text, streaming: false }] : [],
    attachments,
  };
}

/** 新建独立会话时的默认标题（会话尚未发出第一条消息） */
export const NEW_SESSION_TITLE = "新会话";

/** 在项目下新建任务时的默认标题（任务尚未发出第一条消息） */
export const NEW_TASK_TITLE = "新任务";

/* ============================ 会话落盘与读回 ============================ */

/**
 * 校验一条从磁盘读回的会话。
 *
 * 落盘文件是上一版本写下的 JSON，可能被手工改动或来自旧格式，读取侧必须逐字段收紧，
 * 只放行结构完整的条目，避免把脏数据灌进界面。
 */
export function parseThread(value: unknown): Thread | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    item.id.length === 0 ||
    typeof item.title !== "string" ||
    typeof item.projectId !== "string" ||
    typeof item.updatedAtLabel !== "string"
  ) {
    return null;
  }

  return {
    id: item.id,
    title: item.title,
    projectId: item.projectId,
    // 创建日决定独立会话的产物落在缓存区 `outputs/<日期>/` 的哪一层，必须读回来；
    // 旧数据没有这一项时退回当前时间，至少保证目录定位可用
    createdAt:
      typeof item.createdAt === "number" &&
        Number.isFinite(item.createdAt) &&
        item.createdAt > 0
        ? item.createdAt
        : Math.floor(Date.now() / 1000),
    updatedAtLabel: item.updatedAtLabel,
    // 附加上下文是会话级字段：旧数据没有这一项时按空处理，不让整条会话读不回来
    contextEntries: parseContextEntries(item.contextEntries),
    // 检索来源同样是会话级字段，旧数据没有这一列时按空数组处理
    sources: parseSources(item.sources),
    // 会话自带的工作目录同样是后加字段：旧数据没有就按「未指定」，与独立会话的默认状态一致
    workspacePath: typeof item.workspacePath === "string" ? item.workspacePath : null,
    executionContext:
      item.executionContext === "worktree" && typeof item.worktreePath === "string"
        ? "worktree"
        : "local",
    worktreePath: typeof item.worktreePath === "string" ? item.worktreePath : null,
    branch: typeof item.branch === "string" ? item.branch : null,
    // 权限档位是内存里的临时授权、不参与落盘，因此读回时一律回到默认档位
    permissionMode: DEFAULT_PERMISSION_MODE,
    reviewComments: Array.isArray(item.reviewComments)
      ? item.reviewComments.filter((comment): comment is ReviewComment => {
        if (typeof comment !== "object" || comment === null) return false;
        const review = comment as Record<string, unknown>;
        return (
          typeof review.id === "string" &&
          typeof review.threadId === "string" &&
          typeof review.path === "string" &&
          typeof review.line === "number" &&
          (review.side === "old" || review.side === "new" || review.side === "context") &&
          typeof review.context === "string" &&
          typeof review.text === "string" &&
          typeof review.resolved === "boolean" &&
          typeof review.createdAt === "number"
        );
      })
      : [],
    // Agent 绑定与父会话同样是后加字段：旧数据没有就按「不绑定 / 普通会话」处理
    agentId: typeof item.agentId === "string" ? item.agentId : null,
    parentThreadId: typeof item.parentThreadId === "string" ? item.parentThreadId : null,
    // 上下文压缩状态也是后加字段：旧数据没有就按「未压缩」处理
    contextSummary: typeof item.contextSummary === "string" ? item.contextSummary : "",
    contextCoveredCount:
      typeof item.contextCoveredCount === "number" &&
        Number.isFinite(item.contextCoveredCount) &&
        item.contextCoveredCount > 0
        ? Math.floor(item.contextCoveredCount)
        : 0,
  };
}

/** 校验一条从磁盘读回的消息（只保留 id / role / items 结构完整的条目） */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    (item.role === "user" || item.role === "assistant") &&
    Array.isArray(item.items)
  );
}

/** 解析 `sessions/index.json`；文件缺失或格式不符时返回 null，由调用方沿用当前状态 */
export function parseThreads(body: string | null): Thread[] | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return null;
    const threads = parsed
      .map(parseThread)
      .filter((thread): thread is Thread => thread !== null);
    // 文件存在但一条都解析不出来，视为损坏，不改动界面
    if (parsed.length > 0 && threads.length === 0) return null;
    return threads;
  } catch {
    return null;
  }
}

/** 解析 `sessions/<threadId>.json`；文件缺失或格式不符时返回空消息列表 */
export function parseMessages(body: string | null): Message[] {
  if (!body) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return [];
    const list = (parsed as { messages?: unknown }).messages;
    if (!Array.isArray(list)) return [];
    return list.filter(isMessage);
  } catch {
    return [];
  }
}

/**
 * 读回旧版 JSON 会话文件（仅在会话库为空时调用一次）。
 *
 * 旧版把会话拆成 `sessions/index.json`（列表）+ `sessions/<id>.json`（消息）两份文件；
 * 导入数据库后单一数据源即为库文件，这两份 JSON 不再读写（保留在磁盘上供人工排查）。
 */
export async function loadLegacyConversations(cachePath: string): Promise<StoredConversation[]> {
  const threads = parseThreads(await readCacheFile(cachePath, "sessions/index.json"));
  if (!threads || threads.length === 0) return [];
  const conversations: StoredConversation[] = [];
  for (const thread of threads) {
    const messages = parseMessages(await readCacheFile(cachePath, `sessions/${thread.id}.json`));
    conversations.push(toStoredConversation(thread, messages));
  }
  return conversations;
}
