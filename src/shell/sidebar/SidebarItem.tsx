import { Icon, type IconName } from "../../components/Icon";

interface SidebarItemProps {
  icon: IconName;
  label: string;
  active?: boolean;
  badge?: string;
  onClick: () => void;
}

/**
 * 左侧栏导航项（开发者 Jan）：图标 + 文字 + 可选角标，`active` 决定高亮态。
 *
 * 只负责渲染，路由跳转由 `onClick` 交给调用方，避免导航逻辑散落在展示组件里。
 */
export function SidebarItem({ icon, label, active, badge, onClick }: SidebarItemProps) {
  return (
    <button
      type="button"
      className={active ? "nav-item nav-item--active" : "nav-item"}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
      <span className="nav-item__label">{label}</span>
      {badge ? <span className="nav-item__badge">{badge}</span> : null}
    </button>
  );
}
