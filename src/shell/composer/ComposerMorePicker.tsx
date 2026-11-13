import { useCallback, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";
import { AgentPicker } from "./AgentPicker";
import { PermissionPicker } from "./PermissionPicker";

/**
 * 输入区工具栏的溢出收纳弹层（开发者 Jan）。
 *
 * 窗口收窄到放不下全部选择器时，Agent 与权限档位从工具栏撤下，收进这枚「更多」按钮的
 * 上拉弹层里；弹层内仍渲染完整的两个选择器，行为与平铺时完全一致（各自的选择菜单
 * 从行内上抛，叠加显示）。
 */
export function ComposerMorePicker() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多会话选项"
        title="Agent 与命令执行权限"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="ellipsis" size={12} />
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="menu menu--right composer__more-menu" role="menu">
          <div className="composer__more-row">
            <span className="composer__more-label">Agent</span>
            <AgentPicker />
          </div>
          <div className="composer__more-row">
            <span className="composer__more-label">权限档位</span>
            <PermissionPicker />
          </div>
        </div>
      ) : null}
    </div>
  );
}
