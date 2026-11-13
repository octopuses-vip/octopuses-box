import { useCallback, useRef, useState } from "react";

import { effectiveArtifactDir, hasDrawingFiles, rightPanelTabs } from "../app/state/artifacts";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { formatTokens, selectActiveSources, selectActiveThread } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { shortcutHint } from "../app/platform";
import { IconButton } from "../components/Button";
import { useConfirm } from "../components/ConfirmProvider";
import { useClickOutside } from "../hooks/useClickOutside";
import { isStandaloneThread } from "../project/projects";

/** 项目下的任务拿不到目录（项目本身没设路径）时的占位文案 */
const PROJECT_PATH_UNSET_LABEL = "未选择项目目录";

/** 会话头部（开发者 Jan）：标题与操作区由布局换行，错误独立展示，保留目录切换、用量与右栏开关 */
export function SessionHeader() {
  // 订阅 platform 只为了让平台落定后重渲染，从而刷新快捷键文案（快捷键本身由 AppShell 处理）
  useAppStore((state) => state.platform);
  const confirm = useConfirm();
  const thread = useAppStore(selectActiveThread);
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useAppStore((state) => state.toggleRightPanel);
  const createThreadWorktree = useAppStore((state) => state.createThreadWorktree);
  const removeThreadWorktree = useAppStore((state) => state.removeThreadWorktree);
  const setThreadExecutionContext = useAppStore((state) => state.setThreadExecutionContext);
  const gitInfo = useAppStore((state) => state.gitInfo);
  const gitActionError = useAppStore((state) => state.gitActionError);
  const threadUsage = useAppStore((state) => state.threadUsage);
  const projectUsage = useAppStore((state) => state.projectUsage);
  const [busy, setBusy] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeWorkspaceMenu = useCallback(() => setWorkspaceMenuOpen(false), []);
  useClickOutside(workspaceMenuRef, workspaceMenuOpen, closeWorkspaceMenu);
  const hasPanelContent = useAppStore((state) => {
    const unresolved = state.threads
      .find((item) => item.id === state.activeThreadId)
      ?.reviewComments.filter((comment) => !comment.resolved).length ?? 0;
    return rightPanelTabs(
      state.artifacts,
      state.diffFiles,
      selectActiveSources(state),
      state.gitDiffStatus,
      unresolved,
      hasDrawingFiles(state.artifacts, state.workspaceImports),
      effectiveArtifactDir(state) !== null,
    ).length > 0;
  });

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      // store 展示错误
    } finally {
      setBusy(false);
    }
  };

/** 函数级说明（开发者 Jan）：执行 remove 的单一职责，并返回可供调用方继续处理的结果。 */
  const remove = async () => {
    setBusy(true);
    try {
      await removeThreadWorktree(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Worktree 有未提交改动时后端会拒绝移除，这里再确认一次是否强制移除（分支会保留）
      const force =
        message.includes("未提交改动") &&
        (await confirm({
          title: "强制移除 Worktree",
          message: "Worktree 存在未提交改动。确认强制移除？分支不会被删除。",
          confirmText: "强制移除",
          danger: true,
        }));
      if (force) await removeThreadWorktree(true);
    } finally {
      setBusy(false);
    }
  };

  // 独立会话不归属任何项目，也就没有「项目目录」这一说：它只做纯对话，因此不给目录入口。
  // 路径行也只在确有工作目录时才有内容（历史会话可能沿用着旧目录）
  const standalone = thread ? isStandaloneThread(thread) : false;

  /**
   * 路径行文案（开发者 Jan）。
   *
   * 项目下的任务用项目目录，项目本身没设路径时如实提示「未选择项目目录」；
   * 普通会话没有目录概念，没有工作目录时整行不渲染，避免出现无从下手、且提法不对的占位文案。
   */
  const pathLabel = workspacePath ?? (standalone ? null : PROJECT_PATH_UNSET_LABEL);

  return (
    <header className="main-head">
      <div className="main-head__identity">
        <div className="main-head__title">{thread?.title ?? "新会话"}</div>
        {pathLabel || thread?.branch ? (
          <div className="main-head__path" title={workspacePath ?? undefined}>
            {pathLabel}
            {thread?.branch ? ` · ${thread.branch}` : ""}
          </div>
        ) : null}
      </div>
      <div className="main-head__actions">
        {/* 用量来自会话库的 run_usage 汇总（服务端口径），无记录时不占位 */}
        {threadUsage && threadUsage.runs > 0 ? (
          <span
            className="main-head__usage"
            title={`本会话 ${threadUsage.runs} 次运行：输入 ${threadUsage.promptTokens} · 输出 ${threadUsage.completionTokens}${
              projectUsage && projectUsage.runs > 0
                ? `\n本项目 ${projectUsage.runs} 次运行合计 ${projectUsage.totalTokens} tokens`
                : ""
            }`}
          >
            本会话 {formatTokens(threadUsage.totalTokens)}
            {projectUsage && projectUsage.runs > 0
              ? ` · 项目 ${formatTokens(projectUsage.totalTokens)}`
              : ""}
          </span>
        ) : null}
        <div
          ref={workspaceMenuRef}
          className="workspace-menu"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeWorkspaceMenu();
            workspaceTriggerRef.current?.focus();
          }}
        >
          <button
            ref={workspaceTriggerRef}
            type="button"
            className="btn btn--sm"
            disabled={busy || !thread || standalone}
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
            title={workspacePath ?? "当前会话没有工作目录"}
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
          >
            工作目录
          </button>
          {workspaceMenuOpen ? (
            <div className="menu menu--right workspace-menu__panel" role="menu" aria-label="会话工作目录">
              <div className="menu__hint">
                当前：{thread?.executionContext === "worktree" ? "Worktree" : "本地目录"}
                {workspacePath ? ` · ${workspacePath}` : " · 尚未选择项目目录"}
              </div>
              {thread?.worktreePath ? (
                <>
                  <button
                    type="button"
                    className="menu__item"
                    role="menuitem"
                    onClick={() => {
                      setThreadExecutionContext(
                        thread.id,
                        thread.executionContext === "worktree" ? "local" : "worktree",
                      );
                      closeWorkspaceMenu();
                      void Promise.all([
                        useAppStore.getState().refreshGit(),
                        useAppStore.getState().loadGitDiff(),
                      ]);
                    }}
                  >
                    <span className="menu__item-title">
                      {thread.executionContext === "worktree" ? "切换到本地目录" : "切换到 Worktree"}
                    </span>
                    <span className="menu__item-desc">保留当前 Worktree，可随时切回</span>
                  </button>
                  <button type="button" className="menu__item" role="menuitem" disabled={busy} onClick={() => { closeWorkspaceMenu(); void remove(); }}>
                    <span className="menu__item-title">移除 Worktree</span>
                    <span className="menu__item-desc">删除独立目录；有未提交改动时需要再次确认</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="menu__item"
                  role="menuitem"
                  disabled={busy || !workspacePath || gitInfo?.isRepository !== true}
                  onClick={() => { closeWorkspaceMenu(); void perform(createThreadWorktree); }}
                >
                  <span className="menu__item-title">创建 Worktree</span>
                  <span className="menu__item-desc">
                    {!workspacePath
                      ? "先为项目选择目录"
                      : gitInfo?.isRepository !== true
                        ? "当前目录不是 Git 仓库"
                        : "为本会话创建独立分支和工作目录"}
                  </span>
                </button>
              )}
            </div>
          ) : null}
        </div>
        <IconButton
          icon="terminal"
          active={terminalOpen}
          label={`集成终端 (${shortcutHint("J")})`}
          onClick={toggleTerminal}
        />
        <IconButton
          icon="panel-right"
          active={rightPanelOpen}
          label={hasPanelContent ? "右侧面板" : "右侧面板（暂无内容）"}
          title={hasPanelContent ? "右侧面板" : "模型产出文件、差异或审阅意见后即可展开"}
          disabled={!hasPanelContent}
          onClick={toggleRightPanel}
        />
      </div>
      {gitActionError ? <div className="main-head__error" role="status">{gitActionError}</div> : null}
    </header>
  );
}
