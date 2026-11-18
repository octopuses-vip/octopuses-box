import { ExecutionLocation } from "../workflows/ExecutionLocation";
import { useWorkflowUI } from "../workflows/store";
import { effectiveArtifactDir, hasDrawingFiles, rightPanelTabs } from "../app/state/artifacts";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { formatTokens, selectActiveSources, selectActiveThread } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { shortcutHint } from "../app/platform";
import { IconButton } from "../components/Button";
import { isStandaloneThread } from "../project/projects";

/** 项目下的任务拿不到目录（项目本身没设路径）时的占位文案 */
const PROJECT_PATH_UNSET_LABEL = "未选择项目目录";

/** 会话头部（开发者 Jan）：标题与操作区由布局换行，错误独立展示，保留用量与右栏开关 */
export function SessionHeader() {
  // 订阅 platform 只为了让平台落定后重渲染，从而刷新快捷键文案（快捷键本身由 AppShell 处理）
  useAppStore((state) => state.platform);
  const thread = useAppStore(selectActiveThread);
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const hasDocks = useWorkflowUI((s) => s.docks.length > 0);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useAppStore((state) => state.toggleRightPanel);
  const gitActionError = useAppStore((state) => state.gitActionError);
  const threadUsage = useAppStore((state) => state.threadUsage);
  const projectUsage = useAppStore((state) => state.projectUsage);
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
      state.activeArtifact?.name,
    ).length > 0;
  });

  // 独立会话不归属任何项目，也就没有「项目目录」这一说：它只做纯对话。
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
        <ExecutionLocation label={pathLabel ?? "选择工作目录"} />
      </div>
      <div className="main-head__actions">
        <button className="head-action" onClick={() => useWorkflowUI.getState().open("review")} title="查看拉取请求与检查"><span>审查</span></button>
        <IconButton icon="globe" label="浏览器与页面预览" onClick={() => useWorkflowUI.getState().open("browser")} />
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
        <IconButton
          icon="terminal"
          active={terminalOpen}
          label={`集成终端 (${shortcutHint("J")})`}
          onClick={toggleTerminal}
        />
        <IconButton
          icon="panel-right"
          active={rightPanelOpen}
          label={hasPanelContent || hasDocks ? "右侧面板" : "右侧面板（暂无内容）"}
          title={hasPanelContent || hasDocks ? "右侧面板" : "模型产出文件、差异或审阅意见后即可展开"}
          disabled={!hasPanelContent && !hasDocks}
          onClick={toggleRightPanel}
        />
      </div>
      {gitActionError ? <div className="main-head__error" role="status">{gitActionError}</div> : null}
    </header>
  );
}
