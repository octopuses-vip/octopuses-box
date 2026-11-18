/** 状态辅助层：workspace。不依赖 Store 实例，调用方显式传入上下文。 */
import { type AppStore } from "../storeTypes";

/**
 * 取一条会话生效的工作目录（开发者 Jan）。
 *
 * 优先级：worktree（任务独占的目录）> 所属项目目录 > 会话自带目录。
 * 项目目录在前，是因为项目本就是「多个任务共享的上下文与资源」，同一项目下的任务必须
 * 落在同一份工作区；独立会话没有项目，才退到用户给它挑的那个目录。两者都为空则返回
 * `null`，此时工程工具整组不挂出（见 `hooks/useAgentRun.ts`），模型只能纯对话。
 *
 * 工作目录**只有这一处解析**，store 里不再存副本字段：原先的 `projectPath` 状态字段要在
 * 切项目 / 切会话 / 改项目目录 / 建 worktree 等十处手工同步，还进了持久化，漏一处就显示
 * 旧路径；改为按需读取后，路径与项目天然一致。
 */
export function effectiveWorkspacePath(
  state: Pick<AppStore, "threads" | "projects" | "activeThreadId">,
  threadId = state.activeThreadId,
): string | null {
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return null;
  if (thread.executionContext === "worktree" && thread.worktreePath) return thread.worktreePath;
  const project = state.projects.find((p) => p.id === thread.projectId);
  const roots = project ? [project.path, ...(project.folders ?? [])].filter(Boolean) : [];
  if (thread.workspacePath && roots.includes(thread.workspacePath)) return thread.workspacePath;
  return project?.path || thread.workspacePath || null;
}

/**
 * 收集一次 Git 交付操作所需的上下文（开发者 Jan）：会话、项目、有效工作区与缓存目录。
 *
 * 四项缺一不可——暂存 / 提交 / 推送都同时需要「改哪个仓库」「按哪个项目归属」与「Worktree 落在哪」，
 * 因此这里一次性取齐并在缺项时抛出可读错误，避免各处重复判断后给出含义不清的失败。
 */
export function gitActionContext(state: AppStore) {
  const thread = state.threads.find((item) => item.id === state.activeThreadId);
  const project = state.projects.find((item) => item.id === thread?.projectId);
  const workspacePath = effectiveWorkspacePath(state);
  if (!thread || !project?.path || !workspacePath || !state.cachePath) {
    throw new Error("项目目录、工作区或缓存目录不可用。");
  }
  return { thread, project, workspacePath, cachePath: state.cachePath };
}
