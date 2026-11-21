import type { Endpoint } from "../types";

export type ApiHistoryView = "sessions" | "jobs";

export interface ApiHistoryScope {
  cachePath: string;
  local: boolean;
  endpoint: Endpoint | null;
  username: string | null;
}

export interface ApiHistoryPageData<T> {
  items: T[];
  hasMore: boolean;
}

export interface ApiHistoryItem {
  id: string;
  model: string;
  agentId: string | null;
  kind: string | null;
  preview: string | null;
  status: string | null;
  updatedAt: number;
}

export interface ApiHistoryTurn {
  id: string;
  prompt: string | null;
  status: string;
  createdAt: number;
  text: string | null;
  error: string | null;
  skillIds: string[];
  artifact: { name: string; bytes: number } | null;
}

/** The desktop reads its own API database even when the service is stopped. */
export async function listApiHistory(scope: ApiHistoryScope, view: ApiHistoryView, page: number): Promise<ApiHistoryPageData<ApiHistoryItem>> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("desktop_api_history_list", { scope, view, page });
}

/** Load the selected API record without sending identifiers or content over HTTP. */
export async function readApiHistory(
  scope: ApiHistoryScope, view: ApiHistoryView, id: string, page: number,
): Promise<ApiHistoryPageData<ApiHistoryTurn>> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("desktop_api_history_read", { scope, view, id, page });
}
