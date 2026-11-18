import { requireDesktopWorkspace } from "./workspace";
/** Proxy an authenticated request through the native companion adapter. */
export async function hostRequest<T = unknown>(cachePath: string, route: string, body?: unknown, remote = false): Promise<T> {
  requireDesktopWorkspace(); const { invoke } = await import("@tauri-apps/api/core");
  return invoke("companion_request", { cachePath, route, body, remote });
}
/** Start or reuse the local independent task service. */
export async function startHost(cachePath: string, lan: boolean): Promise<{ url: string; lan?: boolean; alreadyRunning?: boolean }> {
  requireDesktopWorkspace(); const { invoke } = await import("@tauri-apps/api/core"); return invoke("companion_start", { cachePath, lan });
}
/** Pair a remote host using a one-time code. */
export async function connectHost(cachePath: string, url: string, code: string): Promise<void> {
  requireDesktopWorkspace(); const { invoke } = await import("@tauri-apps/api/core"); return invoke("companion_connect", { cachePath, url, code });
}
