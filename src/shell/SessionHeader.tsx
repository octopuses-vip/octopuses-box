import { ExecutionLocation } from "../workflows/ExecutionLocation";
import { useWorkflowUI } from "../workflows/store";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { formatTokens, selectActiveThread } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { shortcutHint } from "../app/platform";
import { IconButton } from "../components/Button";
import { Icon } from "../components/Icon";

/** 会话头部（开发者 Jan）：标题与操作区由布局换行，错误独立展示，保留用量与右栏开关 */
export function SessionHeader() {
  // 订阅 platform 只为了让平台落定后重渲染，从而刷新快捷键文案（快捷键本身由 AppShell 处理）
  useAppStore((state) => state.platform);
  const thread = useAppStore(selectActiveThread);
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const rightTab = useAppStore((state) => state.rightTab);
  const toggleRightPanel = useAppStore((state) => state.toggleRightPanel);
  const gitActionError = useAppStore((state) => state.gitActionError);
  const threadUsage = useAppStore((state) => state.threadUsage);
  const projectUsage = useAppStore((state) => state.projectUsage);

  const title = thread?.title ?? "新会话";
  const projectUsageLabel = projectUsage && projectUsage.runs > 0
    ? `\n本项目 ${projectUsage.runs} 次运行合计 ${projectUsage.totalTokens} tokens`
    : "";

  return (
    <header className="main-head">
      <div className="main-head__identity">
        <h1 className="main-head__title" title={title}>{title}</h1>
        <ExecutionLocation path={workspacePath} />
      </div>
      <div className="main-head__actions">
        <button type="button" className="head-action" onClick={() => useWorkflowUI.getState().open("review")} title="查看拉取请求与检查">
          <Icon name="branch" size={14} />
          <span>审查</span>
        </button>
        <IconButton
          icon="globe"
          label="浏览器与页面预览"
          title="浏览器与页面预览"
          active={rightPanelOpen && rightTab === "browser"}
          onClick={() => useWorkflowUI.getState().open("browser")}
        />
        {/* 用量来自会话库的 run_usage 汇总（服务端口径），无记录时不占位 */}
        {threadUsage && threadUsage.runs > 0 ? (
          <span
            className="main-head__usage"
            title={`本会话 ${threadUsage.runs} 次运行合计 ${threadUsage.totalTokens} tokens\n输入 ${threadUsage.promptTokens} · 输出 ${threadUsage.completionTokens}${projectUsageLabel}`}
          >
            {formatTokens(threadUsage.totalTokens)} tokens
          </span>
        ) : null}
        <IconButton
          icon="terminal"
          active={terminalOpen}
          label={`集成终端 (${shortcutHint("J")})`}
          title={`集成终端 (${shortcutHint("J")})`}
          aria-expanded={terminalOpen}
          onClick={toggleTerminal}
        />
        <IconButton
          icon="panel-right"
          active={rightPanelOpen}
          label="右侧面板"
          title={rightPanelOpen ? "收起右侧面板" : "展开右侧面板"}
          aria-expanded={rightPanelOpen}
          aria-controls={rightPanelOpen ? "session-right-panel" : undefined}
          onClick={toggleRightPanel}
        />
      </div>
      {gitActionError ? <div className="main-head__error" role="status">{gitActionError}</div> : null}
    </header>
  );
}
