/** context 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { inferKind } from "../../../context/attach";
import { nextId } from "../../ids";

export const createContextSlice: StoreSlice<
  | "mergeSources"
  | "addContextEntry"
  | "removeContextEntry"
  | "clearContextEntries"
> = (set, get) => ({
  // 检索来源挂在会话上（见 `Thread.sources`）：与附加上下文一样只在所属会话内有效，
  // 因此按传入的 threadId 写入对应会话，切会话互不影响，并随会话一起落库。
  mergeSources: (threadId, items) =>
    set((state) => ({
      threads: state.threads.map((thread) => {
        if (thread.id !== threadId) return thread;
        // 同一个网址出现多次没有意义，按 url 去重
        const seen = new Set(thread.sources.map((item) => item.url));
        const merged = [...thread.sources];
        for (const item of items) {
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          merged.push(item);
        }
        // 没有任何新增时保持原引用，避免触发一次无意义的落盘
        if (merged.length === thread.sources.length) return thread;
        return { ...thread, sources: merged };
      }),
    })),

  // 附加上下文挂在会话上（见 `Thread.contextEntries`）：它只在所属会话内有效，
  // 切换会话互不影响，并随会话一起落库。下面三个动作统一改当前会话自己那一条。
  addContextEntry: (label) => {
    const value = label.trim();
    if (value.length === 0) return;
    const { activeThreadId } = get();
    if (!activeThreadId) return;
    set((state) => ({
      threads: state.threads.map((thread) => {
        if (thread.id !== activeThreadId) return thread;
        // 同一个路径 / 网址附加两次没有意义，按 label 去重
        if (thread.contextEntries.some((item) => item.label === value)) return thread;
        return {
          ...thread,
          contextEntries: [
            ...thread.contextEntries,
            { id: nextId("ctx"), label: value, kind: inferKind(value) },
          ],
        };
      }),
    }));
  },

  removeContextEntry: (id) => {
    const { activeThreadId } = get();
    if (!activeThreadId) return;
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === activeThreadId
          ? {
            ...thread,
            contextEntries: thread.contextEntries.filter((item) => item.id !== id),
          }
          : thread,
      ),
    }));
  },

  clearContextEntries: () => {
    const { activeThreadId } = get();
    if (!activeThreadId) return;
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === activeThreadId ? { ...thread, contextEntries: [] } : thread,
      ),
    }));
  }
});
