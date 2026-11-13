/**
 * 界面模型（Thread / Message）与会话库结构（StoredConversation）之间的映射。
 *
 * 落库时把每条消息片段整条序列化进 `payload`，读回时原样解析成片段对象：
 * 片段类型在界面上会持续增加（reasoning / tool_call / diff / sources / question / text），
 * 库表不为每种类型单列字段，避免每加一种片段就要改一次表结构。
 */

import type { StoredConversation, StoredSessionItem, StoredSessionMessage } from "../app/desktop/sessions";
import type { ContextEntry, Message, MessageAttachment, ReviewComment, SourceItem, StreamItem, Thread } from "../app/types";
import { DEFAULT_PERMISSION_MODE } from "../approval/permission";
import { parseContextEntries } from "../context/attach";

/** 当前 Unix 时间戳（秒），与后端一致 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 校验一条从库里读回的片段：只放行 id / type 齐备的对象 */
function isStoredItem(value: unknown): value is StreamItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.type === "string";
}

/** 校验一条从库里读回的附件 */
function isAttachment(value: unknown): value is MessageAttachment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.name === "string";
}

/** 把旧版单问题追问迁移为批量追问格式，确保历史会话可继续打开 */
function migrateLegacyQuestion(item: Record<string, unknown>): StreamItem | null {
  if (typeof item.id !== "string" || typeof item.text !== "string") return null;

  const questionId = "legacyQuestion";
  const options = Array.isArray(item.options)
    ? item.options
        .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
        .map((option) => ({
          label: option,
          description: `选择「${option}」继续。`,
        }))
    : [];
  const choice = typeof item.choice === "string" && item.choice.trim().length > 0
    ? item.choice
    : null;

  return {
    id: item.id,
    type: "question",
    questions: [
      {
        id: questionId,
        header: "需要确认",
        question: item.text,
        options,
      },
    ],
    answers: choice ? { [questionId]: [choice] } : null,
  };
}

/** 解析片段载荷；损坏或结构不符时返回 null，由调用方丢弃该片段 */
function parseItem(stored: StoredSessionItem): StreamItem | null {
  try {
    const parsed: unknown = JSON.parse(stored.payload);
    if (!isStoredItem(parsed)) return null;
    if (parsed.type === "approval") {
      return parsed.status === "pending" ? { ...parsed, status: "expired" } : parsed;
    }
    if (parsed.type !== "question") return parsed;

    const question = parsed as unknown as Record<string, unknown>;
    return Array.isArray(question.questions)
      ? parsed
      : migrateLegacyQuestion(question);
  } catch {
    return null;
  }
}

/** 解析附件数组；无附件或损坏时返回 undefined（消息按无附件处理） */
function parseAttachments(raw: string | null): MessageAttachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const attachments = parsed.filter(isAttachment);
    return attachments.length > 0 ? attachments : undefined;
  } catch {
    return undefined;
  }
}

/** 校验一条从磁盘读回的差异行评论（开发者 Jan）：评论随会话落盘，可能是旧格式或被手工改过 */
function isReviewComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.threadId === "string" &&
    typeof item.path === "string" &&
    typeof item.line === "number" &&
    (item.side === "old" || item.side === "new" || item.side === "context") &&
    typeof item.context === "string" &&
    typeof item.text === "string" &&
    typeof item.resolved === "boolean" &&
    typeof item.createdAt === "number"
  );
}

/** 解析落盘的评论数组（开发者 Jan）：空值或解析失败一律当作「没有评论」，不让坏数据阻断会话读取 */
function parseReviewComments(raw: string | undefined): ReviewComment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isReviewComment) : [];
  } catch {
    return [];
  }
}

/** 解析附加上下文数组；无内容或损坏时返回空数组（会话按没有附加项处理） */
function parseStoredContextEntries(raw: string | undefined): ContextEntry[] {
  if (!raw) return [];
  try {
    return parseContextEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 校验一条检索来源：标题 / 网址 / 摘要三项都是字符串才放行 */
function isSourceItem(value: unknown): value is SourceItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.title === "string" &&
    typeof item.url === "string" &&
    typeof item.snippet === "string"
  );
}

/**
 * 从已解析的 JSON 值里筛出合法的来源数组（开发者 Jan）。
 *
 * 落库文件可能被手工改动或来自旧格式，读取侧必须逐条收紧，避免把脏数据灌进右栏。
 * 这里只做结构校验；非数组（含 `null`，旧库记录没有这一列）一律按空数组处理。
 */
export function parseSources(value: unknown): SourceItem[] {
  return Array.isArray(value) ? value.filter(isSourceItem) : [];
}

/** 解析落库的来源 JSON 原文；无内容或损坏时返回空数组 */
function parseStoredSources(raw: string | undefined): SourceItem[] {
  if (!raw) return [];
  try {
    return parseSources(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 一条消息 → 落库结构；片段按数组顺序写 seq（流式片段每轮都会被整条覆盖写回） */
function toStoredMessage(message: Message, seq: number): StoredSessionMessage {
  return {
    id: message.id,
    role: message.role,
    seq,
    attachments:
      message.attachments && message.attachments.length > 0
        ? JSON.stringify(message.attachments)
        : null,
    items: [...message.items.map((item, index) => ({
      id: item.id,
      seq: index,
      kind: item.type,
      payload: JSON.stringify(item),
    })), ...(message.answerVersions?.length ? [{ id: `${message.id}:answer-versions`, seq: message.items.length, kind: "answer_versions", payload: JSON.stringify(message.answerVersions) }] : [])],
  };
}

/**
 * 会话 → 落库结构。
 *
 * `createdAt` 取当前时间，由后端在 upsert 时保留首次写入值；
 * 批量首次入库（导入旧文件 / 落库初始会话）时由调用方统一改写，保证读回顺序稳定。
 */
export function toStoredConversation(thread: Thread, messages: Message[]): StoredConversation {
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    // 附加上下文是会话级数据：整条序列化进库，读回时原样恢复，切会话与重启都不会串味
    contextEntries: JSON.stringify(thread.contextEntries),
    // 检索来源同样是会话级数据：与附加上下文并列落库，随会话一起读回
    sources: JSON.stringify(thread.sources),
    // 归档概念已取消（「已归档」改为「会话记录」）：库列保留以兼容既有数据库，客户端不再赋予它语义
    archived: false,
    updatedAtLabel: thread.updatedAtLabel,
    executionContext: thread.executionContext,
    workspacePath: thread.workspacePath,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    reviewComments: JSON.stringify(thread.reviewComments),
    agentId: thread.agentId,
    parentThreadId: thread.parentThreadId,
    // 上下文压缩状态随会话落库：摘要与覆盖条数在重启后继续生效，压缩不能只活一次运行
    contextSummary: thread.contextSummary,
    contextCoveredCount: thread.contextCoveredCount,
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
    messages: messages.map(toStoredMessage),
  };
}

/** 落库结构 → 界面模型：消息与片段按 seq 升序，解析失败的片段直接丢弃 */
export function fromStoredConversation(stored: StoredConversation): {
  thread: Thread;
  messages: Message[];
} {
  const thread: Thread = {
    id: stored.id,
    title: stored.title,
    projectId: stored.projectId,
    // 创建日决定独立会话产物落在 `outputs/<日期>/` 的哪一层，因此必须原样读回；
    // 旧库这一列缺失或为 0 时退回当前时间，至少保证目录定位可用
    createdAt: typeof stored.createdAt === "number" && stored.createdAt > 0 ? stored.createdAt : nowSeconds(),
    updatedAtLabel: stored.updatedAtLabel,
    contextEntries: parseStoredContextEntries(stored.contextEntries),
    // 检索来源随会话落库，同样逐条校验后恢复；旧库没有这一列时按空数组处理
    sources: parseStoredSources(stored.sources),
    executionContext: stored.executionContext === "worktree" && stored.worktreePath ? "worktree" : "local",
    // 独立会话自选的工作目录：旧库记录没有这一列时读回 null，按「未指定目录」处理
    workspacePath: stored.workspacePath ?? null,
    worktreePath: stored.worktreePath ?? null,
    branch: stored.branch ?? null,
    // 权限档位不落库：它是本会话的临时授权，每次读回都从默认档位重新开始
    permissionMode: DEFAULT_PERMISSION_MODE,
    reviewComments: parseReviewComments(stored.reviewComments),
    // Agent 绑定与父会话随会话落库；旧库没有这两列时读回 null，按普通会话处理
    agentId: stored.agentId ?? null,
    parentThreadId: stored.parentThreadId ?? null,
    // 压缩状态同样兼容旧库：没有这两列时按「未压缩过」处理
    contextSummary: stored.contextSummary ?? "",
    contextCoveredCount:
      typeof stored.contextCoveredCount === "number" && stored.contextCoveredCount > 0
        ? Math.floor(stored.contextCoveredCount)
        : 0,
  };
  const messages = [...stored.messages]
    .sort((left, right) => left.seq - right.seq)
    .map((message) => {
      const items = [...message.items]
        .sort((left, right) => left.seq - right.seq)
        .map(parseItem)
        .filter((item): item is StreamItem => item !== null);
      const role: Message["role"] = message.role === "assistant" ? "assistant" : "user";
      const attachments = parseAttachments(message.attachments);
      let answerVersions: Message["answerVersions"];
      const versions = message.items.find((item) => item.kind === "answer_versions");
      if (versions) {
        try {
          const parsed: unknown = JSON.parse(versions.payload);
          if (Array.isArray(parsed)) answerVersions = parsed.filter((v) => v && typeof v.id === "string" && Array.isArray(v.messages) && v.messages.every((m: Message) => m && typeof m.id === "string" && m.role === "assistant" && Array.isArray(m.items)));
        } catch { /* corrupt optional metadata cannot prevent restoring the selected conversation */ }
      }
      return { id: message.id, role, items, ...(attachments ? { attachments } : {}), ...(answerVersions?.length ? { answerVersions } : {}) };
    });
  return { thread, messages };
}
