import { useAppStore } from "../app/state";
import { BUILTIN_TOOL_GROUPS, type BuiltinToolGroup } from "../tools/catalog";

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

/**
 * 工具总览页（开发者 Jan）：集中展示客户端所有内置工具。
 *
 * 内置工具此前只存在于代码里，用户在界面上看不到「browser_cdp 是什么、什么时候挂载」，
 * 只能靠模型的行为反推。本页按 `BUILTIN_TOOL_GROUPS` 分组列全：
 * - 描述与模型看到的 `function.description` 同源，
 *   页面上看什么、模型就知道什么，避免两处说明各写各的；
 * - 每行提供启停开关（落 store 的 `disabledToolIds`，挂载时由 `filterDisabledTools` 摘除）。
 *
 * MCP 工具不在此页展示：它们来自用户在「MCP」页配置的服务，启停与管理都在该页完成。
 */
export function ToolsPage() {
  const disabledToolIds = useAppStore((state) => state.disabledToolIds);
  const toggleTool = useAppStore((state) => state.toggleTool);

  const builtinCount = BUILTIN_TOOL_GROUPS.reduce((sum, group) => sum + group.tools.length, 0);

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          内置工具随客户端发布、按运行条件自动挂载（如平台、项目目录、模型能力），可在此停用或重新启用。
          MCP 工具来自「MCP」页配置的服务，在该页管理，不在此展示。
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
      </div>
    </div>
  );
}
