import { useCallback, useRef, useState } from "react";

import { useAppStore } from "../../app/state";
import { Icon } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";

/**
 * 输入框的模型选择器（开发者 Jan）：点开下拉切换模型，点击外部收起。
 *
 * 可选模型完全由后台下发；只有一个模型（或还没加载出来）时退化为不可点的标签，
 * 免得给出一个点开也没得选的下拉。
 */
export function ModelPicker() {
  const model = useAppStore((state) => state.model);
  const modelOptions = useAppStore((state) => state.modelOptions);
  const setModel = useAppStore((state) => state.setModel);
  // 列表为空有两种完全不同的原因：还在加载，或来源（后台 / 本地 models.json）出了问题。
  // 只写「模型加载中…」会把配置错误藏起来，用户一直等也不会出现模型
  const modelConfigStatus = useAppStore((state) => state.modelConfigStatus);
  const modelConfigError = useAppStore((state) => state.modelConfigError);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  const current = modelOptions.find((option) => option.id === model) ?? modelOptions[0];

  // 可用模型完全由后台下发，只有一个时没有可切换的对象，直接把模型名显示出来
  if (modelOptions.length <= 1) {
    const failed = modelConfigStatus === "error";
    return (
      <span className="chip" title={current?.label ?? modelConfigError ?? undefined}>
        <Icon name={failed ? "alert" : "sparkles"} size={12} />
        <span className="chip__label">
          {current?.label ?? (failed ? "模型配置有误" : "模型加载中…")}
        </span>
      </span>
    );
  }

  return (
    <div ref={wrapRef} className="composer__picker">
      <button
        type="button"
        className="chip chip--active"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.label}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="sparkles" size={12} />
        <span className="chip__label">{current.label}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="menu" role="listbox">
          {modelOptions.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.id === current.id}
              className="menu__item"
              key={option.id}
              onClick={() => {
                setModel(option.id);
                setOpen(false);
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                <span className="menu__item-title">{option.label}</span>
                <span className="spacer" />
                {option.id === current.id ? (
                  <span className="menu__check">
                    <Icon name="check" size={12} />
                  </span>
                ) : null}
              </span>
              <span className="menu__item-desc">{option.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
