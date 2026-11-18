import { useEffect, useRef } from "react";
import { useWorkflowUI } from "./store";
import { MemoryPanel } from "../memories/MemoryPanel";
import { PluginPanel } from "./PluginPanel";
import { Icon } from "../components/Icon";
import "./workflows.css";
/** Preferences have their own focused surface, separate from chat inspection. */
export function WorkflowDialog() {
  const { tab, open } = useWorkflowUI(); const visible = tab === "memories" || tab === "plugins";
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (visible) dialog.current?.showModal(); }, [visible]);
  if (!visible) return null;
  return <dialog ref={dialog} className="workbench-settings" aria-label="工作区设置" onCancel={(e) => { e.preventDefault(); open(null); }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) open(null); }}>
      <aside className="workbench-settings__nav"><span className="workbench-settings__label">工作区设置</span><button className={tab === "memories" ? "settings-nav-item is-active" : "settings-nav-item"} onClick={() => open("memories")}><Icon name="book" size={16} />记忆</button><button className={tab === "plugins" ? "settings-nav-item is-active" : "settings-nav-item"} onClick={() => open("plugins")}><Icon name="puzzle" size={16} />插件与连接</button></aside>
      <div className="workbench-settings__main"><header className="inspector-head"><div><h2>{tab === "memories" ? "记忆" : "插件与连接"}</h2><p>{tab === "memories" ? "让后续任务记住你的偏好和项目经验。" : "将技能和外部服务连接到工作区。"}</p></div><button className="icon-btn" aria-label="关闭设置" onClick={() => open(null)}><Icon name="close" size={16} /></button></header><div className="workbench-settings__body">{tab === "memories" ? <MemoryPanel /> : <PluginPanel />}</div></div>
  </dialog>;
}
