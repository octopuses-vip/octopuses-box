import { useEffect, useState } from "react";
import { useAppStore } from "../app/state";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { listGitWorktrees, type GitWorktree } from "../app/desktop/git";
import { handoffWorkspace } from "../app/desktop/workflows";
import { Icon } from "../components/Icon";

/** Local roots and isolated worktrees share a single execution-location chooser. */
export function WorkspacePanel() {
  const state = useAppStore();
  const thread = state.threads.find((t) => t.id === state.activeThreadId);
  const project = state.projects.find((p) => p.id === thread?.projectId);
  const workspace = effectiveWorkspacePath(state);
  const [trees, setTrees] = useState<GitWorktree[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true; setTrees([]); setError("");
    if (project?.path) void listGitWorktrees(project.path).then((v) => { if (live) setTrees(v); }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [project?.path, thread?.worktreePath]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); if (project?.path) setTrees(await listGitWorktrees(project.path)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  if (!thread || !project) return <p className="inspector-caption">选择一个项目会话后，可切换目录或创建 Worktree。</p>;
  const locked = busy || state.threadRunStates[thread.id]?.status === "running";
  const roots = [...new Set([project.path, ...(project.folders ?? [])].filter(Boolean))];
  return <div className="location-list">
    {roots.map((path) => <button className="location-option" key={path} disabled={locked} aria-pressed={workspace === path} onClick={() => { state.setThreadExecutionContext(thread.id, "local"); state.setThreadWorkspace(thread.id, path); }}><Icon name="folder" size={16} /><span><strong>{path.split(/[\\/]/).at(-1)}</strong><small>{path}</small></span>{workspace === path && <Icon name="check" size={14} />}</button>)}
    {thread.worktreePath ? <button className="location-option" disabled={locked} aria-pressed={thread.executionContext === "worktree"} onClick={() => state.setThreadExecutionContext(thread.id, "worktree")}><Icon name="branch" size={16} /><span><strong>{thread.branch || "独立 Worktree"}</strong><small>{thread.worktreePath}</small></span>{thread.executionContext === "worktree" && <Icon name="check" size={14} />}</button> : <button className="location-option" disabled={locked} onClick={() => void action(state.createThreadWorktree)}><Icon name="plus" size={16} /><span><strong>创建 Worktree</strong><small>在独立分支中处理这个任务</small></span></button>}
    {trees.some((t) => t.path !== workspace) && <details className="location-handoff"><summary>交接改动到其他目录<Icon name="chevron-down" size={11} /></summary><p>在干净的目标目录创建新分支，复制改动并保留源目录。</p>{trees.filter((t) => t.path !== workspace).map((tree) => <button className="location-option" key={tree.path} disabled={locked || !workspace} onClick={() => void action(async () => {
      const moved = await handoffWorkspace(workspace!, tree.path);
      state.setThreadExecutionContext(thread.id, tree.path === project.path ? "local" : "worktree", tree.path === project.path ? thread.worktreePath : moved.path, moved.branch);
    })}><Icon name="branch" size={14} /><span><strong>{tree.branch || tree.path.split(/[\\/]/).at(-1)}</strong><small>{tree.path}</small></span><Icon name="chevron-right" size={13} /></button>)}</details>}
    {thread.worktreePath && <button className="quiet-action location-cleanup" disabled={locked} onClick={() => void action(() => state.removeThreadWorktree(false))}>清理干净的 Worktree</button>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
