/**
 * 右栏列表行的导出按钮（开发者 Jan）。
 *
 * 把列表里的一个文件另存到用户指定的位置：先弹系统「另存为」对话框拿到目标路径，
 * 再让后端直接复制——源文件可能是缓存里的产物、工作区里的导入图纸或本机文件，
 * 三种来源统一用 `FileLocation` 描述，组件不关心它从哪来。
 */

import { useState } from "react";

import { saveFileAs } from "../../app/desktop/system";
import { transferFile, type FileLocation } from "../../app/desktop/files";
import { useAppStore } from "../../app/state";
import { Icon } from "../../components/Icon";
import { drawingFileFilters, drawingFormatOf } from "../../model/drawings";

interface ExportButtonProps {
  /** 展示名，同时作为「另存为」对话框的默认文件名 */
  name: string;
  /** 文件位置，决定后端从哪里取源文件 */
  source: FileLocation;
}

/** 产物导出按钮（开发者 Jan）：把缓存目录里的产物另存到用户指定位置，并提示结果 */
export function ExportButton({ name, source }: ExportButtonProps) {
  const showNotice = useAppStore((state) => state.showNotice);
  /** 复制期间禁止重复点击：大文件复制要一点时间，连点会派发多次导出 */
  const [busy, setBusy] = useState(false);

/** 函数级说明（开发者 Jan）：执行 handleExport 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleExport = async () => {
    // 图纸按注册表给对话框过滤器（方便辨认格式），其余文件不限类型
    const filters = drawingFormatOf(name) ? drawingFileFilters() : undefined;
    const target = await saveFileAs({ title: `导出 ${name}`, defaultPath: name, filters });
    // 用户取消选择：静默结束，取消不该被当成失败
    if (!target) return;
    setBusy(true);
    try {
      const result = await transferFile(source, target);
      showNotice(`已导出到 ${result.path}`);
    } catch (error) {
      showNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      title={`导出 ${name}`}
      aria-label={`导出 ${name}`}
      disabled={busy}
      onClick={() => void handleExport()}
    >
      <Icon name="download" size={12} />
    </button>
  );
}
