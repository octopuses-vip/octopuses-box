import { isDesktopRuntime } from "./runtime";
import { requireDesktopWorkspace } from "./workspace";

type BrowserBridgeRoute = "/pair-code" | "/revoke" | "/browser/action";

/** Proxy a browser extension request to the authenticated loopback bridge. */
export async function hostRequest<T = unknown>(cachePath: string, route: BrowserBridgeRoute, body: unknown): Promise<T> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>("companion_request", { cachePath, route, body });
}

/** Start the local browser extension bridge on demand. */
export async function startHost(cachePath: string): Promise<{ url: string }> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("companion_start", { cachePath });
}

/** Shut down an older task host left running across the upgrade. */
export async function retireLegacyHost(cachePath: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("companion_retire_legacy", { cachePath });
}
