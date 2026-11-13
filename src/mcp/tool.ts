/**
 * MCP 工具：把「启用的 MCP 服务」暴露的工具包装成模型可调用的函数。
 *
 * 工具名形如 `mcp_<服务id>__<工具名>`；模型调用时由前端把参数通过 Rust 命令交给本地
 * MCP 进程执行，返回文本原样回填给模型。因为要 spawn 本地进程，实际调用仅在桌面端可用
 * （见 `src/app/desktop.ts` 的 `callMcpTool`）。
 */

import type { McpServer, McpTool } from "../app/types";
import type { ChatTool } from "../model/client";

/** MCP 工具名统一前缀，避免与内置工具重名 */
const TOOL_PREFIX = "mcp_";
/** 服务 id 与工具名之间的分隔符：双下划线，避免与工具名里的单下划线混淆 */
const SEPARATOR = "__";
/** 注入模型上下文的工具说明上限 */
const DESCRIPTION_LIMIT = 2_000;

/** 把任意文本规整成合法且稳定的函数名片段 */
function sanitize(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "tool";
}

/** 模型侧工具名：`mcp_<服务id>__<工具名>` */
export function mcpToolName(server: McpServer, tool: McpTool): string {
  return `${TOOL_PREFIX}${sanitize(server.id)}${SEPARATOR}${sanitize(tool.name)}`;
}

/** 一条可调用的 MCP 工具绑定：模型工具名 ↔ 服务与本名 */
export interface McpToolBinding {
  server: McpServer;
  tool: McpTool;
  chatTool: ChatTool;
}

/** 把某个服务的一个工具包装成模型工具 */
export function toMcpTool(server: McpServer, tool: McpTool): ChatTool {
  const description = [
    `MCP 服务「${server.name}」提供的工具 ${tool.name}。`,
    tool.description.trim(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const clipped =
    description.length > DESCRIPTION_LIMIT
      ? `${description.slice(0, DESCRIPTION_LIMIT)}\n…（说明过长已截断）`
      : description;
  return {
    type: "function",
    function: {
      name: mcpToolName(server, tool),
      description: clipped,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

/** 根据「已启用服务」与各自的工具表建出可调用绑定，供运行期挂载与分发 */
export function buildMcpBindings(
  servers: McpServer[],
  toolsByServer: Record<string, McpTool[]>,
): McpToolBinding[] {
  const bindings: McpToolBinding[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    for (const tool of toolsByServer[server.id] ?? []) {
      bindings.push({ server, tool, chatTool: toMcpTool(server, tool) });
    }
  }
  return bindings;
}

/** 按模型返回的工具名反查绑定；未命中返回 null */
export function findMcpBinding(bindings: McpToolBinding[], name: string): McpToolBinding | null {
  const target = name.trim();
  return bindings.find((binding) => binding.chatTool.function.name === target) ?? null;
}

/** 已启用 MCP 工具的提示：列出可调用的工具名 */
export function buildMcpToolHint(bindings: McpToolBinding[]): string {
  if (bindings.length === 0) return "";
  const names = bindings
    .map(
      (binding) =>
        `${binding.chatTool.function.name}（${binding.server.name} / ${binding.tool.name}）`,
    )
    .join("、");
  return (
    `已启用 MCP 工具：${names}。需要时直接调用，参数按各工具说明填写；` +
    "这些是本项目绑定的 MCP 工具，对应能力优先用它们，不要改用联网检索或远程主机。"
  );
}
