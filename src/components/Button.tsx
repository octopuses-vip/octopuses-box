import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

/** 按钮外观（开发者 Jan）：primary 用于主操作，default 用于常规操作，ghost 用于低强调的图标旁按钮 */
type Variant = "primary" | "default" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  icon?: IconName;
  children?: ReactNode;
}

/** 外观到 class 的映射表（开发者 Jan）：集中一处，新增外观只需改这里 */
const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn btn--primary",
  default: "btn",
  ghost: "btn btn--ghost",
};

/**
 * 通用按钮（开发者 Jan）：统一外观、尺寸与可选前置图标。
 *
 * 固定 `type="button"`，避免放在表单里被浏览器当成提交按钮；
 * 其余原生属性透传，调用方仍可传 `onClick` / `disabled` / `title`。
 */
export function Button({
  variant = "default",
  size = "md",
  icon,
  children,
  className,
  ...rest
}: ButtonProps) {
  const classes = [VARIANT_CLASS[variant], size === "sm" ? "btn--sm" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  size?: number;
  active?: boolean;
  label: string;
}

/**
 * 纯图标按钮（开发者 Jan）：用于工具栏等空间紧张处。
 *
 * `label` 是必填项，会写入 `aria-label`——图标按钮没有可见文字，缺了它读屏软件读不出用途。
 */
export function IconButton({ icon, size = 15, active, label, className, ...rest }: IconButtonProps) {
  const classes = ["icon-btn", active ? "icon-btn--active" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} aria-label={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}
