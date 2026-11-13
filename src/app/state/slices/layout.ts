/** layout 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { detectPlatformSync } from "../../platform";
import { reviveRightPanelWidth } from "../preferences";

export const createLayoutSlice: StoreSlice<
  | "view"
  | "activeProjectId"
  | "rightPanelOpen"
  | "rightPanelWidth"
  | "rightPanelMaximized"
  | "rightTab"
  | "platform"
  | "effort"
  | "terminalOpen"
  | "commandPaletteOpen"
  | "setView"
  | "setPlatform"
  | "setActiveProject"
  | "setRightPanelOpen"
  | "toggleRightPanel"
  | "setRightPanelWidth"
  | "setRightPanelMaximized"
  | "setRightTab"
  | "setEffort"
  | "toggleTerminal"
  | "setCommandPaletteOpen"
> = (set, get) => ({
  view: "chats",

  // 首次使用没有任何项目，当前项目为空串；添加项目时由界面写入
  activeProjectId: "",

  rightPanelOpen: false,

  rightPanelWidth: null,

  rightPanelMaximized: false,

  rightTab: "files",

  platform: detectPlatformSync(),

  effort: 3,

  terminalOpen: false,

  commandPaletteOpen: false,

  setView: (view) => set({ view }),

  setPlatform: (platform) => set({ platform }),

  setActiveProject: (id) => {
    const state = get();
    const firstThread = state.threads.find((thread) => thread.projectId === id);
    if (firstThread) {
      state.openThread(firstThread.id);
    } else {
      // 项目下还没有任务：清空当前会话，否则主区会继续显示上一个项目的对话，
      // 输入框也可能把消息发到不属于该项目的会话上
      set({ activeProjectId: id, activeThreadId: "", view: "chats" });
    }
  },

  setRightPanelOpen: (open) =>
    set((state) => ({
      rightPanelOpen: open,
      // 关闭时一并退出最大化：否则下次打开右栏会直接占满中间栏，与用户动作不符
      rightPanelMaximized: open ? state.rightPanelMaximized : false,
    })),

  toggleRightPanel: () =>
    set((state) => {
      const open = !state.rightPanelOpen;
      return {
        rightPanelOpen: open,
        rightPanelMaximized: open ? state.rightPanelMaximized : false,
        rightPanelWidth: open ? reviveRightPanelWidth(state.rightPanelWidth) : state.rightPanelWidth,
      };
    }),

  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),

  setRightPanelMaximized: (maximized) => set({ rightPanelMaximized: maximized }),

  setRightTab: (tab) =>
    set((state) => ({
      rightTab: tab,
      rightPanelOpen: true,
      rightPanelWidth: reviveRightPanelWidth(state.rightPanelWidth),
    })),

  setEffort: (effort) => set({ effort }),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open })
});
