import { useEffect } from "react";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { useAppStore } from "../app/state";
import { knowledgeRequest } from "./api";
import { conversationSource } from "./content";
import { useKnowledgeModel } from "./model";
import { indexPendingKnowledge } from "./indexer";
import { knowledgeError, useKnowledgeStore } from "./store";
import { sessionMessages } from "../cache/conversationSnapshot";

/** 全部历史会话回填；流式输出期间只标脏，运行结束后才分块与计算向量。 */
export function useKnowledgeSync() {
  const scope = useAppStore((state) => state.cachePath);
  const restored = useAppStore((state) => state.sessionsRestored);
  const restoreError = useAppStore((state) => state.sessionsRestoreError);
  const enabled = useKnowledgeModel((state) => state.status?.enabled ?? false);
  const paused = useKnowledgeStore((state) => state.paused);
  const revision = useKnowledgeStore((state) => state.revision);
  const syncing = useKnowledgeStore((state) => state.syncing);
  const retry = useKnowledgeStore((state) => state.retry);

  useEffect(() => { void useKnowledgeModel.getState().refresh(); }, []);

  useEffect(() => {
    if (!scope || !restored || restoreError) {
      useKnowledgeStore.setState({ scope: null, sources: [], stats: { conversations: 0, documents: 0, chunks: 0, indexed: 0 },
        syncing: false, indexing: false, error: restoreError ? `会话恢复失败，已保留原知识库：${restoreError}` : null });
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let repeat = false;
    const dirty = new Set(useAppStore.getState().threads.map((thread) => thread.id));
    useKnowledgeStore.setState({ scope, sources: [], stats: { conversations: 0, documents: 0, chunks: 0, indexed: 0 }, error: null, syncing: true });
    const hashes = new Map<string, string>();

/** 函数级说明（开发者 Jan）：执行 flush 的单一职责，并返回可供调用方继续处理的结果。 */
    const flush = async () => {
      if (!active) return;
      if (running) { repeat = true; return; }
      const valid = useAppStore.getState();
      if (valid.cachePath !== scope || !valid.sessionsRestored || valid.sessionsRestoreError) return;
      running = true;
      repeat = false;
      useKnowledgeStore.setState({ syncing: true });
      try {
        const state = useAppStore.getState();
        await knowledgeRequest(scope, { op: "prune", ids: state.threads.map((thread) => `conversation:${thread.id}`) });
        for (const id of [...dirty]) {
          if (!active) break;
          const current = useAppStore.getState();
          if (current.threadRunStates[id]?.status === "running" || current.threadRunStates[id]?.status === "queued") continue;
          const thread = current.threads.find((item) => item.id === id);
          if (!thread) { dirty.delete(id); continue; }
          dirty.delete(id);
          try {
            const messages = await sessionMessages(scope, id, current.messages[id]);
            const source = await conversationSource(thread, messages);
            if (!active) break;
            if (hashes.get(source.id) !== source.hash) {
              await useKnowledgeStore.getState().put(scope, source);
              hashes.set(source.id, source.hash);
            }
          } catch (error) { dirty.add(id); throw error; }
        }
        if (active) { await useKnowledgeStore.getState().refresh(scope); useKnowledgeStore.setState({ error: null }); }
      } catch (error) {
        if (active) useKnowledgeStore.setState({ error: knowledgeError(error) });
      } finally {
        running = false;
        if (active) useKnowledgeStore.setState({ syncing: false });
        if (active && repeat) schedule();
      }
    };
/** 函数级说明（开发者 Jan）：执行 schedule 的单一职责，并返回可供调用方继续处理的结果。 */
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void flush(); }, 1200); };
    const unsubscribe = useAppStore.subscribe((state, before) => {
      if (state.cachePath !== scope || !state.sessionsRestored || state.sessionsRestoreError) return;
      if (state.messages !== before.messages || state.threads !== before.threads || state.threadRunStates !== before.threadRunStates) {
        const previousThreads = new Map(before.threads.map((t) => [t.id, t]));
        for (const thread of state.threads) {
          if (state.messages[thread.id] !== before.messages[thread.id] || thread !== previousThreads.get(thread.id)
            || state.threadRunStates[thread.id] !== before.threadRunStates[thread.id]) dirty.add(thread.id);
        }
        if (!running) useKnowledgeStore.setState({ syncing: true });
        schedule();
      }
    });
    void (async () => {
      try {
        await useKnowledgeStore.getState().refresh(scope);
        if (!active) return;
        for (const source of useKnowledgeStore.getState().sources) hashes.set(source.id, source.hash);
        await flush();
      } catch (error) { if (active) useKnowledgeStore.setState({ error: knowledgeError(error), syncing: false }); }
    })();
    return () => { active = false; unsubscribe(); clearTimeout(timer); };
  }, [scope, restored, restoreError, retry]);

  useEffect(() => {
    if (!scope || !restored || restoreError || syncing || !enabled || paused || !isDesktopRuntime()) {
      if (!enabled) void import("./embedding").then((module) => module.releaseEmbedding());
      return;
    }
    let active = true;
    const controller = new AbortController();
    useKnowledgeStore.setState({ indexing: true, indexError: null });
    void (async () => {
      try {
        const stats = await indexPendingKnowledge(scope, controller.signal);
        if (active) useKnowledgeStore.setState({ stats });
      } catch (error) { if (active) useKnowledgeStore.setState({ indexError: knowledgeError(error) }); }
      finally { if (active) useKnowledgeStore.setState({ indexing: false }); }
    })();
    return () => { active = false; controller.abort(); useKnowledgeStore.setState({ indexing: false }); };
  }, [scope, restored, restoreError, syncing, enabled, paused, revision, retry]);
}
