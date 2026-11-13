/** 桌面适配层：runtime。运行环境差异在此处理，界面只调用公开函数。 */

/** 是否运行在 Tauri 桌面窗口内 */
export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
