import { useEffect, useState } from "react";

import { useAppStore } from "../app/state";
import { APP_NAME } from "../app/meta";
import { confirmDelete, confirmOverwrite } from "../app/confirmations";
import { Icon } from "../components/Icon";
import { useConfirm } from "../components/ConfirmProvider";
import { PERMISSION_MODES } from "../approval/permission";
import type { AgentItem } from "../app/types";

/** 表单草稿：`tools` 用逗号分隔的文本承载，提交时再拆成数组 */
const EMPTY_FORM = {
  id: "",
  name: "",
  description: "",
  model: "",
  tools: "",
  permissionMode: "",
  systemAppend: "",
};

/** 工具白名单的写法提示：类别键 + 单个工具名 + `*` 全量 */
const TOOLS_HINT =
  "留空表示不限制。可写类别键（workspace / ssh / cv / vision / control / mcp）、单个工具名，或用 * 表示全量；多个用逗号分隔。";

/**
 * Agent（子代理）管理页（开发者 Jan）。
 *
 * Agent 是一份「角色 + 模型 + 工具白名单 + 权限上限」的可复用配置，绑定到会话或自动化后，
 * 运行期按这份配置收敛模型、系统提示（persona）与工具集。表单照技能页形态组织，
 * 但不做导入与启停：Agent 是纯声明，不存在「安装目录」与「临时停用」两种语义。
 */
export function AgentsPage() {
  const cachePath = useAppStore((state) => state.cachePath);
  const agents = useAppStore((state) => state.agents);
  const agentStatus = useAppStore((state) => state.agentStatus);
  const agentError = useAppStore((state) => state.agentError);
  const mutationStatus = useAppStore((state) => state.agentMutationStatus);
  const mutationError = useAppStore((state) => state.agentMutationError);
  const loadAgents = useAppStore((state) => state.loadAgents);
  const createLocalAgent = useAppStore((state) => state.createAgent);
  const updateLocalAgent = useAppStore((state) => state.updateAgent);
  const deleteLocalAgent = useAppStore((state) => state.deleteAgent);
  const modelOptions = useAppStore((state) => state.modelOptions);
  const confirm = useConfirm();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const scanning = agentStatus === "loading";
  const mutating = mutationStatus === "loading";

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

/** 函数级说明（开发者 Jan）：执行 openCreate 的单一职责，并返回可供调用方继续处理的结果。 */
  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 openEdit 的单一职责，并返回可供调用方继续处理的结果。 */
  const openEdit = (agent: AgentItem) => {
    setEditingId(agent.id);
    setForm({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      tools: agent.tools.join(", "),
      permissionMode: agent.permissionMode,
      systemAppend: agent.systemAppend,
    });
    setOverwrite(false);
    setFormOpen(true);
  };

  /** 把逗号分隔的文本拆成去空、去重后的工具条目 */
  const parseTools = (raw: string): string[] => {
    const items = raw
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return Array.from(new Set(items));
  };

/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = async () => {
    if (!form.id.trim() || !form.name.trim()) return;
    const idChanged = editingId !== null && editingId !== form.id.trim();
    let allowOverwrite = overwrite;
    if ((editingId === null || idChanged) && !allowOverwrite) {
      const conflict = agents.some((agent) => agent.id === form.id.trim());
      if (conflict && !(await confirmOverwrite(confirm, "目标 Agent"))) return;
      if (conflict) {
        setOverwrite(true);
        allowOverwrite = true;
      }
    }
    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      description: form.description.trim(),
      model: form.model.trim(),
      tools: parseTools(form.tools),
      permissionMode: form.permissionMode,
      systemAppend: form.systemAppend,
      overwrite: allowOverwrite,
    };
    try {
      if (editingId) {
        await updateLocalAgent({ ...payload, originalId: editingId });
      } else {
        await createLocalAgent(payload);
      }
      setFormOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      // 错误由页面状态展示
    }
  };

/** 函数级说明（开发者 Jan）：执行 remove 的单一职责，并返回可供调用方继续处理的结果。 */
  const remove = async (agent: AgentItem) => {
    if (!(await confirmDelete(confirm, "Agent", agent.name))) return;
    try {
      await deleteLocalAgent(agent.id);
    } catch {
      // 错误由页面状态展示
    }
  };

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          Agent 是可复用的子代理配置，放在缓存目录下的 agents/&lt;agentId&gt;/AGENT.md（当前：
          {cachePath ? `${cachePath}/agents` : "尚未配置缓存目录"}）。{APP_NAME} 启动时会扫描并生成索引；
          把 Agent 绑定到会话或自动化后，运行期按它收敛模型、系统提示（persona）与工具集。
        </p>

        <div className="page__section">
          <div className="page__section-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>已安装 {agents.length}</span>
            <span className="spacer" />
            <button type="button" className="btn btn--primary btn--sm" disabled={mutating || !cachePath} onClick={openCreate}>新建</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={scanning || mutating} onClick={() => void loadAgents()}>{scanning ? "扫描中…" : "重新扫描"}</button>
          </div>

          {!cachePath ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">请先配置缓存目录后再管理本地 Agent。</span>
            </div>
          ) : null}
          {mutationError ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">操作失败：{mutationError}</span>
            </div>
          ) : null}
          {agentError ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">扫描失败：{agentError}</span>
            </div>
          ) : null}

          {formOpen ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card__head"><span className="card__title">{editingId ? "编辑 Agent" : "新建 Agent"}</span></div>
              <div className="form__grid">
                <label className="form__row">
                  <span className="form__label">id</span>
                  <input className="form__input" value={form.id} disabled={Boolean(editingId)} onChange={(event) => setForm({ ...form, id: event.target.value })} />
                </label>
                <label className="form__row">
                  <span className="form__label">名称</span>
                  <input className="form__input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </label>
                <label className="form__row" style={{ gridColumn: "1 / -1" }}>
                  <span className="form__label">说明</span>
                  <input className="form__input" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
                </label>
                <label className="form__row">
                  <span className="form__label">模型</span>
                  <select className="form__select" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>
                    <option value="">跟随会话当前模型</option>
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="form__row">
                  <span className="form__label">权限档上限</span>
                  <select className="form__select" value={form.permissionMode} onChange={(event) => setForm({ ...form, permissionMode: event.target.value })}>
                    <option value="">不限制（跟随会话档位）</option>
                    {PERMISSION_MODES.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="form__row" style={{ gridColumn: "1 / -1" }}>
                  <span className="form__label">工具白名单</span>
                  <input className="form__input" value={form.tools} placeholder="workspace, read_file, mcp" onChange={(event) => setForm({ ...form, tools: event.target.value })} />
                  <span className="list-row__desc" style={{ marginTop: 4 }}>{TOOLS_HINT}</span>
                </label>
                <label className="form__row" style={{ gridColumn: "1 / -1" }}>
                  <span className="form__label">persona（AGENT.md 正文）</span>
                  <textarea className="form__textarea" rows={10} value={form.systemAppend} placeholder="这段文字会追加到系统提示里，作为该 Agent 的角色设定。" onChange={(event) => setForm({ ...form, systemAppend: event.target.value })} />
                </label>
              </div>
              <div className="login__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={mutating} onClick={() => void submit()}>{mutating ? "保存中…" : "保存"}</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => setFormOpen(false)}>取消</button>
              </div>
            </div>
          ) : null}

          {agents.length === 0 ? (
            <div className="list-row" style={{ marginBottom: 0 }}>
              <span className="list-row__desc">{scanning ? "正在扫描 Agent 目录…" : "还没有 Agent。可以新建一个，或直接把 AGENT.md 放进 agents/ 目录后重新扫描。"}</span>
            </div>
          ) : (
            <div>
              {agents.map((agent) => {
                const modelLabel =
                  modelOptions.find((option) => option.id === agent.model)?.label ?? agent.model;
                const summary = [
                  agent.description || "（无说明）",
                  agent.model ? `模型：${modelLabel}` : "模型：跟随会话",
                  agent.tools.length > 0 ? `工具：${agent.tools.join("、")}` : "工具：不限制",
                ].join(" · ");
                return (
                  <div className="list-row list-row--top" key={agent.id} title={agent.path}>
                    <Icon name="cube" size={15} />
                    <div className="list-row__main">
                      <span className="list-row__title">{agent.name}</span>
                      <span className="list-row__desc">{summary}</span>
                    </div>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => openEdit(agent)}>编辑</button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => void remove(agent)}>删除</button>
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
