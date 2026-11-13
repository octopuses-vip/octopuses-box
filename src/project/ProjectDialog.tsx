import { useEffect, useState } from "react";

import { pickDirectory } from "../app/desktop/system";
import { useAppStore } from "../app/state";
import { projectNameFromPath } from "./projects";

/**
 * 项目创建 / 编辑弹窗（开发者 Jan）。
 *
 * 集中一处承载项目的全部可编辑项：目录选择、绑定可用的 MCP 服务、绑定可用的技能、
 * 绑定可用的远程主机、项目级提示词。侧栏与首次引导两处入口都通过 `openProjectDialog` 唤起同一个弹窗，
 * 避免各处重复实现表单。编辑态由 `projectDialogEditId` 决定：为空即新建，非空即回填该项目。
 *
 * 绑定语义与运行期收口一致——**严格白名单**：勾选即把该项目可用范围限制在所选项内，
 * 全不勾则本项目不使用该类资源（MCP 工具不挂载、技能不可读、远程主机不可调用）；
 * 勾选一个全局停用的项不会把它启用，因此列表里对未启用的项标注状态，避免用户误以为勾上就能用。
 * 没有项目归属的独立会话不受这三组绑定约束，仍沿用全局已启用集合。
 */
export function ProjectDialog() {
  const open = useAppStore((state) => state.projectDialogOpen);
  const editId = useAppStore((state) => state.projectDialogEditId);
  const closeProjectDialog = useAppStore((state) => state.closeProjectDialog);
  const addProject = useAppStore((state) => state.addProject);
  const updateProject = useAppStore((state) => state.updateProject);
  const mcpServers = useAppStore((state) => state.mcpServers);
  const skills = useAppStore((state) => state.skills);
  const disabledSkillIds = useAppStore((state) => state.disabledSkillIds);
  const sshHosts = useAppStore((state) => state.sshHosts);

  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [sshHostIds, setSshHostIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 打开时（或切换新建 / 编辑目标时）用目标项目的现有值回填表单；
  // 用 getState() 现取项目列表，避免订阅 projects 导致无关变更把表单重置
  useEffect(() => {
    if (!open) return;
    const state = useAppStore.getState();
    const target = editId ? state.projects.find((item) => item.id === editId) ?? null : null;
    setName(target?.name ?? "");
    setPath(target?.path ?? "");
    setMcpIds(target?.mcpIds ?? []);
    setSkillIds(target?.skillIds ?? []);
    setSshHostIds(target?.sshHostIds ?? []);
    setPrompt(target?.prompt ?? "");
    setError(null);
  }, [open, editId]);

  if (!open) return null;

  const toggleId = (list: string[], setList: (next: string[]) => void, id: string) =>
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

/** 函数级说明（开发者 Jan）：执行 chooseFolder 的单一职责，并返回可供调用方继续处理的结果。 */
  const chooseFolder = async () => {
    const selected = await pickDirectory();
    if (!selected) {
      setError("当前环境不支持原生目录选择，可直接填写绝对路径。");
      return;
    }
    setPath(selected);
    // 名称留空时用目录末段兜底，省去用户重复输入
    if (name.trim().length === 0) setName(projectNameFromPath(selected));
    setError(null);
  };

/** 函数级说明（开发者 Jan）：执行 save 的单一职责，并返回可供调用方继续处理的结果。 */
  const save = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("请填写项目名称。");
      return;
    }
    const payload = {
      name: trimmed,
      path: path.trim(),
      mcpIds,
      skillIds,
      sshHostIds,
      prompt: prompt.trim(),
    };
    if (editId) updateProject(editId, payload);
    else addProject(payload);
    closeProjectDialog();
  };

  return (
    <div className="overlay overlay--center" onMouseDown={closeProjectDialog}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={editId ? "编辑项目" : "新建项目"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="modal__title">{editId ? "编辑项目" : "新建项目"}</span>
        </div>

        <div className="modal__body project-dialog">
          <div className="project-dialog__group">
            <label className="project-dialog__label">项目名称</label>
            <input
              className="form__input"
              value={name}
              placeholder="项目名称"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="project-dialog__group">
            <label className="project-dialog__label">项目目录</label>
            <div className="project-dialog__path">
              <input
                className="form__input"
                value={path}
                placeholder="项目目录绝对路径（可留空后再补）"
                onChange={(event) => setPath(event.target.value)}
              />
              <button type="button" className="btn btn--sm" onClick={() => void chooseFolder()}>
                选择目录
              </button>
            </div>
            <p className="project-dialog__hint">
              该目录作为项目工作区：目录里的 AGENTS.md 自动作为项目规则，文件读写、附加上下文与终端都以它为根。
            </p>
          </div>

          <div className="project-dialog__group">
            <label className="project-dialog__label">绑定可用的 MCP 服务</label>
            {mcpServers.length === 0 ? (
              <p className="project-dialog__hint">尚未配置 MCP 服务，先在侧栏「MCP」页面里添加，再回到这里勾选。</p>
            ) : (
              <>
                <div className="project-dialog__list">
                  {mcpServers.map((server) => (
                    <label className="project-dialog__check" key={server.id}>
                      <input
                        type="checkbox"
                        checked={mcpIds.includes(server.id)}
                        onChange={() => toggleId(mcpIds, setMcpIds, server.id)}
                      />
                      <span className="project-dialog__check-name">{server.name}</span>
                      {server.enabled ? null : <span className="badge">未启用</span>}
                    </label>
                  ))}
                </div>
                <p className="project-dialog__hint">
                  不勾选任何项 = 本项目不使用任何 MCP；勾选后本项目只放行所选，且不会启用一个全局停用的服务。
                </p>
              </>
            )}
          </div>

          <div className="project-dialog__group">
            <label className="project-dialog__label">绑定可用的技能</label>
            {skills.length === 0 ? (
              <p className="project-dialog__hint">尚未发现技能，可先在侧栏「技能」页面里启用，再回到这里勾选。</p>
            ) : (
              <>
                <div className="project-dialog__list">
                  {skills.map((skill) => (
                    <label className="project-dialog__check" key={skill.id}>
                      <input
                        type="checkbox"
                        checked={skillIds.includes(skill.id)}
                        onChange={() => toggleId(skillIds, setSkillIds, skill.id)}
                      />
                      <span className="project-dialog__check-name">{skill.name}</span>
                      {disabledSkillIds.includes(skill.id) ? <span className="badge">未启用</span> : null}
                    </label>
                  ))}
                </div>
                <p className="project-dialog__hint">
                  不勾选任何项 = 本项目不使用任何技能；勾选后本项目只放行所选，未绑定的技能既不会被模型自动读取，
                  用 /技能名 显式调用也不生效。
                </p>
              </>
            )}
          </div>

          <div className="project-dialog__group">
            <label className="project-dialog__label">绑定可用的远程主机</label>
            {sshHosts.length === 0 ? (
              <p className="project-dialog__hint">尚未配置远程主机，可先在侧栏「远程主机」页面里添加，再回到这里勾选。</p>
            ) : (
              <>
                <div className="project-dialog__list">
                  {sshHosts.map((host) => (
                    <label className="project-dialog__check" key={host.id}>
                      <input
                        type="checkbox"
                        checked={sshHostIds.includes(host.id)}
                        onChange={() => toggleId(sshHostIds, setSshHostIds, host.id)}
                      />
                      <span className="project-dialog__check-name">{host.name}</span>
                      <span className="project-dialog__check-sub">{`${host.username}@${host.host}:${host.port}`}</span>
                      {host.enabled ? null : <span className="badge">未启用</span>}
                    </label>
                  ))}
                </div>
                <p className="project-dialog__hint">
                  不勾选任何项 = 本项目不使用任何远程主机；勾选后本项目只放行所选。模型点名未绑定的主机会被直接拒绝，
                  不会弹出审批；绑定也不会启用一台全局停用的主机。
                </p>
              </>
            )}
          </div>

          <div className="project-dialog__group">
            <label className="project-dialog__label">项目提示词</label>
            <textarea
              className="form__input project-dialog__prompt"
              value={prompt}
              placeholder="该项目的专属约定，会注入到每次对话的系统说明里（可留空）"
              onChange={(event) => setPrompt(event.target.value)}
            />
            <p className="project-dialog__hint">
              作为该项目的专属约定注入，位于 AGENTS.md 规则之后、Agent 角色设定之前。
            </p>
          </div>

          {error ? <div className="modal__error">{error}</div> : null}
        </div>

        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={closeProjectDialog}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={save}>
            {editId ? "保存" : "创建项目"}
          </button>
        </div>
      </div>
    </div>
  );
}
