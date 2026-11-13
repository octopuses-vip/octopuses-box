/** 桌面适配层：sessions。运行环境差异在此处理，界面只调用公开函数。 */
import { isDesktopRuntime } from "./runtime";

/* ============================ 会话数据库 ============================ */

/** 落库的消息片段：`payload` 是片段完整内容的 JSON 原文，读取侧原样解析，不再为每种片段单独建列 */
export interface StoredSessionItem {
  /** 片段 id */
  id: string;
  /** 片段在所属消息内的顺序 */
  seq: number;
  /** 片段类型，与界面 StreamItem 的 type 一致 */
  kind: string;
  /** 片段完整内容的 JSON 原文 */
  payload: string;
}

/** 落库的消息 */
export interface StoredSessionMessage {
  /** 消息 id */
  id: string;
  /** 角色：`user` / `assistant` */
  role: string;
  /** 消息在所属会话内的顺序 */
  seq: number;
  /** 附件数组的 JSON 原文，无附件为 null */
  attachments: string | null;
  /** 消息片段（按 seq 升序） */
  items: StoredSessionItem[];
}

/** 落库的会话（含全部消息与片段） */
export interface StoredConversation {
  /** 会话 id */
  id: string;
  title: string;
  projectId: string;
  /** 本会话附加上下文数组的 JSON 原文（会话级：随会话落库，切会话与之隔离） */
  contextEntries: string;
  /** 本会话检索到的来源数组的 JSON 原文（会话级：随会话落库，切会话与之隔离） */
  sources: string;
  /**
   * 归档标记。归档概念已取消（侧栏的「已归档」改为「会话记录」），客户端不再读写它的语义；
   * 但库列 `archived` 仍在、Rust 侧 `StoredConversation` 也仍按此字段反序列化，
   * 因此这里保留该字段以兼容既有数据库，写入时固定为 false。
   */
  archived: boolean;
  updatedAtLabel: string;
  executionContext?: "local" | "worktree";
  /**
   * 会话自带的工作目录。独立会话没有所属项目，由用户在界面上挑一个目录后写在这里，
   * 工程工具与 `AGENTS.md` 规则才有生效的根；项目下的任务不用它（走项目目录）。
   * 旧库记录没有这一列，读回为 `null`。
   */
  workspacePath?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  reviewComments?: string;
  /** 绑定的 Agent id；旧库记录没有这一列，读回为 `null`（开发者 Jan） */
  agentId?: string | null;
  /** 父会话 id；仅 `run_subagent` 派生的子会话有值，旧库记录读回为 `null`（开发者 Jan） */
  parentThreadId?: string | null;
  /** 会话早段内容的滚动摘要；旧库没有这一列时读回为空串（开发者 Jan） */
  contextSummary?: string | null;
  /** 摘要已覆盖的消息条数；旧库没有这一列时读回为 0（开发者 Jan） */
  contextCoveredCount?: number | null;
  /** 创建时间（Unix 秒），首次入库后不再变化，读回时据此排序 */
  createdAt: number;
  /** 更新时间（Unix 秒） */
  updatedAt: number;
  messages: StoredSessionMessage[];
}

/** 会话库信息 */
export interface SessionDbInfo {
  legacyMigrated: boolean;
  /** 库文件绝对路径 */
  path: string;
  /** 本次调用是否新建了库文件 */
  created: boolean;
  /** 库中会话数量 */
  conversations: number;
}

/** 浏览器演示环境下会话库镜像的 localStorage 键（桌面端为缓存目录根部的 octopuses.db） */
export const BROWSER_SESSION_DB_KEY = "octopuses:browser-session-db";

/** 读取浏览器演示环境下的会话库镜像（`existed` 用于判断本次是否属于「首次建库」） */
export function readBrowserSessionDb(root: string): {
  conversations: Record<string, StoredConversation>;
  existed: boolean;
  legacyMigrated?: boolean;
} {
  try {
    const scoped = localStorage.getItem(`${BROWSER_SESSION_DB_KEY}:${root}`);
    const body = scoped ?? localStorage.getItem(BROWSER_SESSION_DB_KEY);
    if (!body) return { conversations: {}, existed: false };
    const parsed = JSON.parse(body) as {
      root?: string;
      conversations?: Record<string, StoredConversation>;
      legacyMigrated?: boolean;
    };
    if (parsed.root !== root && !scoped) return { conversations: {}, existed: false };
    if (parsed.root !== root || !parsed.conversations || typeof parsed.conversations !== "object" || Array.isArray(parsed.conversations)) throw new Error("会话库格式不正确");
    return { conversations: parsed.conversations, existed: true, legacyMigrated: parsed.legacyMigrated };
  } catch (error) {
    throw new Error(`浏览器会话记录读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 按缓存路径隔离浏览器镜像；写入失败必须反馈，不能把未保存的数据视为持久化成功。 */
export function saveBrowserSessionDb(root: string, conversations: Record<string, StoredConversation>, legacyMigrated = readBrowserSessionDb(root).legacyMigrated ?? false): void {
  localStorage.setItem(`${BROWSER_SESSION_DB_KEY}:${root}`, JSON.stringify({ root, conversations, legacyMigrated }));
}

/**
 * 确保会话库就绪：启动时判断库文件是否存在，不存在则创建并建表（幂等）。
 *
 * 库文件固定落在缓存目录根部（`<cachePath>/octopuses.db`）；浏览器演示环境无法落盘，
 * 用 localStorage 镜像同一份结构，保证 `pnpm dev` 下会话同样可读回。
 */
export async function ensureSessionDb(cachePath: string | null): Promise<SessionDbInfo> {
  if (!cachePath) return { path: "", created: false, conversations: 0, legacyMigrated: true };
  if (!isDesktopRuntime()) {
    const { conversations, existed, legacyMigrated } = readBrowserSessionDb(cachePath);
    return {
      path: `${cachePath}/octopuses.db`,
      created: !existed,
      conversations: Object.keys(conversations).length,
      legacyMigrated: legacyMigrated ?? false,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SessionDbInfo>("session_db_ensure", { cacheDir: cachePath });
}

/** 函数级说明（开发者 Jan）：执行 importLegacySessions 的单一职责，并返回可供调用方继续处理的结果。 */
export async function importLegacySessions(cachePath: string, records: StoredConversation[]): Promise<void> {
  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("session_db_import_legacy", { cacheDir: cachePath, conversations: records });
    return;
  }
  const state = readBrowserSessionDb(cachePath);
  if (state.legacyMigrated) return;
  saveBrowserSessionDb(cachePath, Object.keys(state.conversations).length ? state.conversations : Object.fromEntries(records.map((r) => [r.id, r])), true);
}

/** 全量读取会话库（按创建时间升序，顺序由调用方决定） */
export async function loadStoredConversations(
  cachePath: string | null,
): Promise<StoredConversation[]> {
  if (!cachePath) return [];
  if (!isDesktopRuntime()) return Object.values(readBrowserSessionDb(cachePath).conversations);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<StoredConversation[]>("session_db_load", { cacheDir: cachePath });
}

/** 保存单个会话（会话 + 消息 + 片段），后端在一个事务里 upsert 并清理本次未出现的旧行 */
export async function listStoredConversations(cachePath: string): Promise<StoredConversation[]> {
  if (!isDesktopRuntime()) return Object.values(readBrowserSessionDb(cachePath).conversations).map((record) => ({ ...record, messages: [] }));
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("session_db_list", { cacheDir: cachePath });
}

/** 函数级说明（开发者 Jan）：执行 getStoredConversation 的单一职责，并返回可供调用方继续处理的结果。 */
export async function getStoredConversation(cachePath: string, id: string): Promise<StoredConversation | null> {
  if (!isDesktopRuntime()) return readBrowserSessionDb(cachePath).conversations[id] ?? null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("session_db_get", { cacheDir: cachePath, id });
}

/** 函数级说明（开发者 Jan）：执行 saveStoredConversation 的单一职责，并返回可供调用方继续处理的结果。 */
export async function saveStoredConversation(
  cachePath: string | null,
  conversation: StoredConversation,
): Promise<void> {
  if (!cachePath) return;
  if (!isDesktopRuntime()) {
    const { conversations } = readBrowserSessionDb(cachePath);
    conversations[conversation.id] = conversation;
    saveBrowserSessionDb(cachePath, conversations);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("session_db_save", { cacheDir: cachePath, conversation });
}

/**
 * 从会话库删除单个会话（含消息、片段与用量记录）。
 *
 * 界面上删除任务、或删除项目时连带删除其下任务，都要落到库里：
 * 否则重启后会话会从 `octopuses.db` 读回，出现「删了又回来」。
 */
export async function deleteStoredConversation(cachePath: string | null, id: string): Promise<void> {
  if (!cachePath) return;
  if (!isDesktopRuntime()) {
    const { conversations } = readBrowserSessionDb(cachePath);
    delete conversations[id];
    saveBrowserSessionDb(cachePath, conversations);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("session_db_delete", { cacheDir: cachePath, id });
}
