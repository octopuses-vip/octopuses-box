/**
 * 右栏列表里的文件行（开发者 Jan）。
 *
 * 「文件」「图片」「3D」三个 tab 的列表行结构一致：一个选中按钮 + 一个导出按钮。
 * 集中在这里，既避免三处各写一遍，也保证「导出」永远在同一个位置。
 *
 * 注意外层必须是容器而不是按钮：按钮不能互相嵌套，因此把选中与导出拆成并列的两个按钮。
 */

import type { FileLocation } from "../../app/desktop/files";
import { Icon, type IconName } from "../../components/Icon";
import { formatBytes } from "../../model/attachments";
import { ExportButton } from "./ExportButton";

interface FileRowProps {
  /** 行首图标：由调用方按内容类型给出（文件 / 图片 / 图纸） */
  icon: IconName;
  name: string;
  bytes: number;
  /** 是否是当前选中项 */
  active: boolean;
  onSelect: () => void;
  /** 导出时的源文件位置 */
  source: FileLocation;
}

/** 右栏文件列表的一行（开发者 Jan）：图标、文件名、大小与选中态，来源决定点击后的读取方式 */
export function FileRow({ icon, name, bytes, active, onSelect, source }: FileRowProps) {
  return (
    <div className={active ? "file-row nav-item nav-item--active" : "file-row nav-item"}>
      <button type="button" className="nav-item__select" onClick={onSelect}>
        <Icon name={icon} size={14} />
        <span className="nav-item__label mono">{name}</span>
        <span className="spacer" />
        <span className="badge">{formatBytes(bytes)}</span>
      </button>
      <ExportButton name={name} source={source} />
    </div>
  );
}
