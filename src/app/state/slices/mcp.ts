/** mcp 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import {
  listMcpServers,
  listMcpTools as fetchMcpTools,
  saveMcpServer as persistMcpServer,
  deleteMcpServer as removeMcpServer,
} from "../../desktop/mcp";

export const createMcpSlice: StoreSlice<
  | "mcpServers"
  | "mcpTools"
  | "mcpStatus"
  | "mcpError"
  | "mcpToolsStatus"
  | "mcpToolsError"
  | "mcpMutationStatus"
  | "mcpMutationError"
  | "loadMcpServers"
  | "loadMcpTools"
  | "toggleMcpServer"
  | "saveMcpServer"
  | "deleteMcpServer"
> = (set, get) => ({
  mcpServers: [],

  mcpTools: {},

  mcpStatus: "idle",

  mcpError: null,

  mcpToolsStatus: "idle",

  mcpToolsError: null,

  mcpMutationStatus: "idle",

  mcpMutationError: null,

  loadMcpServers: async () => {
    set({ mcpStatus: "loading", mcpError: null });
    try {
      const mcpServers = await listMcpServers(get().cachePath);
      set({ mcpServers, mcpStatus: "ready" });
      // 服务列表就绪后同步拉一遍工具，运行期无需再等
      await get().loadMcpTools();
    } catch (error) {
      set({ mcpStatus: "error", mcpError: error instanceof Error ? error.message : String(error) });
    }
  },

  loadMcpTools: async (serverId) => {
    const cachePath = get().cachePath;
    const targets = get().mcpServers.filter(
      (server) => server.enabled && (!serverId || server.id === serverId),
    );
    if (targets.length === 0) {
      if (serverId) {
        set((state) => ({ mcpTools: { ...state.mcpTools, [serverId]: [] } }));
      }
      return;
    }
    set({ mcpToolsStatus: "loading", mcpToolsError: null });
    const next = { ...get().mcpTools };
    const errors: string[] = [];
    for (const server of targets) {
      try {
        next[server.id] = await fetchMcpTools(cachePath, server.id);
      } catch (error) {
        next[server.id] = [];
        errors.push(`${server.name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    set({
      mcpTools: next,
      mcpToolsStatus: errors.length > 0 ? "error" : "ready",
      mcpToolsError: errors.length > 0 ? errors.join("；") : null,
    });
  },

  toggleMcpServer: async (id) => {
    const server = get().mcpServers.find((item) => item.id === id);
    if (!server) return;
    await get().saveMcpServer({
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      enabled: !server.enabled,
      overwrite: true,
    });
  },

  saveMcpServer: async (input) => {
    set({ mcpMutationStatus: "loading", mcpMutationError: null });
    try {
      const mcpServers = await persistMcpServer(get().cachePath, input);
      set({ mcpServers, mcpMutationStatus: "ready" });
      // 保存后刷新该服务的工具；停用时清空，避免残留旧工具
      await get().loadMcpTools(input.id);
    } catch (error) {
      set({ mcpMutationStatus: "error", mcpMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  deleteMcpServer: async (id) => {
    set({ mcpMutationStatus: "loading", mcpMutationError: null });
    try {
      const mcpServers = await removeMcpServer(get().cachePath, id);
      set((state) => {
        const mcpTools = { ...state.mcpTools };
        delete mcpTools[id];
        return { mcpServers, mcpTools, mcpMutationStatus: "ready" };
      });
    } catch (error) {
      set({ mcpMutationStatus: "error", mcpMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
});
