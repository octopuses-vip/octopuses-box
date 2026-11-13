/** 桌面适配层：agents。运行环境差异在此处理，界面只调用公开函数。 */
import { type AgentItem } from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ Agent ============================ */

/**
 * 扫描 Agent 目录并刷新索引（开发者 Jan）：Agent 统一放在缓存目录下的
 * `agents/<agentId>/AGENT.md`，索引写入缓存目录根部的 `AGENTS.md`。
 *
 * 桌面端走 Rust 命令读取本地文件；浏览器演示环境无法读盘，返回空列表。
 */
export async function scanAgents(cachePath: string | null): Promise<AgentItem[]> {
  if (!cachePath) return [];
  if (!isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentItem[]>("scan_agents", { cacheDir: cachePath });
}

/** 新建 / 更新 Agent 的入参（字段与 AGENT.md 的 frontmatter 一一对应） */
export interface AgentInput {
  id: string;
  name: string;
  description: string;
  model: string;
  tools: string[];
  permissionMode: string;
  systemAppend: string;
  overwrite: boolean;
}

/** 更新 Agent 入参：额外带 `originalId`，支持改 id（改名目录） */
export interface AgentUpdateInput extends AgentInput {
  originalId: string;
}

/** Agent 生命周期管理的前置检查（开发者 Jan）：这些命令要在本机建目录、删目录，浏览器环境直接拒绝 */
export function requireDesktopAgents(): void {
  if (!isDesktopRuntime()) throw new Error("Agent 本地生命周期管理仅在桌面端可用，请在桌面端运行。");
}

/** 新建 Agent（开发者 Jan）：在缓存目录下建 `agents/<id>/AGENT.md` 并重建索引，返回最新列表 */
export async function createAgent(cachePath: string | null, input: AgentInput): Promise<AgentItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法创建 Agent。");
  requireDesktopAgents();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentItem[]>("create_agent", { cacheDir: cachePath, input });
}

/**
 * 更新 Agent（开发者 Jan）。
 *
 * 带上 `originalId` 是为了支持改 id：Rust 侧先校验新 id 合法、再改名目录，
 * 校验不过时保留原目录，避免出现「旧目录已删、新目录没建成」的空窗。
 */
export async function updateAgent(cachePath: string | null, input: AgentUpdateInput): Promise<AgentItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法更新 Agent。");
  requireDesktopAgents();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentItem[]>("update_agent", { cacheDir: cachePath, input });
}

/** 删除 Agent（开发者 Jan）：连带删除其目录并重建索引，返回删除后的列表 */
export async function deleteAgent(cachePath: string | null, id: string): Promise<AgentItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法删除 Agent。");
  requireDesktopAgents();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentItem[]>("delete_agent", { cacheDir: cachePath, input: { id } });
}
