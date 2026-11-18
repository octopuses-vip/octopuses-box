import { ReviewPanel } from "../../workflows/ReviewPanel";
import { BrowserPanel } from "../../workflows/BrowserPanel";
import { useWorkflowUI } from "../../workflows/store";
import { useEffect, useMemo, type ComponentType } from "react";

import { effectiveArtifactDir, hasDrawingFiles, rightPanelTabs } from "../../app/state/artifacts";
import { selectActiveSources } from "../../app/storeSelectors";
import { useAppStore } from "../../app/state";
import type { RightTab } from "../../app/types";
import { Icon, type IconName } from "../../components/Icon";
import { FilePreview } from "./tabs/FilePreview";
import { GitDiff } from "./tabs/GitDiff";
import { MediaPreview } from "./tabs/MediaPreview";
import { ModelPreview } from "./tabs/ModelPreview";
import { ReviewQueue } from "./tabs/ReviewQueue";
import { Sources } from "./tabs/Sources";
import { WebPreview } from "./tabs/WebPreview";

/** 顶栏 tab 的文案与图标；实际显示哪几个由 rightPanelTabs 按内容决定 */
const TAB_META: Record<RightTab, { label: string; icon: IconName }> = {
  pulls: { label: "PR", icon: "branch" },
  browser: { label: "浏览器", icon: "globe" },
  files: { label: "文件", icon: "file" },
  web: { label: "网页", icon: "globe" },
  media: { label: "媒体", icon: "image" },
  model: { label: "3D", icon: "cube" },
  diff: { label: "差异", icon: "diff" },
  review: { label: "审阅", icon: "message" },
  sources: { label: "来源", icon: "book" },
};

const PANES: Record<RightTab, ComponentType> = {
  pulls: ReviewPanel,
  browser: BrowserPanel,
  files: FilePreview,
  web: WebPreview,
  media: MediaPreview,
  model: ModelPreview,
  diff: GitDiff,
  review: ReviewQueue,
  sources: Sources,
};

/**
 * 右栏容器（开发者 Jan）：按内容出现文件 / 网页 / 图片 / 差异 / 来源 / 评审等 tab。
 *
 * 用户主动展开后，暂无内容时显示说明。
 * 标签列表与面板操作分别布局，窄栏时仍能访问最大化与收起按钮。
 */
export function RightPanel() {
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const rightTab = useAppStore((state) => state.rightTab);
  const artifacts = useAppStore((state) => state.artifacts);
  const workspaceImports = useAppStore((state) => state.workspaceImports);
  const diffFiles = useAppStore((state) => state.diffFiles);
  const sources = useAppStore(selectActiveSources);
  const gitDiffStatus = useAppStore((state) => state.gitDiffStatus);
  const unresolvedReviewCount = useAppStore((state) =>
    state.threads
      .find((thread) => thread.id === state.activeThreadId)
      ?.reviewComments.filter((comment) => !comment.resolved).length ?? 0,
  );
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  const previewName = useAppStore((state) => state.activeArtifact?.name);
  const rightPanelMaximized = useAppStore((state) => state.rightPanelMaximized);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const setRightPanelMaximized = useAppStore((state) => state.setRightPanelMaximized);
  const toggleRightPanel = useAppStore((state) => state.toggleRightPanel);

  const docks = useWorkflowUI((s) => s.docks);
  const tabs = useMemo(
    () =>
      [...rightPanelTabs(
        artifacts,
        diffFiles,
        sources,
        gitDiffStatus,
        unresolvedReviewCount,
        hasDrawingFiles(artifacts, workspaceImports),
        artifactDir !== null,
        previewName,
      ), ...docks],
    [artifacts, workspaceImports, diffFiles, sources, gitDiffStatus, unresolvedReviewCount, artifactDir, previewName, docks],
  );

  // 当前 tab 已无内容时，落到第一个仍有内容的 tab
  useEffect(() => {
    if (tabs.length === 0 || tabs.includes(rightTab)) return;
    setRightTab(tabs[0]);
  }, [tabs, rightTab, setRightTab]);

  if (!rightPanelOpen) return null;

  // 顶栏没有的 tab 不会渲染，切换前先取一个有效值，避免闪一帧空内容
  const activeTab = tabs.includes(rightTab) ? rightTab : tabs[0];
  const Pane = activeTab ? PANES[activeTab] : null;

  return (
    <aside className="right-panel" id="session-right-panel" aria-label="右侧面板">
      <div className="right-panel__tabs">
        <div className="right-panel__tab-list">
          {tabs.length === 0 && <span className="right-panel__title">右侧面板</span>}
          {tabs.map((key) => (
            <button
              type="button"
              key={key}
              className={key === activeTab ? "tab tab--active" : "tab"}
              onClick={() => setRightTab(key)}
            >
              <Icon name={TAB_META[key].icon} size={13} />
              {TAB_META[key].label}
            </button>
          ))}
        </div>
        <div className="right-panel__tab-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label={rightPanelMaximized ? "还原右侧面板" : "最大化右侧面板"}
            title={rightPanelMaximized ? "还原右侧面板" : "最大化右侧面板"}
            onClick={() => setRightPanelMaximized(!rightPanelMaximized)}
          >
            <Icon name={rightPanelMaximized ? "restore" : "maximize"} size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="收起右侧面板"
            title="收起右侧面板"
            onClick={toggleRightPanel}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
      <div className="right-panel__body">
        {Pane ? <Pane /> : (
          <div className="panel-empty right-panel__empty">
            <Icon name="panel-right" size={23} />
            <strong>暂无可预览的内容</strong>
            <p>会话生成的文件、代码差异和引用来源会显示在这里。</p>
          </div>
        )}
      </div>
    </aside>
  );
}
