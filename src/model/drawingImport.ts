/**
 * 图纸导入链路（开发者 Jan）。
 *
 * 拖放与「浏览文件」两条入口最终都汇到这里：把本机图纸复制进当前会话工作目录的
 * `imports/`，再把相对路径写进会话附加上下文——只有落在工作目录里，AI 的文件与命令
 * 工具才读得到。落点目录与格式过滤器分别以 `drawings.ts` 的常量与注册表为准。
 */

import { importWorkspaceFiles, type ImportOutcome } from "../app/desktop/files";
import { pickFiles } from "../app/desktop/system";
import type { DroppedFile } from "../app/fileDrop";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { useAppStore } from "../app/state";
import { drawingEntryKey } from "./drawingSources";
import { DRAWINGS_DIR, drawingFileFilters, fileNameFromPath } from "./drawings";

/** 把导入结果汇总成一句可读提示：全成功只说成功，有失败则附上原因 */
function summarizeImport(succeeded: number, failed: ImportOutcome[]): string {
  const reasons = failed.map((item) => item.error).filter((text) => text.length > 0);
  if (succeeded === 0) {
    return reasons.length > 0 ? `图纸导入失败：${reasons.join("；")}` : "图纸导入失败";
  }
  const base = `已导入 ${succeeded} 个图纸，已加入当前会话上下文`;
  return reasons.length > 0 ? `${base}；${failed.length} 个未导入：${reasons.join("；")}` : base;
}

/**
 * 把一批被拖入的图纸导入会话工作目录（开发者 Jan）。
 *
 * 逐项容错由后端保证（一个文件不合格不影响其余），这里只负责汇总结果与后续联动：
 * 成功项写进附加上下文、刷新 3D 列表、切到「3D」tab；只导入一个时顺手选中它，
 * 用户拖完就能直接看到模型。
 */
export async function importDrawings(files: DroppedFile[]): Promise<void> {
  if (files.length === 0) return;
  const store = useAppStore.getState();

  const projectPath = effectiveWorkspacePath(store);
  if (!projectPath) {
    store.showNotice("请先为当前会话选择工作目录，再导入图纸");
    return;
  }

  // 浏览器演示环境拿不到本机路径，导入必须依赖桌面端能力
  const paths = files
    .map((item) => item.path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  if (paths.length === 0) {
    store.showNotice("导入本地图纸需要在桌面端运行");
    return;
  }

  let outcomes: ImportOutcome[];
  try {
    outcomes = await importWorkspaceFiles(projectPath, DRAWINGS_DIR, paths);
  } catch (error) {
    store.showNotice(`图纸导入失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const succeeded = outcomes.filter((item) => item.ok);
  const failed = outcomes.filter((item) => !item.ok);

  // 重新取状态：导入过程中用户可能已经切了会话，联动要落在当前会话上
  const next = useAppStore.getState();
  for (const item of succeeded) next.addContextEntry(item.path);
  await next.loadWorkspaceImports();
  next.setRightTab("model");
  if (succeeded.length === 1) {
    next.selectDrawing(drawingEntryKey("import", fileNameFromPath(succeeded[0].path)));
  }
  next.showNotice(summarizeImport(succeeded.length, failed));
}

/** 「导入图纸…」按钮：先让用户在系统对话框里挑文件，再汇入同一条导入链路 */
export async function pickAndImportDrawings(): Promise<void> {
  const paths = await pickFiles({ title: "选择图纸文件", filters: drawingFileFilters() });
  if (paths.length === 0) return;
  await importDrawings(
    paths.map((path) => ({ name: fileNameFromPath(path), path, file: null })),
  );
}
