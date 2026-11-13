/**
 * Agent 工具白名单解析（开发者 Jan）。
 *
 * Agent 的 `tools` 声明用语很轻：既可以直接写类别键（`workspace` / `ssh` / `cv` / `vision` /
 * `control` / `mcp`）一次放行该类全部工具，也可以写单个工具名精确放行，
 * 还可以写 `*` 表示全量。空数组等同全量，用于向后兼容「不限制」的普通会话。
 *
 * 这里只做「工具名 → 是否放行」的判定，不关心工具表如何拼装；调用方（`useAgentRun`）在
 * 组装完 `availableTools` 后统一过一遍过滤器即可。
 */

import type { ChatTool } from "../model/client";
import { CONTROL_TOOL_NAMES } from "../tools/control";
import { CV_TOOLS } from "../tools/cv";
import { SSH_TOOLS } from "../tools/ssh";
import { VISION_TOOLS } from "../tools/vision";
import { WORKSPACE_TOOLS } from "../tools/workspace";

/** 类别键：写进白名单即放行该类下的全部工具 */
const CATEGORY_KEYS = ["workspace", "ssh", "cv", "vision", "control", "mcp"] as const;

/** MCP 工具名统一前缀（与 `src/mcp/tool.ts` 保持一致，用于动态匹配） */
const MCP_TOOL_PREFIX = "mcp_";

/** 从 ChatTool 数组取工具名 */
function toolNames(tools: ChatTool[]): string[] {
  return tools.map((tool) => tool.function.name);
}

/** 类别键 → 该类下的固定工具名集合（`mcp` 是动态前缀，不在此表） */
const CATEGORY_TOOL_NAMES: Record<"workspace" | "ssh" | "cv" | "vision" | "control", string[]> = {
  workspace: toolNames(WORKSPACE_TOOLS),
  ssh: toolNames(SSH_TOOLS),
  cv: toolNames(CV_TOOLS),
  vision: toolNames(VISION_TOOLS),
  control: [...CONTROL_TOOL_NAMES],
};

/**
 * 解析 Agent 的工具白名单，返回「工具名 → 是否放行」的判定函数（开发者 Jan）。
 *
 * 返回 `null` 表示不限制（全量工具）：`tools` 为空、或显式包含 `*` 时即为此语义，
 * 供未绑定 Agent 的普通会话与声明了 `*` 的 Agent 复用同一条通路。
 */
export function resolveToolFilter(
  tools: string[] | null | undefined,
): ((name: string) => boolean) | null {
  const items = (tools ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (items.length === 0 || items.includes("*")) return null;
  const names = new Set<string>();
  let allowMcp = false;
  for (const item of items) {
    switch (item) {
      case "workspace":
      case "ssh":
      case "cv":
      case "vision":
      case "control":
        for (const name of CATEGORY_TOOL_NAMES[item]) names.add(name);
        break;
      case "mcp":
        allowMcp = true;
        break;
      default:
        // 单个工具名精确放行
        names.add(item);
    }
  }
  return (name) =>
    names.has(name) ||
    (allowMcp && name.startsWith(MCP_TOOL_PREFIX));
}

/** 判断一个白名单条目是否为已知类别键（供界面提示用） */
export function isToolCategory(item: string): boolean {
  return (CATEGORY_KEYS as readonly string[]).includes(item.trim());
}