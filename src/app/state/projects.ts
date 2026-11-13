/** 状态辅助层：projects。不依赖 Store 实例，调用方显式传入上下文。 */
import { writeCacheFile } from "../desktop/cache";
import { type Project } from "../types";

export const PROJECTS_FILE = "projects.json";

/** 函数级说明（开发者 Jan）：执行 parseCachedProjects 的单一职责，并返回可供调用方继续处理的结果。 */
export function parseCachedProjects(raw: string | null): Project[] | undefined | null {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is Project => {
      if (typeof item !== "object" || item === null) return false;
      const project = item as Partial<Project>;
      return typeof project.id === "string" && typeof project.name === "string" && typeof project.path === "string";
    }).map((project) => ({
      ...project,
      mcpIds: Array.isArray(project.mcpIds) ? project.mcpIds.filter((id): id is string => typeof id === "string") : [],
      skillIds: Array.isArray(project.skillIds) ? project.skillIds.filter((id): id is string => typeof id === "string") : [],
      sshHostIds: Array.isArray(project.sshHostIds) ? project.sshHostIds.filter((id): id is string => typeof id === "string") : [],
      prompt: typeof project.prompt === "string" ? project.prompt : "",
    }));
  } catch {
    return null;
  }
}

/** 函数级说明（开发者 Jan）：执行 persistProjects 的单一职责，并返回可供调用方继续处理的结果。 */
export function persistProjects(cachePath: string | null, projects: Project[]): void {
  if (!cachePath) return;
  void writeCacheFile(cachePath, PROJECTS_FILE, JSON.stringify(projects, null, 2)).catch(() => { });
}

/**
 * 取当前生效的项目 id。
 *
 * 项目列表是用户数据（在左栏项目行里增删改），若当前项目的 id 已不在列表里（例如被删除后
 * 又读回了旧会话），退回列表首项，避免新会话挂到一个不存在的项目上。
 * 独立会话（[`STANDALONE_PROJECT_ID`]）不走这里：它本就没有归属，见 `restoreSessions`。
 */
export function resolveProjectId(projects: Project[], current: string): string {
  if (projects.some((project) => project.id === current)) return current;
  return projects[0]?.id ?? "";
}
