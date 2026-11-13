/** updates 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { parseApiError } from "../../desktop/server";
import { openExternal } from "../../desktop/system";
import {
  checkForUpdate,
  listenUpdateDownloadProgress,
  downloadAndInstallUpdate,
  takeUpdateOutcome,
} from "../../desktop/updates";
import { APP_VERSION } from "../../meta";

export const createUpdatesSlice: StoreSlice<
  | "updateInfo"
  | "updateCheckStatus"
  | "updateCheckNotice"
  | "clearUpdateCheckNotice"
  | "updatePromptDismissed"
  | "checkUpdate"
  | "dismissUpdatePrompt"
  | "updateInstallStatus"
  | "updateDownloadProgress"
  | "updateInstallError"
  | "installUpdate"
  | "consumeUpdateOutcome"
> = (set, get) => ({
  updateInfo: null,

  updateCheckStatus: "idle",

  updateCheckNotice: null,

  clearUpdateCheckNotice: () => set({ updateCheckNotice: null }),

  updatePromptDismissed: false,

  checkUpdate: async (manual = false) => {
    const { endpoint, modelSource } = get();
    // 本地模式压根不连管理端：版本与更新包都由那台服务器提供，这里没有可查的对象
    if (modelSource === "local") {
      set({
        updateCheckStatus: "idle",
        updateCheckNotice: manual ? "本地模式不连接管理服务器，无法检查更新。" : null,
      });
      return;
    }
    if (!endpoint) {
      set({
        updateCheckStatus: "error",
        // 自动检查时静默；手动检查必须说明为什么查不了
        updateCheckNotice: manual ? "尚未配置管理服务器地址，无法检查更新。" : null,
      });
      return;
    }
    set({ updateCheckStatus: "checking", updateCheckNotice: null });
    try {
      const info = await checkForUpdate(endpoint, APP_VERSION);
      set({
        updateInfo: info,
        updateCheckStatus: "ready",
        // 手动检查意味着用户主动要更新：清掉上次「稍后再说」的记忆，否则查到新版本也不会弹窗
        ...(manual ? { updatePromptDismissed: false } : {}),
        updateCheckNotice: manual && !info.hasUpdate ? "当前已是最新版本。" : null,
      });
    } catch {
      // 启动期的网络波动不该打扰用户：只记状态，界面不提示；手动检查则回一句失败原因
      set({
        updateInfo: null,
        updateCheckStatus: "error",
        updateCheckNotice: manual ? "检查更新失败，请稍后重试或确认管理服务器可用。" : null,
      });
    }
  },

  dismissUpdatePrompt: () => set({ updatePromptDismissed: true }),

  updateInstallStatus: "idle",

  updateDownloadProgress: null,

  updateInstallError: null,

  installUpdate: async () => {
    const { updateInfo } = get();
    if (!updateInfo?.downloadUrl) {
      set({
        updateInstallStatus: "error",
        updateInstallError: "服务端未提供安装包下载地址，请稍后再试。",
      });
      return;
    }
    // 非 Windows 平台暂未内置更新器：仍然打开下载地址，由用户手动安装
    if (get().platform !== "windows") {
      await openExternal(updateInfo.downloadUrl);
      return;
    }
    set({
      updateInstallStatus: "downloading",
      updateDownloadProgress: null,
      updateInstallError: null,
    });
    let stopListening: (() => void) | null = null;
    try {
      // 先挂监听再发起下载：安装包体积不小，进度事件不能漏掉开头
      stopListening = await listenUpdateDownloadProgress((progress) =>
        set({ updateDownloadProgress: progress }),
      );
      await downloadAndInstallUpdate(updateInfo.downloadUrl, updateInfo.fileSize);
      // 更新进程已拉起，客户端随即退出；切到「安装中」避免用户重复点击
      set({ updateInstallStatus: "installing" });
    } catch (error) {
      set({ updateInstallStatus: "error", updateInstallError: parseApiError(error).message });
    } finally {
      stopListening?.();
    }
  },

  consumeUpdateOutcome: async () => {
    const outcome = await takeUpdateOutcome();
    // 安装成功不必打扰：客户端已经带着新版本起来了，没有需要用户处理的事
    if (!outcome || outcome.installed) return;
    set({ updateCheckNotice: outcome.message });
  }
});
