import type { Endpoint } from "../types";
import { isDesktopRuntime } from "./runtime";

export interface DesktopApiAccess {
  url: string;
  token: string;
}

interface DesktopApiOptions {
  cachePath: string;
  local: boolean;
  endpoint: Endpoint | null;
  authToken: string | null;
  username: string | null;
}

let pending = Promise.resolve();

/** Keep a settings action and a simultaneous account change in order. */
function changeApi<T>(action: () => Promise<T>): Promise<T> {
  const operation = pending.then(action);
  pending = operation.then(() => {}, () => {});
  return operation;
}

/** Get the address and caller credential from the process this client owns. */
export async function desktopApiStatus(): Promise<DesktopApiAccess | null> {
  if (!isDesktopRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopApiAccess | null>("desktop_api_status");
}

/** Launch the bundled service using the selected desktop settings. */
export function startDesktopApi(options: DesktopApiOptions): Promise<DesktopApiAccess> {
  return changeApi(async () => {
    if (!isDesktopRuntime()) throw new Error("请使用桌面客户端启动本地 API。");
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DesktopApiAccess>("desktop_api_start", { ...options });
  });
}

/** Stop just the client-owned service; command-line instances are independent. */
export function stopDesktopApi(): Promise<void> {
  return changeApi(async () => {
    if (!isDesktopRuntime()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("desktop_api_stop");
  });
}
