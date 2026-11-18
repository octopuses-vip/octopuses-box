import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { taskKey, useTaskStore } from "./store";
/** Planning is a composer mode; it does not take permanent space above the conversation. */
export function ModePicker() {
  const id = useAppStore((s) => s.activeThreadId); const scope = useAppStore((s) => s.cachePath);
  const key = taskKey(scope, id); const mode = useTaskStore((s) => s.tasks[key]?.mode ?? "execute");
  const [open, setOpen] = useState(false); const element = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const close = (e: PointerEvent) => { if (e.target instanceof Node && !element.current?.contains(e.target)) setOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [open]);
  return <div className="mode-picker" ref={element} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
    <button className={mode === "plan" ? "composer-mode is-active" : "composer-mode"} aria-label={`任务模式：${mode === "plan" ? "计划" : "执行"}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}><Icon name={mode === "plan" ? "clipboard-check" : "code"} size={13} /><span>{mode === "plan" ? "计划" : "执行"}</span><Icon name="chevron-down" size={10} /></button>
    {open && <div className="mode-picker__menu" role="menu" aria-label="任务模式">{(["execute", "plan"] as const).map((value) => <button key={value} role="menuitemradio" aria-checked={mode === value} onClick={() => { useTaskStore.getState().patch(key, { mode: value }); setOpen(false); }}><Icon name={value === "plan" ? "clipboard-check" : "code"} size={15} /><span><strong>{value === "plan" ? "先制定计划" : "直接执行"}</strong><small>{value === "plan" ? "调查与澄清，确认后再实施" : "根据请求修改、运行并验证"}</small></span>{mode === value && <Icon name="check" size={13} />}</button>)}<div className="menu-divider" /><button role="menuitem" onClick={() => { useTaskStore.getState().edit(key); setOpen(false); }}><Icon name="sparkles" size={15} /><span><strong>设定持续目标</strong><small>定义结果与验收条件</small></span></button></div>}
  </div>;
}
