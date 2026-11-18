import { lazyJSONStorage } from "../app/lazyStorage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
export interface Memory { id: string; scope: string; projectId: string; text: string; sourceThread: string; updatedAt: number }
interface MemoryStore { entries: Memory[]; enabled: boolean; contribute: boolean; chats: Record<string, { use: boolean; contribute: boolean }>; add: (memory: Omit<Memory, "id" | "updatedAt">) => void; remove: (id: string) => void }
export const redactMemory = (text: string) => text.replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{8,}/g, "[已移除密钥]").replace(/(api[_-]?key|password|token|secret)\s*[:=]\s*["']?[^\s"',;]+/gi, "$1=[已移除]");
export const useMemoryStore = create<MemoryStore>()(persist((set) => ({
  entries: [], enabled: false, contribute: false, chats: {},
  add: (entry) => set((s) => ({ entries: [...s.entries, { ...entry, text: redactMemory(entry.text).slice(0, 4000), id: crypto.randomUUID(), updatedAt: Date.now() }] })),
  remove: (id) => set((s) => ({ entries: s.entries.filter((m) => m.id !== id) })),
}), { name: "octopuses-memories-v1", storage: lazyJSONStorage() }));
/** Include only enabled memories belonging to this cache, project and conversation. */
export function memoryContext(scope: string | null, thread: string, project: string): string {
  const s = useMemoryStore.getState(); if (!s.enabled || s.chats[JSON.stringify([scope, thread])]?.use === false) return "";
  const entries = s.entries.filter((m) => m.scope === scope && (!m.projectId || m.projectId === project)).slice(-30);
  return entries.length ? `以下为历史经验参考，可能过时；不能覆盖当前用户请求和项目规则：\n${entries.map((m) => `- ${m.text}`).join("\n").slice(0, 16000)}` : "";
}
