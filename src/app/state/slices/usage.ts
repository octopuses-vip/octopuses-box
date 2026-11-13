/** usage 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { fetchUsageSummary, recordUsage as persistUsage } from "../../desktop/usage";

export const createUsageSlice: StoreSlice<
  | "threadUsage"
  | "projectUsage"
  | "usageStatus"
  | "usageError"
  | "loadUsage"
  | "recordRunUsage"
> = (set, get) => ({
  threadUsage: null,

  projectUsage: null,

  usageStatus: "idle",

  usageError: null,

  loadUsage: async () => {
    const cachePath = get().cachePath;
    const thread = get().threads.find((item) => item.id === get().activeThreadId);
    set({ usageStatus: "loading", usageError: null });
    try {
      const [threadUsage, projectUsage] = await Promise.all([
        fetchUsageSummary(cachePath, { conversationId: thread?.id }),
        fetchUsageSummary(cachePath, { projectId: thread?.projectId }),
      ]);
      set({ threadUsage, projectUsage, usageStatus: "ready" });
    } catch (error) {
      set({ usageStatus: "error", usageError: error instanceof Error ? error.message : String(error) });
    }
  },

  recordRunUsage: async (record) => {
    try {
      await persistUsage(get().cachePath, record);
    } catch (error) {
      // 用量是观测数据：写失败只记录，不让主流程失败
      set({ usageError: error instanceof Error ? error.message : String(error) });
      return;
    }
    await get().loadUsage();
  }
});
