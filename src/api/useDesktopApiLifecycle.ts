import { useEffect } from "react";
import { stopDesktopApi } from "../app/desktop/apiService";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { useAppStore } from "../app/state";

/** Do not keep serving the previous account or cache after the desktop settings change. */
export function useDesktopApiLifecycle(): void {
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return useAppStore.subscribe((current, previous) => {
      if (current.cachePath !== previous.cachePath ||
        current.modelSource !== previous.modelSource ||
        current.currentUser !== previous.currentUser ||
        current.authToken !== previous.authToken ||
        current.endpoint?.host !== previous.endpoint?.host ||
        current.endpoint?.port !== previous.endpoint?.port) {
        void stopDesktopApi().catch(() => { console.warn("无法停止桌面端本地 API。"); });
      }
    });
  }, []);
}
