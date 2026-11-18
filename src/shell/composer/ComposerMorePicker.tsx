import { useCallback, useRef, useState } from "react";

import { useAppStore } from "../../app/state";
import { Icon } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";
import { AgentPicker } from "./AgentPicker";
import { EffortSlider } from "./EffortSlider";
import { PermissionPicker } from "./PermissionPicker";

/**
 * 输入区工具栏的溢出收纳弹层（开发者 Jan）。
 *
 * 收纳当前工具栏放不下的选择器。较窄时把思考强度也移入弹层，为模型和任务模式保留空间。
 */
export function ComposerMorePicker({ includeEffort }: { includeEffort: boolean }) {
  const hasAgents = useAppStore((state) => state.agents.length > 0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  return (
    <div ref={wrapRef} className="composer__picker">
      <button
        type="button"
        className="chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多会话选项"
        title="更多会话选项"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="ellipsis" size={12} />
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="menu menu--right composer__more-menu" role="menu">
          {includeEffort && (
            <div className="composer__more-row">
              <span className="composer__more-label">思考强度</span>
              <EffortSlider />
            </div>
          )}
          {hasAgents && (
            <div className="composer__more-row">
              <span className="composer__more-label">Agent</span>
              <AgentPicker />
            </div>
          )}
          <div className="composer__more-row">
            <span className="composer__more-label">权限档位</span>
            <PermissionPicker />
          </div>
        </div>
      ) : null}
    </div>
  );
}
