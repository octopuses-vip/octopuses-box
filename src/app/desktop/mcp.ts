/** 桌面适配层：mcp。运行环境差异在此处理，界面只调用公开函数。 */
import { type McpServer, type McpTool, type McpCallResult } from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ MCP 服务 ============================ */

/**
 * MCP（Model Context Protocol）服务：配置落盘在缓存目录的 `mcp/servers.json`，
 * 由 Rust 侧 spawn 本地进程、通过 stdio 上的换行分隔 JSON-RPC 完成握手与调用。
 *
 * 列工具与调工具都必须在本机执行子进程，因此仅在桌面端可用；浏览器演示环境返回空列表。
 */
export interface McpServerInput {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  overwrite: boolean;
}

/** MCP 服务管理的前置检查（开发者 Jan）：列工具与调工具都要在本机 spawn 子进程，浏览器环境直接拒绝 */
export function requireDesktopMcp(): void {
  if (!isDesktopRuntime()) throw new Error("MCP 服务管理仅在桌面端可用，请在桌面端运行。");
}

/** 读取 MCP 服务清单（开发者 Jan）：配置文件不存在时返回空列表，而非报错 */
export async function listMcpServers(cachePath: string | null): Promise<McpServer[]> {
  if (!cachePath || !isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<McpServer[]>("mcp_list_servers", { cacheDir: cachePath });
}

/**
 * 新增或更新一个 MCP 服务（开发者 Jan）。
 *
 * `overwrite` 为 false 时遇到同 id 会报错，避免悄悄覆盖用户已有的服务配置
 * （命令与 env 往往带着本机路径与密钥，误覆盖的代价较高）。
 */
export async function saveMcpServer(cachePath: string | null, input: McpServerInput): Promise<McpServer[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法保存 MCP 服务。");
  requireDesktopMcp();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<McpServer[]>("mcp_save_server", { cacheDir: cachePath, input });
}

/** 删除一个 MCP 服务（开发者 Jan）：只改配置，不会去杀正在运行的进程 */
export async function deleteMcpServer(cachePath: string | null, id: string): Promise<McpServer[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法删除 MCP 服务。");
  requireDesktopMcp();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<McpServer[]>("mcp_delete_server", { cacheDir: cachePath, input: { id } });
}

/** 列出一个服务声明的工具；失败原因作为可读文本抛出，由页面展示 */
export async function listMcpTools(cachePath: string | null, serverId: string): Promise<McpTool[]> {
  if (!cachePath || !isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<McpTool[]>("mcp_list_tools", { cacheDir: cachePath, serverId });
}

/** 调用一个服务上的工具；argumentsJson 是模型给出的参数 JSON 文本 */
export async function callMcpTool(
  cachePath: string | null,
  serverId: string,
  tool: string,
  argumentsJson: string,
): Promise<McpCallResult> {
  if (!cachePath) return { ok: false, output: "尚未配置缓存目录，无法调用 MCP 工具。" };
  if (!isDesktopRuntime()) {
    return { ok: false, output: "MCP 工具调用仅在桌面端可用，请在桌面端运行。" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<McpCallResult>("mcp_call_tool", {
      cacheDir: cachePath,
      serverId,
      tool,
      argumentsJson,
    });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
