/** appearance 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { DEFAULT_THEME_ID, DEFAULT_SCHEME_PREFERENCE } from "../../theme";

export const createAppearanceSlice: StoreSlice<
  | "themeId"
  | "themeScheme"
  | "setThemeId"
  | "setThemeScheme"
> = (set) => ({
  // 首次启动用「极简灰 + 跟随系统」：观感与旧版本一致，且不会把用户固定在某个模式上
  themeId: DEFAULT_THEME_ID,

  themeScheme: DEFAULT_SCHEME_PREFERENCE,

  /** 切换配色主题（开发者 Jan）：只改偏好，落盘与写 DOM 分别由 persist 与 useTheme 负责 */
  setThemeId: (themeId) => set({ themeId }),

  /** 切换明暗偏好（开发者 Jan）：传 system 即回到跟随系统 */
  setThemeScheme: (themeScheme) => set({ themeScheme })
});
