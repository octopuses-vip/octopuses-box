import { useEffect, useRef } from "react";
import { useWorkflowUI } from "./store";
import { MemoryPanel } from "../memories/MemoryPanel";
import { Icon } from "../components/Icon";
import "./workflows.css";
/** Open memory settings from the chat command or workspace preferences. */
export function WorkflowDialog() {
  const { tab, open } = useWorkflowUI();
  const visible = tab === "memories";
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (visible) dialog.current?.showModal(); }, [visible]);
  if (!visible) return null;
  return (
    <dialog
      ref={dialog}
      className="workbench-settings"
      aria-labelledby="memory-settings-title"
      onCancel={(event) => { event.preventDefault(); open(null); }}
      onClick={(event) => {
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) open(null);
      }}
    >
      <header className="inspector-head">
        <div>
          <h2 id="memory-settings-title">记忆</h2>
          <p>让后续任务记住你的偏好和项目经验。</p>
        </div>
        <button type="button" className="icon-btn" aria-label="关闭记忆设置" onClick={() => open(null)}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="workbench-settings__body"><MemoryPanel /></div>
    </dialog>
  );
}
