/** notices 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";

const NOTICE_DURATION_MS = 3200;
let noticeTimer: number | null = null;
let noticeToken = 0;

export const createNoticesSlice: StoreSlice<
  | "notice"
  | "showNotice"
> = (set) => ({
  notice: null,

  showNotice: (text) => {
    const value = text.trim();
    if (value.length === 0) return;
    noticeToken += 1;
    const token = noticeToken;
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    set({ notice: value });
    noticeTimer = window.setTimeout(() => {
      // 只有仍是最新一条时才清空，否则会把后来居上的提示一并抹掉
      if (noticeToken === token) set({ notice: null });
    }, NOTICE_DURATION_MS);
  }
});
