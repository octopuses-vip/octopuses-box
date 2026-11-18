import { useCallback, useRef, useState } from "react";

import { selectActiveThread } from "../../app/storeSelectors";
import { useAppStore } from "../../app/state";
import { Icon } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";

/**
 * 当前会话绑定的 Agent 选择器（开发者 Jan）。
 *
 * 放在权限档位选择器旁：两者都决定「这一轮以什么身份、什么权限运行」。绑定后运行期会按
 * Agent 收敛模型、系统提示（persona）与工具集，并把权限档位压到「只收窄不提升」的上限之下。
 * 绑定挂在会话上（`Thread.agentId`），切会话时显示的是目标会话自己的选择，不会串台。
 *
 * 没有可用的 Agent 时整个选择器不渲染，避免留一个点开空白的控件。
 */
export function AgentPicker() {
  const agents = useAppStore((state) => state.agents);
  const threadAgentId = useAppStore((state) => selectActiveThread(state)?.agentId ?? null);
  const setThreadAgent = useAppStore((state) => state.setThreadAgent);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  if (agents.length === 0) return null;

  const current = agents.find((agent) => agent.id === threadAgentId) ?? null;

  return (
    <div ref={wrapRef} className="composer__picker">
      <button
        type="button"
        className={current ? "chip chip--active" : "chip"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`绑定的 Agent：${current?.name ?? "未绑定"}`}
        title={
          current
            ? `${current.name}${current.description ? `\n${current.description}` : ""}`
            : "为当前会话绑定一个 Agent，按它的角色、模型与工具白名单运行"
        }
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="cube" size={12} />
        <span className="chip__label">{current?.name ?? "未绑定 Agent"}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="menu" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={current === null}
            className="menu__item"
            onClick={() => {
              setThreadAgent(null);
              setOpen(false);
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
              <span className="menu__item-title">不绑定</span>
              <span className="spacer" />
              {current === null ? (
                <span className="menu__check">
                  <Icon name="check" size={12} />
                </span>
              ) : null}
            </span>
            <span className="menu__item-desc">按普通会话运行，使用当前模型与全量工具</span>
          </button>
          {agents.map((agent) => (
            <button
              type="button"
              role="option"
              aria-selected={agent.id === current?.id}
              className="menu__item"
              key={agent.id}
              onClick={() => {
                setThreadAgent(agent.id);
                setOpen(false);
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                <span className="menu__item-title">{agent.name}</span>
                <span className="spacer" />
                {agent.id === current?.id ? (
                  <span className="menu__check">
                    <Icon name="check" size={12} />
                  </span>
                ) : null}
              </span>
              <span className="menu__item-desc">{agent.description || "（无说明）"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
