import { useEffect, useState } from "react";

import { useAppStore } from "../app/state";
import { APP_NAME } from "../app/meta";
import { pickDirectory } from "../app/desktop/system";
import { confirmDelete, confirmOverwrite } from "../app/confirmations";
import { Icon } from "../components/Icon";
import { useConfirm } from "../components/ConfirmProvider";
import type { SkillItem } from "../app/types";

const EMPTY_FORM = { id: "", name: "", description: "", body: "" };

/** 技能管理页（开发者 Jan）：支持启停、增删改与导入，表单按字段组织，说明与正文独占一行 */
export function SkillsPage() {
  const cachePath = useAppStore((state) => state.cachePath);
  const skills = useAppStore((state) => state.skills);
  const disabledSkillIds = useAppStore((state) => state.disabledSkillIds);
  const skillStatus = useAppStore((state) => state.skillStatus);
  const skillError = useAppStore((state) => state.skillError);
  const mutationStatus = useAppStore((state) => state.skillMutationStatus);
  const mutationError = useAppStore((state) => state.skillMutationError);
  const loadSkills = useAppStore((state) => state.loadSkills);
  const toggleSkill = useAppStore((state) => state.toggleSkill);
  const createLocalSkill = useAppStore((state) => state.createSkill);
  const updateLocalSkill = useAppStore((state) => state.updateSkill);
  const deleteLocalSkill = useAppStore((state) => state.deleteSkill);
  const importLocalSkill = useAppStore((state) => state.importSkill);
  const confirm = useConfirm();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const enabledCount = skills.filter((skill) => !disabledSkillIds.includes(skill.id)).length;
  const scanning = skillStatus === "loading";
  const mutating = mutationStatus === "loading";

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

/** 函数级说明（开发者 Jan）：执行 openCreate 的单一职责，并返回可供调用方继续处理的结果。 */
  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 openEdit 的单一职责，并返回可供调用方继续处理的结果。 */
  const openEdit = (skill: SkillItem) => {
    // SKILL.md 结构为 frontmatter + 空行 + 正文；正文自身可能包含 --- 分隔线，需原样还原
    const parts = skill.body.split("---");
    const body = parts.length >= 3 ? parts.slice(2).join("---").replace(/^\n/, "") : skill.body;
    setEditingId(skill.id);
    setForm({ id: skill.id, name: skill.name, description: skill.description, body });
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = async () => {
    if (!form.id.trim() || !form.name.trim()) return;
    const idChanged = editingId !== null && editingId !== form.id.trim();
    let allowOverwrite = overwrite;
    if ((editingId === null || idChanged) && !allowOverwrite) {
      const conflict = skills.some((skill) => skill.id === form.id.trim());
      if (conflict && !(await confirmOverwrite(confirm, "目标技能"))) return;
      if (conflict) {
        setOverwrite(true);
        allowOverwrite = true;
      }
    }
    try {
      if (editingId) {
        await updateLocalSkill({ ...form, id: form.id.trim(), originalId: editingId, overwrite: allowOverwrite });
      } else {
        await createLocalSkill({ ...form, id: form.id.trim(), overwrite: allowOverwrite });
      }
      setFormOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      // 错误由页面状态展示
    }
  };

/** 函数级说明（开发者 Jan）：执行 importDirectory 的单一职责，并返回可供调用方继续处理的结果。 */
  const importDirectory = async () => {
    try {
      const sourceDir = await pickDirectory("选择要导入的技能目录");
      if (!sourceDir) return;
      const existingName = sourceDir.split(/[\\/]/).pop() ?? "";
      const existing = skills.some((skill) => skill.id === existingName);
      const allowOverwrite = existing ? await confirmOverwrite(confirm, `技能「${existingName}」`) : false;
      if (existing && !allowOverwrite) return;
      await importLocalSkill({ sourceDir, id: null, overwrite: allowOverwrite });
    } catch {
      // 错误由页面状态展示
    }
  };

/** 函数级说明（开发者 Jan）：执行 remove 的单一职责，并返回可供调用方继续处理的结果。 */
  const remove = async (skill: SkillItem) => {
    if (!(await confirmDelete(confirm, "技能", skill.name))) return;
    try {
      await deleteLocalSkill(skill.id);
    } catch {
      // 错误由页面状态展示
    }
  };

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          技能是可复用的工作流说明，放在缓存目录下的 skills/&lt;技能名&gt;/SKILL.md（当前：
          {cachePath ? `${cachePath}/skills` : "尚未配置缓存目录"}）。{APP_NAME} 启动时会扫描并生成技能索引。
        </p>

        <div className="page__section">
          <div className="page__section-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>已安装 {skills.length} · 已启用 {enabledCount}</span>
            <span className="spacer" />
            <button type="button" className="btn btn--primary btn--sm" disabled={mutating || !cachePath} onClick={openCreate}>新建</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={mutating || !cachePath} onClick={() => void importDirectory()}>导入目录</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={scanning || mutating} onClick={() => void loadSkills()}>{scanning ? "扫描中…" : "重新扫描"}</button>
          </div>

          {!cachePath ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">请先配置缓存目录后再管理本地技能。</span>
            </div>
          ) : null}
          {mutationError ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">操作失败：{mutationError}</span>
            </div>
          ) : null}
          {skillError ? (
            <div className="list-row" style={{ marginBottom: 8 }}>
              <span className="list-row__desc">扫描失败：{skillError}</span>
            </div>
          ) : null}

          {formOpen ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card__head"><span className="card__title">{editingId ? "编辑技能" : "新建技能"}</span></div>
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
                <label className="form__row" style={{ gridColumn: "1 / -1" }}>
                  <span className="form__label">正文</span>
                  <textarea className="form__textarea" rows={10} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
                </label>
              </div>
              <div className="login__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={mutating} onClick={() => void submit()}>{mutating ? "保存中…" : "保存"}</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => setFormOpen(false)}>取消</button>
              </div>
            </div>
          ) : null}

          {skills.length === 0 ? (
            <div className="list-row" style={{ marginBottom: 0 }}>
              <span className="list-row__desc">{scanning ? "正在扫描技能目录…" : "还没有技能。可以新建技能或导入已有目录。"}</span>
            </div>
          ) : (
            <div>
              {skills.map((skill) => {
                const enabled = !disabledSkillIds.includes(skill.id);
                return (
                  <div className="list-row" key={skill.id} title={skill.path}>
                    <Icon name="sparkles" size={15} />
                    <div className="list-row__main">
                      <span className="list-row__title">{skill.name}</span>
                    </div>
                    {enabled ? <span className="badge badge--ok">已启用</span> : <span className="badge">已停用</span>}
                    <button type="button" className={enabled ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm"} onClick={() => toggleSkill(skill.id)}>{enabled ? "停用" : "启用"}</button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => openEdit(skill)}>编辑</button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => void remove(skill)}>删除</button>
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
