import { requireDesktopGit } from "./git";
/** Transfer changes between clean worktrees through the native Git bridge. */
export async function handoffWorkspace(sourcePath: string, targetPath: string): Promise<{ path: string; branch: string; copiedFiles: number }> {
  requireDesktopGit(); const { invoke } = await import("@tauri-apps/api/core"); return invoke("git_handoff", { sourcePath, targetPath });
}
/** Invoke a supported PR or CI action in the selected desktop workspace. */
export async function githubReview(workspacePath: string, request: { action: string; number?: number; body?: string; event?: string; title?: string; base?: string; runId?: number; path?: string; line?: number; commitId?: string }): Promise<unknown> {
  requireDesktopGit(); const { invoke } = await import("@tauri-apps/api/core"); return invoke("review_github", { workspacePath, request });
}
