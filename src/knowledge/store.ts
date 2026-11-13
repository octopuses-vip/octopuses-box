import { create } from "zustand";
import { knowledgeRequest } from "./api";
import { EMBEDDING_VERSION } from "./model";
import type { KnowledgeSource, KnowledgeStats, SourceSummary } from "./types";
import { sourceChunks } from "./content";

interface KnowledgeState {
  scope: string | null;
  sources: SourceSummary[];
  stats: KnowledgeStats;
  syncing: boolean;
  indexing: boolean;
  paused: boolean;
  error: string | null;
  indexError: string | null;
  revision: number;
  retry: number;
  jumpTarget: { threadId: string; messageId: string } | null;
  refresh: (scope: string) => Promise<void>;
  put: (scope: string, source: KnowledgeSource) => Promise<void>;
  remove: (scope: string, id: string) => Promise<void>;
}

const emptyStats = { conversations: 0, documents: 0, chunks: 0, indexed: 0 };
export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  scope: null, sources: [], stats: emptyStats, syncing: false, indexing: false, paused: false,
  error: null, indexError: null, revision: 0, retry: 0, jumpTarget: null,
  refresh: async (scope) => {
    const [sources, stats] = await Promise.all([
      knowledgeRequest<SourceSummary[]>(scope, { op: "list" }),
      knowledgeRequest<KnowledgeStats>(scope, { op: "stats", model: EMBEDDING_VERSION }),
    ]);
    if (get().scope === scope) set({ sources, stats });
  },
  put: async (scope, source) => {
    await knowledgeRequest(scope, { op: "put", source, chunks: await sourceChunks(source) });
    if (get().scope === scope) set((state) => ({ revision: state.revision + 1 }));
  },
  remove: async (scope, id) => {
    await knowledgeRequest(scope, { op: "remove", id });
    await get().refresh(scope);
    if (get().scope === scope) set((state) => ({ revision: state.revision + 1 }));
  },
}));

export const knowledgeError = (error: unknown) => error instanceof Error ? error.message : String(error);
