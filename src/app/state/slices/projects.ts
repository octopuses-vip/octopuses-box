/** projects 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { INITIAL_PROJECTS, STANDALONE_PROJECT_ID } from "../../../project/projects";
import { nextId } from "../../ids";
import { type Project } from "../../types";
import { persistProjects } from "../projects";

export const createProjectsSlice: StoreSlice<
  | "projects"
  | "addProject"
  | "projectDialogOpen"
  | "projectDialogEditId"
  | "openProjectDialog"
  | "closeProjectDialog"
  | "updateProject"
  | "removeProject"
> = (set, get) => ({
  projects: INITIAL_PROJECTS,

  addProject: (input) => {
    const project: Project = {
      id: nextId("proj"),
      name: input.name.trim().length > 0 ? input.name.trim() : "未命名项目",
      path: input.path.trim(),
      mcpIds: input.mcpIds ?? [],
      skillIds: input.skillIds ?? [],
      sshHostIds: input.sshHostIds ?? [],
      prompt: input.prompt?.trim() ?? "",
    };
    const projects = [...get().projects, project];
    set({ projects });
    persistProjects(get().cachePath, projects);
    return project.id;
  },

  projectDialogOpen: false,

  projectDialogEditId: null,

  openProjectDialog: (editId = null) =>
    set({ projectDialogOpen: true, projectDialogEditId: editId }),

  closeProjectDialog: () => set({ projectDialogOpen: false, projectDialogEditId: null }),

  updateProject: (id, patch) => {
    // 工作目录不在这里另写一份：所有取路径的地方都走 `effectiveWorkspacePath`，
    // 改完项目路径下一次读取自然跟着变，不需要在这里同步任何副本
    const projects = get().projects.map((project) =>
      project.id === id ? { ...project, ...patch } : project,
    );
    set({ projects });
    persistProjects(get().cachePath, projects);
  },

  removeProject: (id) => {
    const state = get();
    const projects = state.projects.filter((project) => project.id !== id);
    // 会话是独立临时的上下文，不该因为项目消失而丢：删项目只解除归属，
    // 其下的任务转为独立会话，留在「会话记录」里可继续打开
    const threads = state.threads.map((thread) =>
      thread.projectId === id ? { ...thread, projectId: STANDALONE_PROJECT_ID } : thread,
    );
    if (state.activeProjectId !== id) {
      set({ projects, threads });
      persistProjects(state.cachePath, projects);
      return;
    }
    // 删的是当前项目：当前会话仍在（已转为独立会话），留在原地打开；否则落到剩余项目的首条会话
    const fallback =
      threads.find((thread) => thread.id === state.activeThreadId) ??
      threads.find((thread) => thread.projectId === projects[0]?.id) ??
      threads[0];
    const activeProjectId = fallback?.projectId ?? STANDALONE_PROJECT_ID;
    set({
      projects,
      threads,
      activeThreadId: fallback?.id ?? "",
      activeProjectId,
    });
    persistProjects(state.cachePath, projects);
  }
});
