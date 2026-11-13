/**
 * 「3D」tab：列出会话内可预览的图纸，并在下方原生渲染选中的一张（开发者 Jan）。
 *
 * 图纸有两个来源——模型写出的产物与会话工作目录 `imports/` 下的导入文件，
 * 两者由 `model/drawingSources` 合并成同一种条目，这里只管展示与选中。
 * 布局沿用「网页」tab 的铺满范式：列表占据固定高度，视图区吃满剩余空间。
 * 前端没有目录监听，模型新写出的图纸要靠工具栏的刷新按钮重新读取两条来路。
 */

import { useEffect, useMemo, useState } from "react";

import { writeArtifactBytes } from "../../../app/desktop/artifacts";
import { effectiveArtifactDir } from "../../../app/state/artifacts";
import { effectiveWorkspacePath } from "../../../app/state/workspace";
import { useAppStore } from "../../../app/state";
import { IconButton } from "../../../components/Button";
import { Icon } from "../../../components/Icon";
import { ARTIFACT_PREFIXES, nextArtifactName } from "../../../model/artifactNaming";
import { captureActiveDrawing } from "../../../model/drawingCapture";
import { pickAndImportDrawings } from "../../../model/drawingImport";
import { mergeDrawingEntries } from "../../../model/drawingSources";
import { FileRow } from "../FileRow";
import { DrawingViewer } from "./DrawingViewer";

/** 截图产物的扩展名与 MIME：抓帧固定输出 PNG */
const SCREENSHOT_EXTENSION = "png";

/** 图纸 tab（开发者 Jan）：列出模型产物与工作区导入的图纸文件，选中后交给 DrawingViewer 预览 */
export function ModelPreview() {
  const artifacts = useAppStore((state) => state.artifacts);
  const workspaceImports = useAppStore((state) => state.workspaceImports);
  const importsStatus = useAppStore((state) => state.importsStatus);
  const loadWorkspaceImports = useAppStore((state) => state.loadWorkspaceImports);
  const loadArtifacts = useAppStore((state) => state.loadArtifacts);
  const selectArtifact = useAppStore((state) => state.selectArtifact);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const showNotice = useAppStore((state) => state.showNotice);
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  const activeDrawing = useAppStore((state) => state.activeDrawing);
  const selectDrawing = useAppStore((state) => state.selectDrawing);
  const workspacePath = useAppStore(effectiveWorkspacePath);
  /** 手动刷新期间禁用按钮，避免连点导致重复读取 */
  const [refreshing, setRefreshing] = useState(false);
  /** 抓帧 + 落盘期间禁用截图按钮，避免连点写出多张几乎相同的图 */
  const [capturing, setCapturing] = useState(false);

  const entries = useMemo(
    () =>
      mergeDrawingEntries(artifacts, workspaceImports, artifactDir ?? "", workspacePath ?? ""),
    [artifacts, workspaceImports, artifactDir, workspacePath],
  );

  // 首次打开本 tab 时补读一次 `imports/`：切换会话时 store 已经清空并重读过，这里是兜底
  useEffect(() => {
    if (importsStatus === "idle") void loadWorkspaceImports();
  }, [importsStatus, loadWorkspaceImports]);

  // 选中的那张已被删掉（或还没选过）时落到第一张，避免视图区空着
  useEffect(() => {
    if (entries.some((entry) => entry.key === activeDrawing)) return;
    selectDrawing(entries[0]?.key ?? null);
  }, [entries, activeDrawing, selectDrawing]);

  /**
   * 重新读取图纸列表（开发者 Jan）。
   *
   * 图纸有两个来路，两边都可能在本 tab 打开期间发生变化：模型刚用 `write_artifact` 写出的
   * 图纸落在产物区，AI 用文件工具写进 `imports/` 的图纸落在工作区。前端没有目录监听，
   * 因此这里并排刷新两条来路，让用户不必切走会话再切回来。
   */
  const refreshDrawings = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadArtifacts(), loadWorkspaceImports()]);
    } finally {
      setRefreshing(false);
    }
  };

  const current = entries.find((entry) => entry.key === activeDrawing) ?? null;

  /**
   * 把当前 3D 视图存成图片产物（开发者 Jan）。
   *
   * 走的是与 AI 抓帧完全相同的抓帧实现，区别只在落盘：这里把 PNG 写进产物区并切到
   * 「图片」tab，让用户能直接看到、导出，也能随后让模型用 read_image 读它。
   */
  const captureScreenshot = async () => {
    setCapturing(true);
    try {
      const shot = await captureActiveDrawing();
      if (!shot) {
        showNotice("当前 3D 视图尚未渲染完成，请稍后再试");
        return;
      }
      const name = nextArtifactName(
        ARTIFACT_PREFIXES.drawingView,
        SCREENSHOT_EXTENSION,
        artifacts.map((item) => item.name),
      );
      await writeArtifactBytes(artifactDir, name, shot.base64);
      await loadArtifacts();
      await selectArtifact(name);
      setRightTab("media");
      showNotice(`已保存截图 ${name}`);
    } catch (error) {
      showNotice(`保存截图失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="model-preview">
      <div className="panel-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void pickAndImportDrawings()}
        >
          <Icon name="upload" size={13} />
          导入图纸…
        </button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
          {entries.length > 0 ? `共 ${entries.length} 个图纸` : "暂无图纸"}
        </span>
        <IconButton
          icon="image"
          size={14}
          label="截图存为产物"
          title="把当前视图存成 PNG 图片产物"
          disabled={capturing || current === null}
          onClick={() => void captureScreenshot()}
        />
        <IconButton
          icon="refresh"
          size={14}
          label="重新读取图纸列表"
          title="重新读取图纸列表"
          disabled={refreshing}
          onClick={() => void refreshDrawings()}
        />
      </div>

      {entries.length > 0 ? (
        <div className="model-preview__list">
          {entries.map((entry) => (
            <FileRow
              key={entry.key}
              icon="cube"
              name={entry.name}
              bytes={entry.bytes}
              active={entry.key === current?.key}
              onSelect={() => selectDrawing(entry.key)}
              source={entry.source}
            />
          ))}
        </div>
      ) : null}

      <div className="model-preview__stage">
        {current ? (
          <DrawingViewer entry={current} />
        ) : (
          <div className="panel-empty">
            把 STEP / IGES 图纸拖到窗口任意位置，或点上方「导入图纸…」，
            文件会导入当前会话工作目录的 imports/ 下，随后可在这里旋转查看。
          </div>
        )}
      </div>
    </div>
  );
}
