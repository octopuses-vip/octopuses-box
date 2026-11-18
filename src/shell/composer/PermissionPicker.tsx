import { useCallback, useRef, useState } from "react";

import { selectActiveThread } from "../../app/storeSelectors";
import { useAppStore } from "../../app/state";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, permissionModeOption } from "../../approval/permission";
import { Icon } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";

/**
 * 当前会话的权限档位选择器（开发者 Jan）。
 *
 * 放在模型选择器右侧：两者都是「这一轮交给谁、以什么权限执行」的决定，挨在一起才是最顺的
 * 视线路径——先挑模型，再决定要不要逐条确认。
 *
 * 档位挂在会话上（`Thread.permissionMode`），因此切会话时本组件显示的是目标会话自己的选择，
 * 不会把「刚才那个任务放开了」带到新会话。写入走 `setThreadPermissionMode`，作用对象是
 * 当前会话。
 */
export function PermissionPicker() {
  const permissionMode = useAppStore((state) => selectActiveThread(state)?.permissionMode);
  const setThreadPermissionMode = useAppStore((state) => state.setThreadPermissionMode);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  const current = permissionModeOption(permissionMode ?? DEFAULT_PERMISSION_MODE);

  return (
    <div ref={wrapRef} className="composer__picker">
      <button
        type="button"
        // 「全部自动」下命令不再逐条确认，用警示色让当前授权状态一眼可见
        className={current.id === "auto-all" ? "chip chip--warn" : "chip"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`命令执行权限：${current.label}`}
        title={current.description}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="shield" size={12} />
        {current.label}
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="menu" role="listbox">
          {PERMISSION_MODES.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.id === current.id}
              className="menu__item"
              key={item.id}
              onClick={() => {
                setThreadPermissionMode(item.id);
                setOpen(false);
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                <span className="menu__item-title">{item.label}</span>
                <span className="spacer" />
                {item.id === current.id ? (
                  <span className="menu__check">
                    <Icon name="check" size={12} />
                  </span>
                ) : null}
              </span>
              <span className="menu__item-desc">{item.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
