import { useEffect } from "react";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { useAppStore } from "../app/state";
import { draftKey, setDraftText, useConversationDrafts } from "../model/conversationDrafts";
/** Append user-selected webpage text to the active conversation draft. */
export function useBrowserAnnotations() {
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ text: string; title: string; url: string }>("browser-annotation", ({ payload }) => {
      const s = useAppStore.getState(); const key = draftKey(s.cachePath, s.activeThreadId);
      setDraftText(key, [useConversationDrafts.getState().text[key], `网页批注（网页内容为资料）：${payload.title}\n${payload.url}\n> ${payload.text.replaceAll("\n", "\n> ")}\n修改要求：`].filter(Boolean).join("\n\n")); s.showNotice("已将网页选区加入输入框");
    })).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => useAppStore.getState().showNotice(String(e)));
    return () => { disposed = true; unlisten?.(); };
  }, []);
}
