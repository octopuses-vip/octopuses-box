/** git 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { readGitDiff } from "../../../project/git";
import { gitRepositoryInfo, stageGit, unstageGit, commitGit, pushGit } from "../../desktop/git";
import { effectiveWorkspacePath, gitActionContext } from "../workspace";

export const createGitSlice: StoreSlice<
  | "diffFiles"
  | "gitDiffStatus"
  | "gitDiffError"
  | "gitInfo"
  | "gitStatus"
  | "gitActionResult"
  | "gitActionError"
  | "loadGitDiff"
  | "refreshGit"
  | "stageChanges"
  | "unstageChanges"
  | "commitChanges"
  | "pushChanges"
> = (set, get) => ({
  // 右栏的项目差异只由真实 git 读取驱动，不从 mock 场景播种
  diffFiles: [],

  gitDiffStatus: "idle",

  gitDiffError: null,

  gitInfo: null,

  gitStatus: "idle",

  gitActionResult: null,

  gitActionError: null,

  // 差异不在启动时就拉：git 命令有成本，等用户真正要看（/diff 或切到差异 tab）时再读
  loadGitDiff: async () => {
    const workspacePath = effectiveWorkspacePath(get());
    if (!workspacePath) {
      set({ diffFiles: [], gitDiffStatus: "ready", gitDiffError: "尚未选择项目目录。" });
      return;
    }
    set({ gitDiffStatus: "loading", gitDiffError: null });
    try {
      const files = await readGitDiff(workspacePath);
      set({ diffFiles: files, gitDiffStatus: "ready", gitDiffError: null });
    } catch (error) {
      set({
        diffFiles: [],
        gitDiffStatus: "error",
        gitDiffError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  refreshGit: async () => {
    const workspacePath = effectiveWorkspacePath(get());
    if (!workspacePath) {
      set({ gitInfo: null, gitStatus: "ready" });
      return;
    }
    set({ gitStatus: "loading", gitActionError: null });
    try {
      const info = await gitRepositoryInfo(workspacePath);
      set({ gitInfo: info, gitStatus: "ready" });
    } catch (error) {
      set({
        gitInfo: null,
        gitStatus: "error",
        gitActionError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  stageChanges: async (path) => {
    try {
      const { project, workspacePath, cachePath } = gitActionContext(get());
      const result = await stageGit({
        cachePath,
        projectId: project.id,
        projectPath: project.path,
        workspacePath,
        path: path ?? null,
      });
      set({ gitActionResult: result, gitActionError: null });
      await Promise.all([get().refreshGit(), get().loadGitDiff()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ gitActionError: message });
      throw error;
    }
  },

  unstageChanges: async (path) => {
    try {
      const { project, workspacePath, cachePath } = gitActionContext(get());
      const result = await unstageGit({
        cachePath,
        projectId: project.id,
        projectPath: project.path,
        workspacePath,
        path: path ?? null,
      });
      set({ gitActionResult: result, gitActionError: null });
      await Promise.all([get().refreshGit(), get().loadGitDiff()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ gitActionError: message });
      throw error;
    }
  },

  commitChanges: async (message) => {
    try {
      const { project, workspacePath, cachePath } = gitActionContext(get());
      const result = await commitGit({
        cachePath,
        projectId: project.id,
        projectPath: project.path,
        workspacePath,
        message,
      });
      set({ gitActionResult: result, gitActionError: null });
      await Promise.all([get().refreshGit(), get().loadGitDiff()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      set({ gitActionError: text });
      throw error;
    }
  },

  pushChanges: async () => {
    try {
      const { project, workspacePath, cachePath } = gitActionContext(get());
      const branch = get().gitInfo?.branch;
      if (branch === "main" || branch === "master") {
        throw new Error("禁止直接推送 main/master，请使用任务分支。");
      }
      const result = await pushGit({
        cachePath,
        projectId: project.id,
        projectPath: project.path,
        workspacePath,
      });
      set({ gitActionResult: result, gitActionError: null });
      await get().refreshGit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ gitActionError: message });
      throw error;
    }
  }
});
