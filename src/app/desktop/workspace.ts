/** 桌面适配层：workspace。运行环境差异在此处理，界面只调用公开函数。 */
import { type ShellResult } from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ 工程执行工具 ============================ */

/** 工程执行工具的前置检查（开发者 Jan）：这些命令会读写本机项目文件，浏览器环境直接拒绝 */
export function requireDesktopWorkspace(): void {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器演示环境无法读取或修改本地项目，请在桌面端运行。");
  }
}

/** 读取工作区内某个文件的一段（开发者 Jan）：offset 从 1 开始、limit 为行数，都省略时按后端默认行数返回 */
export async function readWorkspaceFile(
  projectPath: string,
  path: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("workspace_read_file", { projectPath, path, offset, limit });
}

/** 写入工作区内的文件（开发者 Jan）：必须带 threadId / runId，后端据此登记检查点并回传 checkpointId */
export async function writeWorkspaceFile(
  cachePath: string,
  projectPath: string,
  threadId: string,
  runId: string,
  path: string,
  content: string,
): Promise<{ path: string; bytes: number; checkpointId: string }> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ path: string; bytes: number; checkpointId: string }>("workspace_write_file", {
    cachePath,
    projectPath,
    threadId,
    runId,
    path,
    content,
  });
}

/** 对工作区应用一份 unified diff 补丁（开发者 Jan）：与写入共用同一套检查点机制，撤销时能一并回滚本轮新增与修改 */
export async function applyWorkspacePatch(
  cachePath: string,
  projectPath: string,
  threadId: string,
  runId: string,
  patch: string,
): Promise<{ files: string[]; checkpointId: string }> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ files: string[]; checkpointId: string }>("workspace_apply_patch", {
    cachePath,
    projectPath,
    threadId,
    runId,
    patch,
  });
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

/** 在工作区内全文搜索（开发者 Jan）：返回命中文件、行号与该行内容，供模型定位代码 */
export async function searchWorkspaceCode(
  projectPath: string,
  query: string,
  limit?: number,
): Promise<WorkspaceSearchMatch[]> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WorkspaceSearchMatch[]>("workspace_search_code", { projectPath, query, limit });
}

export interface WorkspaceRuleFile {
  path: string;
  body: string;
}

export interface WorkspaceRuleSet {
  files: WorkspaceRuleFile[];
  content: string;
}

/**
 * 读取工作区内生效的项目规则（AGENTS.md）。
 *
 * 从工作区根目录逐层向下读取到 `target` 所在目录，越靠近目标的规则排在后面、优先级更高；
 * `target` 传相对路径（文件或目录），省略时只读取根目录规则。
 */
export async function loadWorkspaceRules(
  projectPath: string,
  target?: string | null,
): Promise<WorkspaceRuleSet> {
  if (!isDesktopRuntime()) return { files: [], content: "" };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WorkspaceRuleSet>("workspace_load_rules", { projectPath, target: target ?? null });
}

export type CommandDecision = "allow" | "ask" | "deny";

export interface CommandPolicyResult {
  decision: CommandDecision;
  reason: string;
}

/** 只做命令分类、不执行（开发者 Jan）：供前端在执行前展示处置档位与理由 */
export async function classifyWorkspaceCommand(
  command: string,
  trustReadOnly: boolean,
): Promise<CommandPolicyResult> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CommandPolicyResult>("workspace_classify_command", { command, trustReadOnly });
}

/** 在工作区内执行验证命令（开发者 Jan）：approved 表示用户是否已批准这条需确认的命令，后端会再校验一次 */
export async function runWorkspaceTests(
  projectPath: string,
  command: string,
  timeoutSecs: number | undefined,
  trustReadOnly: boolean,
  approved: boolean,
  sandbox?: { enabled: boolean; allowNetwork: boolean },
): Promise<ShellResult> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ShellResult>("workspace_test_runner", {
    projectPath,
    command,
    timeoutSecs,
    trustReadOnly,
    approved,
    sandboxEnabled: sandbox?.enabled ?? null,
    allowNetwork: sandbox?.allowNetwork ?? null,
  });
}

/** 回滚到某个检查点（开发者 Jan）：把本轮改动过的文件恢复成写入前的原样，返回实际恢复的文件清单 */
export async function rollbackWorkspaceCheckpoint(
  cachePath: string,
  projectPath: string,
  checkpointId: string,
): Promise<{ checkpointId: string; files: string[] }> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ checkpointId: string; files: string[] }>("workspace_rollback_checkpoint", {
    cachePath,
    projectPath,
    checkpointId,
  });
}
