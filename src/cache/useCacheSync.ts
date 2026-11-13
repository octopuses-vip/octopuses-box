import { useEffect } from "react";
import { writeCacheFile } from "../app/desktop/cache";
import { selectThreadSources } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { sessionSnapshot } from "./conversationSnapshot";
import { sessionWrites, flushSessionWrites, useSessionPersistence } from "./sessionPersistence";
import { stopAllThreadRuns } from "../hooks/useAgentRun";

/** Bounded snapshots; failed writes/deletions survive view and scope changes. */
export function useCacheSync() {
  const cachePath = useAppStore((s) => s.cachePath);
  const restored = useAppStore((s) => s.sessionsRestored);
  const restoreError = useAppStore((s) => s.sessionsRestoreError);
  useEffect(() => {
    if (!cachePath || !restored || restoreError) return;
    const queue = sessionWrites(cachePath);
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useAppStore.subscribe((state, before) => {
      if (state.cachePath !== cachePath || !state.sessionsRestored || state.sessionsRestoreError) return;
      if (state.threads !== before.threads || state.messages !== before.messages) {
        const previous = new Map(before.threads.map((t) => [t.id, t]));
        const current = new Set(state.threads.map((t) => t.id));
        for (const thread of state.threads) {
          if (thread !== previous.get(thread.id) || state.messages[thread.id] !== before.messages[thread.id]) {
            if (thread === previous.get(thread.id) && before.messages[thread.id] === undefined) continue;
            const messages = state.messages[thread.id];
            queue.put(thread.id, () => sessionSnapshot(cachePath, thread, messages));
          }
        }
        for (const thread of before.threads) if (!current.has(thread.id)) queue.put(thread.id, null);
      }
      if (state.diffFiles !== before.diffFiles && snapshotTimer === undefined) {
        const id = state.activeThreadId, diff = state.diffFiles, sources = selectThreadSources(state, id);
        snapshotTimer = setTimeout(() => {
          snapshotTimer = undefined;
          if (id) void Promise.allSettled([
            writeCacheFile(cachePath, `snapshots/${id}-diff.json`, JSON.stringify(diff)),
            writeCacheFile(cachePath, `snapshots/${id}-sources.json`, JSON.stringify(sources)),
          ]);
        }, 800);
      }
    });
/** 函数级说明（开发者 Jan）：执行 flush 的单一职责，并返回可供调用方继续处理的结果。 */
    const flush = () => { void queue.flush().catch(() => {}); };
/** 函数级说明（开发者 Jan）：执行 hide 的单一职责，并返回可供调用方继续处理的结果。 */
    const hide = () => { if (document.hidden) flush(); };
/** 函数级说明（开发者 Jan）：执行 leave 的单一职责，并返回可供调用方继续处理的结果。 */
    const leave = (event: BeforeUnloadEvent) => {
      flush();
      if (useSessionPersistence.getState().pending) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hide);
    return () => {
      unsubscribe(); flush(); clearTimeout(snapshotTimer);
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [cachePath, restored, restoreError]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("../app/desktop/runtime").then(async ({ isDesktopRuntime }) => {
      if (!isDesktopRuntime()) return;
      const { listen } = await import("@tauri-apps/api/event");
      const { invoke } = await import("@tauri-apps/api/core");
      const stop = await listen("session-exit-requested", () => {
        useSessionPersistence.setState({ exitRequested: true });
        void stopAllThreadRuns()
          .then(flushSessionWrites).then(() => { if (useSessionPersistence.getState().exitRequested) return invoke("session_exit_ready"); })
          .catch((error) => useSessionPersistence.setState({ error: `退出前保存失败：${String(error)}` }));
      });
      if (disposed) stop(); else { unlisten = stop; await invoke("session_exit_listening", { ready: true }); }
    }).catch(() => {});
    return () => {
      disposed = true; unlisten?.();
      if (unlisten) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("session_exit_listening", { ready: false })).catch(() => {});
    };
  }, []);
}
