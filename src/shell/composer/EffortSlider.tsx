import { useCallback, useId, useRef, useState, type CSSProperties } from "react";

import { useAppStore } from "../../app/state";
import { Icon } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";
import { EFFORT_LABELS } from "../../model/client";

/**
 * 思考强度（开发者 Jan）：模型服务只接受 low / medium / xhigh 三档（更高的档位更慢、更耗额度），
 * 因此这里就三档一一对应，不做本地再映射，避免用户选了半天其实没区别。
 */
export function EffortSlider() {
  const effort = useAppStore((state) => state.effort);
  const setEffort = useAppStore((state) => state.setEffort);
  const model = useAppStore((state) => state.model);
  const modelName = useAppStore((state) => state.modelOptions.find((option) => option.id === state.model)?.label);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);
  const value = Math.min(Math.max(Math.round(effort) || 1, 1), EFFORT_LABELS.length);
  const label = EFFORT_LABELS[value - 1];
  const style = { "--effort-progress": `${((value - 1) / (EFFORT_LABELS.length - 1)) * 100}%` } as CSSProperties;

  return (
    <div className="effort-picker" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="chip effort-picker__trigger"
        aria-label={`思考强度：${label.label}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        title="调整思考强度"
        onClick={() => setOpen((current) => !current)}
      >
        {label.label}
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="menu effort-picker__panel" id={panelId} role="dialog" aria-label="调整思考强度">
          <div className="effort-picker__heading">
            <Icon name="sparkles" size={13} />
            <span className="effort-picker__model" title={modelName || model || "思考强度"}>{modelName || model || "思考强度"}</span>
            <span className="effort-picker__value">{label.label}</span>
          </div>
          <div className="effort-picker__control">
            <div className="effort-picker__track" style={style}>
              <div className="effort-picker__ticks" aria-hidden="true">
                {EFFORT_LABELS.map((item) => <span key={item.value} />)}
              </div>
              <input
                autoFocus
                type="range"
                min={1}
                max={EFFORT_LABELS.length}
                step={1}
                value={value}
                aria-label="思考强度"
                aria-valuetext={label.label}
                onChange={(event) => setEffort(Number(event.target.value))}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  close();
                  buttonRef.current?.focus();
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
