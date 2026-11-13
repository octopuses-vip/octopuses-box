import type { Project } from "../app/types";

/**
 * 首次使用时的项目列表。
 *
 * 刻意保持为空：项目即本机的一个真实目录，只有用户自己选择才有意义——
 * 预置任何示例项目都会指向不存在的路径，让差异读取、附加上下文与集成终端全部失效。
 * 用户新增的项目同样落在缓存目录之外，仅在本机持久化保存。
 */
export const INITIAL_PROJECTS: Project[] = [];

/**
 * 独立会话的归属标记（开发者 Jan）。
 *
 * 项目是多个任务共享的上下文与资源，会话则是独立临时的上下文，因此会话可以不挂在任何项目下：
 * 这类会话归入侧栏的「会话记录」。用空串而不是 `null`，与 `activeProjectId` 表示「无当前项目」
 * 的既有写法保持一致，序列化进会话库时也不必为可空字段额外分支。
 */
export const STANDALONE_PROJECT_ID = "";

/** 判断一个会话是否独立：独立会话不归属任何项目，只出现在「会话记录」里 */
export function isStandaloneThread(thread: { projectId: string }): boolean {
  return thread.projectId === STANDALONE_PROJECT_ID;
}

/**
 * 取路径的最后一段作为项目名。
 *
 * 目录选择器给出的是绝对路径，用户通常直接沿用它作为项目名；
 * Windows 与类 Unix 的分隔符都要兼容，因此不依赖 `node:path`。
 * 路径为空或只有分隔符时返回空串，由调用方决定兜底名称。
 */
export function projectNameFromPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}
