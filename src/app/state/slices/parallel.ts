/** parallel 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { listParallelBatches, deleteParallelBatch } from "../../desktop/parallel";
import { nextId } from "../../ids";
import { type ParallelBatch } from "../../types";
import { PARALLEL_BATCH_LIMIT, persistParallelBatch } from "../parallel";

export const createParallelSlice: StoreSlice<
  | "parallelBatches"
  | "parallelStatus"
  | "parallelError"
  | "loadParallelBatches"
  | "createParallelBatch"
  | "updateParallelItem"
  | "removeParallelBatch"
> = (set, get) => ({
  parallelBatches: [],

  parallelStatus: "idle",

  parallelError: null,

  loadParallelBatches: async () => {
    set({ parallelStatus: "loading", parallelError: null });
    try {
      const parallelBatches = await listParallelBatches(get().cachePath);
      set({ parallelBatches, parallelStatus: "ready" });
    } catch (error) {
      set({
        parallelStatus: "error",
        parallelError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  createParallelBatch: (prompt, projectTargets) => {
    const value = prompt.trim();
    if (value.length === 0 || projectTargets.length === 0) return null;
    const threadTitle = value.length > 32 ? value.slice(0, 32) : value;
    const batch: ParallelBatch = {
      id: nextId("batch"),
      prompt: value,
      createdAt: Date.now(),
      // 每个项目各建一个后台会话（focus 为 false，不打断当前界面）
      items: projectTargets.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        threadId: get().createThread(threadTitle, project.id, false),
        status: "queued",
        error: null,
        finishedAt: null,
      })),
    };
    const parallelBatches = [batch, ...get().parallelBatches]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, PARALLEL_BATCH_LIMIT);
    set({ parallelBatches });
    persistParallelBatch(get().cachePath, batch);
    return {
      batchId: batch.id,
      prompt: value,
      jobs: batch.items.map((item) => ({
        threadId: item.threadId,
        projectId: item.projectId,
      })),
    };
  },

  updateParallelItem: (batchId, threadId, patch) => {
    const batch = get().parallelBatches.find((item) => item.id === batchId);
    if (!batch) return;
    const updated: ParallelBatch = {
      ...batch,
      items: batch.items.map((item) =>
        item.threadId === threadId ? { ...item, ...patch } : item,
      ),
    };
    set((state) => ({
      parallelBatches: state.parallelBatches.map((item) =>
        item.id === batchId ? updated : item,
      ),
    }));
    persistParallelBatch(get().cachePath, updated);
  },

  removeParallelBatch: async (id) => {
    try {
      const cachePath = get().cachePath;
      const parallelBatches = cachePath
        ? await deleteParallelBatch(cachePath, id)
        : get().parallelBatches.filter((item) => item.id !== id);
      set({ parallelBatches, parallelError: null });
    } catch (error) {
      set({ parallelError: error instanceof Error ? error.message : String(error) });
    }
  }
});
