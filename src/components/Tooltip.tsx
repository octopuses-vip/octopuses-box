import type { ReactElement } from "react";

interface TooltipProps {
  label: string;
  side?: "top" | "bottom";
  children: ReactElement;
}

/** 轻量 tooltip（开发者 Jan）：用 CSS 伪元素渲染，避免引入额外依赖 */
export function Tooltip({ label, side = "top", children }: TooltipProps) {
  return (
    <span className="tooltip-anchor" data-tooltip={label} data-tooltip-side={side}>
      {children}
    </span>
  );
}
