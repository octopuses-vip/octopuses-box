/** 桌面适配层：git。运行环境差异在此处理，界面只调用公开函数。 */
import { isDesktopRuntime } from "./runtime";

/* ============================ Git 与 worktree ============================ */

export interface GitCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRepositoryInfo {
  isRepository: boolean;
  branch: string | null;
  head: string | null;
  clean: boolean;
  status: string[];
  upstream: string | null;
  origin: string | null;
  compareUrl: string | null;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  result: GitCommandResult;
}

/** Git 管理的前置检查（开发者 Jan）：所有 git 命令都要在项目目录里跑子进程，浏览器环境直接拒绝 */
export function requireDesktopGit(): void {
  if (!isDesktopRuntime()) throw new Error("Git 管理仅在桌面端可用。");
}

/**
 * 调用一个 Git 相关后端命令（开发者 Jan）。
 *
 * 把「运行时检查 + 动态 import」收敛到一处：下面每个 Git 操作都是薄封装，
 * 统一走这里可以避免逐个函数重复写样板代码。
 */
export async function invokeGit<T>(command: string, args: Record<string, unknown>): Promise<T> {
  requireDesktopGit();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** 读取仓库概况（开发者 Jan）：当前分支、是否有 upstream、比较链接等，供右栏「差异」tab 顶部展示 */
export function gitRepositoryInfo(workspacePath: string): Promise<GitRepositoryInfo> {
  return invokeGit("git_repository_info", { workspacePath });
}

/** 读取工作区未提交改动的 unified diff 原文（开发者 Jan），由前端解析成逐行差异 */
export function readGitDiffText(workspacePath: string): Promise<string> {
  return invokeGit("git_read_diff", { workspacePath });
}

/** 列出本项目已创建的 Git Worktree（开发者 Jan），用于会话级独立执行目录的选择与清理 */
export function listGitWorktrees(projectPath: string): Promise<GitWorktree[]> {
  return invokeGit("git_list_worktrees", { projectPath });
}

/**
 * 为某个会话创建独立 Worktree（开发者 Jan），让该会话的工程改动不污染项目主目录。
 *
 * 分支名由后端按项目与会话信息生成，返回的 `path` 即该会话的有效工作区。
 */
export function createGitWorktree(input: {
  cachePath: string;
  projectId: string;
  projectPath: string;
  threadId: string;
  title: string;
}): Promise<CreatedWorktree> {
  return invokeGit("git_create_worktree", input);
}

/**
 * 删除一个 Worktree（开发者 Jan）。
 *
 * `force` 为 false 时若目录里还有未提交改动，git 会拒绝删除；
 * 因此这里把是否强制交给调用方决定，避免误删用户没保存的工作。
 */
export function removeGitWorktree(input: {
  cachePath: string;
  projectId: string;
  projectPath: string;
  worktreePath: string;
  force: boolean;
}): Promise<GitCommandResult> {
  return invokeGit("git_remove_worktree", input);
}

/** 暂存改动（开发者 Jan）：`path` 为 null 表示全部暂存，否则只暂存该文件 */
export function stageGit(input: {
  cachePath: string;
  projectId: string;
  projectPath: string;
  workspacePath: string;
  path: string | null;
}): Promise<GitCommandResult> {
  return invokeGit("git_stage", input);
}

/** 取消暂存（开发者 Jan）：`path` 为 null 表示全部取消，否则只针对该文件 */
export function unstageGit(input: {
  cachePath: string;
  projectId: string;
  projectPath: string;
  workspacePath: string;
  path: string | null;
}): Promise<GitCommandResult> {
  return invokeGit("git_unstage", input);
}

/** 提交已暂存的改动（开发者 Jan）：提交信息由用户显式填写，这里不做自动生成 */
export function commitGit(input: {
  cachePath: string;
  projectId: string;
  projectPath: string;
  workspacePath: string;
  message: string;
}): Promise<GitCommandResult> {
  return invokeGit("git_commit", input);
}

/**
 * 推送当前任务分支（开发者 Jan）。
 *
 * 无 upstream 时后端会自动设置 origin；`main` / `master` 的直推由前后端共同拒绝，
 * 因此这里不需要再判一次分支名。
 */
export function pushGit(input: {
  cachePath: string;
  projectId: string;
  projectPath: string;
  workspacePath: string;
}): Promise<GitCommandResult> {
  return invokeGit("git_push", input);
}
