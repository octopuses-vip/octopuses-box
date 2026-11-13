import { create } from "zustand";
import { AttachmentDraft } from "./attachmentDraft";
const attachments = new Map<string, AttachmentDraft>();
const KEY = "octopuses:conversation-text-drafts";
/** 函数级说明（开发者 Jan）：执行 read 的单一职责，并返回可供调用方继续处理的结果。 */
function read(): Record<string, string> {
  try { const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === "string")) : {}; }
  catch { return {}; }
}
export const useConversationDrafts = create<{ text: Record<string, string>; error: string | null }>(() => ({ text: read(), error: null }));
export const draftKey = (scope: string | null, threadId: string) => JSON.stringify([scope, threadId]);
/** 函数级说明（开发者 Jan）：执行 setDraftText 的单一职责，并返回可供调用方继续处理的结果。 */
export function setDraftText(key: string, text: string) {
  const next = { ...useConversationDrafts.getState().text };
  if (text) next[key] = text; else delete next[key];
  useConversationDrafts.setState({ text: next });
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next)); useConversationDrafts.setState({ error: null }); }
  catch { useConversationDrafts.setState({ error: "文字草稿暂未保存到本机，刷新前请先复制。" }); }
}
/** 函数级说明（开发者 Jan）：执行 attachmentDraftFor 的单一职责，并返回可供调用方继续处理的结果。 */
export function attachmentDraftFor(key: string) { let draft = attachments.get(key); if (!draft) { draft = new AttachmentDraft(); attachments.set(key, draft); } return draft; }
/** 函数级说明（开发者 Jan）：执行 discardConversationDraft 的单一职责，并返回可供调用方继续处理的结果。 */
export function discardConversationDraft(scope: string | null, threadId: string) { const key = draftKey(scope, threadId); attachments.delete(key); setDraftText(key, ""); }
