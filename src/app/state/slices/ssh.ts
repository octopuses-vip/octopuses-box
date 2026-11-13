/** ssh 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import {
  listSshHosts,
  saveSshHost as persistSshHost,
  deleteSshHost as removeSshHost,
} from "../../desktop/ssh";

export const createSshSlice: StoreSlice<
  | "sshHosts"
  | "sshStatus"
  | "sshError"
  | "sshMutationStatus"
  | "sshMutationError"
  | "loadSshHosts"
  | "toggleSshHost"
  | "saveSshHost"
  | "deleteSshHost"
> = (set, get) => ({
  sshHosts: [],

  sshStatus: "idle",

  sshError: null,

  sshMutationStatus: "idle",

  sshMutationError: null,

  loadSshHosts: async () => {
    set({ sshStatus: "loading", sshError: null });
    try {
      const sshHosts = await listSshHosts(get().cachePath);
      set({ sshHosts, sshStatus: "ready" });
    } catch (error) {
      set({ sshStatus: "error", sshError: error instanceof Error ? error.message : String(error) });
    }
  },

  toggleSshHost: async (id) => {
    const host = get().sshHosts.find((item) => item.id === id);
    if (!host) return;
    // 只翻转启用位：secret 传 null + clearSecret false，保持已保存的凭据不变
    // guardPrompt 必须原样带上：这条是整条覆盖式保存，漏传就等于停用一次主机把执行限制抹掉
    await get().saveSshHost({
      id: host.id,
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      auth: host.auth,
      keyPath: host.keyPath,
      secret: null,
      clearSecret: false,
      enabled: !host.enabled,
      guardPrompt: host.guardPrompt,
      overwrite: true,
    });
  },

  saveSshHost: async (input) => {
    set({ sshMutationStatus: "loading", sshMutationError: null });
    try {
      const sshHosts = await persistSshHost(get().cachePath, input);
      set({ sshHosts, sshMutationStatus: "ready" });
    } catch (error) {
      set({ sshMutationStatus: "error", sshMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  deleteSshHost: async (id) => {
    set({ sshMutationStatus: "loading", sshMutationError: null });
    try {
      const sshHosts = await removeSshHost(get().cachePath, id);
      set({ sshHosts, sshMutationStatus: "ready" });
    } catch (error) {
      set({ sshMutationStatus: "error", sshMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
});
