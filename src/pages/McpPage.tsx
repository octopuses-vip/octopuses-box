import { useEffect, useState } from "react";

import { callMcpTool } from "../app/desktop/mcp";
import { confirmDelete, confirmOverwrite } from "../app/confirmations";
import { useAppStore } from "../app/state";
import { useConfirm } from "../components/ConfirmProvider";
import { Icon } from "../components/Icon";
import { mcpToolName } from "../mcp/tool";
import type { McpServer, McpTool } from "../app/types";

const EMPTY_FORM = {
  id: "",
  name: "",
  command: "",
  args: "",
  env: "",
  enabled: true,
};

/** 参数/环境变量按行输入：每行一个参数、每行一个 `KEY=VALUE` */
function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 解析 KEY=VALUE 形式的环境变量文本（开发者 Jan）：忽略空行与无等号的行，值里的等号保留 */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

/** 把环境变量渲染成 KEY=VALUE 文本（开发者 Jan）：每行一条，便于用户直接编辑 */
function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** 单个服务的手动调用面板：选工具、填参数、跑一次，用于自检链路是否打通 */
function ToolTester({ serverId, tools }: { serverId: string; tools: McpTool[] }) {
  const cachePath = useAppStore((state) => state.cachePath);
  const [tool, setTool] = useState(tools[0]?.name ?? "");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // 工具列表变化（重新拉取/停用）时把选择收敛到仍然存在的项
  useEffect(() => {
    if (!tools.some((item) => item.name === tool)) setTool(tools[0]?.name ?? "");
  }, [tools, tool]);

/** 函数级说明（开发者 Jan）：执行 run 的单一职责，并返回可供调用方继续处理的结果。 */
  const run = async () => {
    if (!tool) return;
    setRunning(true);
    setResult(null);
    const outcome = await callMcpTool(cachePath, serverId, tool, args);
    setResult(`${outcome.ok ? "成功" : "失败"}：${outcome.output}`);
    setRunning(false);
  };

  if (tools.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          className="form__input"
          value={tool}
          onChange={(event) => setTool(event.target.value)}
        >
          {tools.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={running || !cachePath}
          onClick={() => void run()}
        >
          {running ? "调用中…" : "试调用"}
        </button>
      </div>
      <textarea
        className="form__textarea"
        rows={2}
        value={args}
        placeholder='参数 JSON，例如 {"path": "/tmp"}'
        onChange={(event) => setArgs(event.target.value)}
      />
      {result ? <div className="card__desc mono">{result}</div> : null}
    </div>
  );
}

/**
 * MCP 服务管理：配置缓存目录下 `mcp/servers.json` 中的本地 MCP 服务。
 * 启用的服务会列出其工具（`tools/list`）并包装成模型可调用的函数；停用后立即从工具表移除。
 */
export function McpPage() {
  const cachePath = useAppStore((state) => state.cachePath);
  const servers = useAppStore((state) => state.mcpServers);
  const tools = useAppStore((state) => state.mcpTools);
  const status = useAppStore((state) => state.mcpStatus);
  const error = useAppStore((state) => state.mcpError);
  const toolsStatus = useAppStore((state) => state.mcpToolsStatus);
  const toolsError = useAppStore((state) => state.mcpToolsError);
  const mutationStatus = useAppStore((state) => state.mcpMutationStatus);
  const mutationError = useAppStore((state) => state.mcpMutationError);
  const loadServers = useAppStore((state) => state.loadMcpServers);
  const toggleServer = useAppStore((state) => state.toggleMcpServer);
  const saveServer = useAppStore((state) => state.saveMcpServer);
  const deleteServer = useAppStore((state) => state.deleteMcpServer);
  const confirm = useConfirm();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const enabledCount = servers.filter((server) => server.enabled).length;
  const loading = status === "loading";
  const mutating = mutationStatus === "loading";
  /** 三个必填项齐了才允许保存：与 submit 里的前置校验同一口径，避免点了没反应（开发者 Jan） */
  const canSubmit = Boolean(form.id.trim() && form.name.trim() && form.command.trim());

  // 每次进入 MCP 页都重新读取配置并刷新工具
  useEffect(() => {
    void loadServers();
  }, [loadServers]);

/** 函数级说明（开发者 Jan）：执行 openCreate 的单一职责，并返回可供调用方继续处理的结果。 */
  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 openEdit 的单一职责，并返回可供调用方继续处理的结果。 */
  const openEdit = (server: McpServer) => {
    setEditingId(server.id);
    setForm({
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args.join("\n"),
      env: formatEnv(server.env),
      enabled: server.enabled,
    });
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = async () => {
    if (!form.id.trim() || !form.name.trim() || !form.command.trim()) return;
    const idChanged = editingId !== null && editingId !== form.id.trim();
    let allowOverwrite = overwrite;
    if ((editingId === null || idChanged) && !allowOverwrite) {
      const conflict = servers.some((server) => server.id === form.id.trim());
      if (conflict && !(await confirmOverwrite(confirm, "目标服务"))) return;
      if (conflict) {
        setOverwrite(true);
        allowOverwrite = true;
      }
    }
    try {
      await saveServer({
        id: form.id.trim(),
        name: form.name.trim(),
        command: form.command.trim(),
        args: parseArgs(form.args),
        env: parseEnv(form.env),
        enabled: form.enabled,
        // 重命名按「新建」处理：后端 id 是唯一键，改名等同换了一条服务；
        // 编辑既有服务本身就是对该条记录的显式确认（id 在编辑态不可改），必须带上 overwrite
        overwrite: allowOverwrite || editingId !== null,
      });
      setFormOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      // 错误由页面状态展示
    }
  };

/** 函数级说明（开发者 Jan）：执行 remove 的单一职责，并返回可供调用方继续处理的结果。 */
  const remove = async (server: McpServer) => {
    if (!(await confirmDelete(confirm, "MCP 服务", server.name))) return;
    try {
      await deleteServer(server.id);
    } catch {
      // 错误由页面状态展示
    }
  };

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          MCP 服务配置保存在缓存目录下的 mcp/servers.json（当前：
          {cachePath ? `${cachePath}/mcp` : "尚未配置缓存目录"}）。启用的服务会通过 stdio 启动本地进程，
          列出其工具并包装成模型可调用的函数，工具名形如 mcp_&lt;服务id&gt;__&lt;工具名&gt;。
        </p>

        <div className="page__section">
          <div className="page__section-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>
              已配置 {servers.length} · 已启用 {enabledCount}
            </span>
            <span className="spacer" />
            <button type="button" className="btn btn--primary btn--sm" disabled={mutating || !cachePath} onClick={openCreate}>新建</button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={loading || toolsStatus === "loading"}
              onClick={() => void loadServers()}
            >
              {loading || toolsStatus === "loading" ? "刷新中…" : "重新扫描"}
            </button>
          </div>

          {!cachePath ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">请先配置缓存目录后再管理 MCP 服务。</span>
            </div>
          ) : null}
          {mutationError ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">操作失败：{mutationError}</span>
            </div>
          ) : null}
          {error ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">读取配置失败：{error}</span>
            </div>
          ) : null}
          {toolsError ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">部分服务列工具失败：{toolsError}</span>
            </div>
          ) : null}

          {formOpen ? (
            <div className="card form-card" style={{ marginBottom: 16 }}>
              <div className="card__head">
                <Icon name="terminal" size={14} />
                <span className="card__title">{editingId ? "编辑 MCP 服务" : "新建 MCP 服务"}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  title="关闭"
                  disabled={mutating}
                  onClick={() => setFormOpen(false)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>

              {/* 基本信息：决定这条服务在列表里的身份，id 同时是保存时的唯一键 */}
              <div className="form__section">
                <div className="form__section-title">基本信息</div>
                <div className="form__grid">
                  <label className="form__row">
                    <span className="form__label">
                      id<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input mono"
                      value={form.id}
                      disabled={Boolean(editingId)}
                      placeholder="如 chrome-devtools"
                      onChange={(event) => setForm({ ...form, id: event.target.value })}
                    />
                    <span className="form__hint">单层目录名，作为唯一标识；保存后不可修改</span>
                  </label>
                  <label className="form__row">
                    <span className="form__label">
                      名称<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input"
                      value={form.name}
                      placeholder="展示用名称"
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                    <span className="form__hint">列表与工具说明里显示的名字</span>
                  </label>
                </div>
              </div>

              {/* 启动配置：客户端就靠这三项拼出 stdio 启动方式 */}
              <div className="form__section">
                <div className="form__section-title">启动配置</div>
                <label className="form__row">
                  <span className="form__label">
                    启动命令<span className="form__required">*</span>
                  </span>
                  <input
                    className="form__input mono"
                    value={form.command}
                    placeholder="如 uvx，或某个 .exe 的完整路径"
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                  />
                  <span className="form__hint">可执行文件路径，或 PATH 中的命令名；不支持 .cmd / .bat 脚本</span>
                </label>
                <div className="form__grid">
                  <label className="form__row">
                    <span className="form__label">启动参数</span>
                    <textarea
                      className="form__textarea mono"
                      rows={3}
                      value={form.args}
                      placeholder={"每行一个参数\n例如：\nwindows-mcp\nserve"}
                      onChange={(event) => setForm({ ...form, args: event.target.value })}
                    />
                    <span className="form__hint">每行一个参数，按行逐项传给进程</span>
                  </label>
                  <label className="form__row">
                    <span className="form__label">环境变量</span>
                    <textarea
                      className="form__textarea mono"
                      rows={3}
                      value={form.env}
                      placeholder={"每行一个 KEY=VALUE\n例如：\nAPI_KEY=sk-xxx"}
                      onChange={(event) => setForm({ ...form, env: event.target.value })}
                    />
                    <span className="form__hint">每行一个 KEY=VALUE，随进程启动注入</span>
                  </label>
                </div>
              </div>

              {/* 状态：启用即拉起进程并列工具，工具随即对模型可见 */}
              <div className="form__section">
                <div className="form__section-title">状态</div>
                <div className="form__toggle-row">
                  <div>
                    <div className="form__label">启用该服务</div>
                    <div className="form__hint">启用后立即启动进程并列出工具，包装成模型可调用的函数</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.enabled}
                    aria-label="启用该服务"
                    className={form.enabled ? "switch switch--on" : "switch"}
                    onClick={() => setForm({ ...form, enabled: !form.enabled })}
                  >
                    <span className="switch__knob" />
                  </button>
                </div>
              </div>

              <div className="form__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={mutating}
                  onClick={() => setFormOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={mutating || !canSubmit}
                  onClick={() => void submit()}
                >
                  {mutating ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ) : null}

          {servers.length === 0 ? (
            <div className="list-row" style={{ marginBottom: 0 }}>
              <span className="list-row__desc">
                {loading ? "正在读取 MCP 配置…" : "还没有配置 MCP 服务。新建一条并填写启动命令即可。"}
              </span>
            </div>
          ) : (
            <div>
              {servers.map((server) => {
                const serverTools = tools[server.id] ?? [];
                return (
                  <div className="list-row list-row--top" key={server.id}>
                    <Icon name="terminal" size={15} />
                    <div className="list-row__main">
                      <span className="list-row__title">{server.name}</span>
                      <span className="list-row__desc mono">
                        {[server.command, ...server.args].join(" ")}
                      </span>
                      <span className="list-row__desc">
                        {server.enabled
                          ? serverTools.length > 0
                            ? `工具（${serverTools.length}）：${serverTools.map((tool) => tool.name).join("、")}`
                            : "尚未获取到工具（可重新扫描）"
                          : "已停用：不向模型暴露工具"}
                      </span>
                      {server.enabled && serverTools.length > 0 ? (
                        <span className="list-row__desc mono">
                          {mcpToolName(server, serverTools[0])}
                          {serverTools.length > 1 ? " …" : ""}
                        </span>
                      ) : null}
                      {/* 试调用需要下拉框与多行参数，放进主区域纵向排开；行本身不承载表单结构 */}
                      {server.enabled && cachePath ? (
                        <ToolTester serverId={server.id} tools={serverTools} />
                      ) : null}
                    </div>
                    {server.enabled ? <span className="badge badge--ok">已启用</span> : <span className="badge">已停用</span>}
                    <button
                      type="button"
                      className={server.enabled ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm"}
                      disabled={mutating}
                      onClick={() => void toggleServer(server.id)}
                    >
                      {server.enabled ? "停用" : "启用"}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => openEdit(server)}>编辑</button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => void remove(server)}>删除</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
