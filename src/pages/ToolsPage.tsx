import { useEffect } from "react";

import { useAppStore } from "../app/state";
import { BUILTIN_TOOL_GROUPS, type BuiltinToolGroup } from "../tools/catalog";
import { mcpToolName } from "../mcp/tool";
import type { McpServer, McpTool } from "../app/types";

/** 一行工具展示：mono 工具名 + 描述（描述可能多行，保留换行） */
function ToolRow({ name, description }: { name: string; description: string }) {
  return (
    <div className="list-row list-row--top" style={{ alignItems: "flex-start" }}>
      <span className="list-row__title mono" style={{ minWidth: 160 }}>
        {name}
      </span>
      <span className="list-row__desc" style={{ whiteSpace: "pre-line" }}>
        {description}
      </span>
    </div>
  );
}

/**
 * 一行内置工具展示（开发者 Jan）：名称 + 描述 + 启停开关。
 *
 * 停用后该工具不再挂进模型工具表（下轮对话生效），页面上用「已停用」徽标标示；
 * 开关直接落 store 的 `disabledToolIds`，随设备偏好持久化。
 */
function BuiltinToolRow({ name, description, disabled, onToggle }: {
  name: string;
  description: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="list-row list-row--top" style={{ alignItems: "flex-start" }}>
      <span className="list-row__title mono" style={{ minWidth: 160 }}>
        {name}
      </span>
      <span className="list-row__desc" style={{ whiteSpace: "pre-line", flex: 1 }}>
        {description}
      </span>
      {disabled ? <span className="badge">已停用</span> : null}
      <button
        type="button"
        className={disabled ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
        onClick={onToggle}
      >
        {disabled ? "启用" : "停用"}
      </button>
    </div>
  );
}

/** 一组内置工具：组标题 + 挂载条件 + 工具行（每行带启停开关） */
function BuiltinGroupSection({ group, disabledNames, onToggle }: {
  group: BuiltinToolGroup;
  disabledNames: string[];
  onToggle: (name: string) => void;
}) {
  return (
    <div className="page__section">
      <div className="page__section-label">
        {group.title}
        <span className="list-row__desc" style={{ marginLeft: 8, fontWeight: 400 }}>
          挂载条件：{group.condition}
        </span>
      </div>
      <div>
        {group.tools.map((tool) => (
          <BuiltinToolRow
            key={tool.function.name}
            name={tool.function.name}
            description={tool.function.description}
            disabled={disabledNames.includes(tool.function.name)}
            onToggle={() => onToggle(tool.function.name)}
          />
        ))}
      </div>
    </div>
  );
}

/** 一条启用的 MCP 服务的工具列表：展示真实函数名（mcp_<服务id>__<工具名>） */
function McpServerTools({ server, tools }: { server: McpServer; tools: McpTool[] }) {
  if (!server.enabled || tools.length === 0) return null;
  return (
    <div className="page__section">
      <div className="page__section-label">
        {server.name}
        <span className="list-row__desc mono" style={{ marginLeft: 8, fontWeight: 400 }}>
          {server.id}
        </span>
        <span className="list-row__desc" style={{ marginLeft: 8, fontWeight: 400 }}>
          共 {tools.length} 个工具
        </span>
      </div>
      <div>
        {tools.map((tool) => (
          <ToolRow key={tool.name} name={mcpToolName(server, tool)} description={tool.description} />
        ))}
      </div>
    </div>
  );
}

/**
 * 工具总览页（开发者 Jan）：把客户端所有可能挂给模型的工具集中展示，内置工具也在其中。
 *
 * 内置工具此前只存在于代码里，用户在界面上看不到「browser_cdp 是什么、什么时候挂载」，
 * 只能靠模型的行为反推。本页按「内置 → MCP」两段列全：
 * - 内置工具取自 `BUILTIN_TOOL_GROUPS`，描述与模型看到的 `function.description` 同源，
 *   且每行提供启停开关（落 store 的 `disabledToolIds`，挂载时由 `filterDisabledTools` 摘除）；
 * - MCP 工具来自已启用服务的 `tools/list` 结果（与运行期同一份 store 状态）。
 * MCP 段只读，管理入口在 MCP 主页。
 */
export function ToolsPage() {
  const mcpServers = useAppStore((state) => state.mcpServers);
  const mcpTools = useAppStore((state) => state.mcpTools);
  const mcpStatus = useAppStore((state) => state.mcpStatus);
  const loadMcpServers = useAppStore((state) => state.loadMcpServers);
  const disabledToolIds = useAppStore((state) => state.disabledToolIds);
  const toggleTool = useAppStore((state) => state.toggleTool);

  // 进入页面时刷新 MCP 清单，保证工具列表与最新配置一致
  useEffect(() => {
    void loadMcpServers();
  }, [loadMcpServers]);

  const builtinCount = BUILTIN_TOOL_GROUPS.reduce((sum, group) => sum + group.tools.length, 0);
  const mcpCount = mcpServers
    .filter((server) => server.enabled)
    .reduce((sum, server) => sum + (mcpTools[server.id]?.length ?? 0), 0);

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          模型在会话里能调用的工具分两类：内置工具随客户端发布、按运行条件自动挂载（如平台、项目目录、
          模型能力），可在此停用或重新启用；MCP 工具来自「MCP」页配置的服务。
          工具描述与模型看到的一致；停用内置工具后下轮对话即不再挂载。
        </p>

        <div className="page__section">
          <div className="page__section-label">
            内置工具
            <span className="list-row__desc" style={{ marginLeft: 8, fontWeight: 400 }}>
              共 {builtinCount} 个 · 已停用 {disabledToolIds.length} 个，按挂载条件分组
            </span>
          </div>
        </div>
        {BUILTIN_TOOL_GROUPS.map((group) => (
          <BuiltinGroupSection key={group.title} group={group} disabledNames={disabledToolIds} onToggle={toggleTool} />
        ))}

        <div className="page__section">
          <div className="page__section-label">
            MCP 工具
            <span className="list-row__desc" style={{ marginLeft: 8, fontWeight: 400 }}>
              已启用服务共提供 {mcpCount} 个工具{mcpStatus === "loading" ? " · 刷新中…" : ""}
            </span>
          </div>
          {mcpServers.filter((server) => server.enabled).length === 0 ? (
            <div className="list-row">
              <span className="list-row__desc">还没有启用的 MCP 服务。到「MCP」页新建并启用后，工具会显示在这里。</span>
            </div>
          ) : (
            mcpServers
              .filter((server) => server.enabled)
              .map((server) => (
                <McpServerTools key={server.id} server={server} tools={mcpTools[server.id] ?? []} />
              ))
          )}
        </div>
      </div>
    </div>
  );
}
