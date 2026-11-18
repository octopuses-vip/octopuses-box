import { useBrowserAnnotations } from "../workflows/useBrowserAnnotations";
import { WorkflowDialog } from "../workflows/WorkflowDialog";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ComponentType, CSSProperties } from "react";

import { retireLegacyHost } from "../app/desktop/companion";
import { listenTrayCheckUpdate } from "../app/desktop/updates";
import { effectiveArtifactDir } from "../app/state/artifacts";
import { selectActiveThread } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { APP_NAME } from "../app/meta";
import { resolvePlatform, shortcutHint } from "../app/platform";
import type { NavKey } from "../app/types";
import { GoalWorker } from "../tasks/GoalWorker";
import { AutomationScheduler } from "../automations/AutomationScheduler";
import { useVideoWorker } from "../video/useVideoWorker";
import { useCacheSync } from "../cache/useCacheSync";
import { useKnowledgeSync } from "../knowledge/useKnowledgeSync";
import { IconButton } from "../components/Button";
import { Icon } from "../components/Icon";
import { useFileDropRouter } from "../hooks/useFileDropRouter";
import { ProjectDialog } from "../project/ProjectDialog";
import { CommandPalette } from "./CommandPalette";
import { PanelSplitter } from "./PanelSplitter";
import { Sidebar } from "./sidebar/Sidebar";
import { ModelSourceBadge } from "./sidebar/ModelSourceBadge";
import { RightPanel } from "./rightpanel/RightPanel";
import { ThreadView } from "./ThreadView";
import { UpdateNotice, UpdatePrompt } from "./UpdatePrompt";
import { WindowControls } from "./WindowControls";

const PAGES: Partial<Record<NavKey, ComponentType>> = {
  search: lazy(() => import("../pages/SearchPage").then((m) => ({ default: m.SearchPage }))),
  knowledge: lazy(() => import("../pages/KnowledgePage").then((m) => ({ default: m.KnowledgePage }))),
  mcp: lazy(() => import("../pages/McpPage").then((m) => ({ default: m.McpPage }))),
  ssh: lazy(() => import("../pages/SshPage").then((m) => ({ default: m.SshPage }))),
  automations: lazy(() => import("../pages/AutomationsPage").then((m) => ({ default: m.AutomationsPage }))),
  skills: lazy(() => import("../pages/SkillsPage").then((m) => ({ default: m.SkillsPage }))),
  agents: lazy(() => import("../pages/AgentsPage").then((m) => ({ default: m.AgentsPage }))),
  tools: lazy(() => import("../pages/ToolsPage").then((m) => ({ default: m.ToolsPage }))),
  settings: lazy(() => import("../pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))),
};

const Terminal = lazy(() => import("./Terminal").then((m) => ({ default: m.Terminal })));

const VIEW_TITLE: Record<NavKey, string> = {
  newchat: "新建会话",
  search: "搜索",
  knowledge: "知识库",
  mcp: "MCP",
  ssh: "远程主机",
  automations: "自动化",
  skills: "技能",
  agents: "Agent",
  tools: "工具",
  projects: "项目",
  chats: "会话",
  settings: "设置",
};

/**
 * 还没有任何项目时主区展示的引导（开发者 Jan）。
 *
 * 任务必须归集在项目下，所以第一步是让用户建一个项目；与侧栏的 + 按钮走同一条流程：
 * 唤起统一的项目弹窗，在里面选目录、绑定 MCP / 技能、填项目提示词。
 */
function ProjectOnboarding() {
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const newChat = useAppStore((state) => state.newChat);

  return (
    <div className="empty-state">
      <div className="empty-state__mark" aria-hidden="true"><Icon name="sparkles" size={25} /></div>
      <h1 className="empty-state__title">从这里开始</h1>
      <p className="empty-state__desc">直接开始会话，或选择一个本地目录来创建项目。</p>
      <div className="empty-state__actions">
        <button type="button" className="btn btn--primary" onClick={newChat}>
          <Icon name="pencil" size={15} />
          新建会话
        </button>
        <button type="button" className="btn" onClick={() => openProjectDialog()}>
          <Icon name="folder" size={15} />
          新建项目
        </button>
      </div>
    </div>
  );
}

/**
 * 已选中项目、但该项目下还没有任何任务时主区展示的引导（开发者 Jan）。
 *
 * 任务即会话，必须归集在项目下，所以项目下没有任务时先引导用户新建一个；
 * 这里刻意不渲染对话输入区，避免把消息发到不存在的会话上。
 */
function ProjectTaskOnboarding({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const newTaskInProject = useAppStore((state) => state.newTaskInProject);

  return (
    <div className="empty-state">
      <div className="empty-state__mark" aria-hidden="true"><Icon name="folder" size={25} /></div>
      <h1 className="empty-state__title">{projectName}</h1>
      <p className="empty-state__desc">这个项目还没有会话。</p>
      <button type="button" className="btn btn--primary" onClick={() => newTaskInProject(projectId)}>
        <Icon name="plus" size={14} />
        新建项目会话
      </button>
    </div>
  );
}

/**
 * 全局轻提示（开发者 Jan）。
 *
 * 导入、导出这类一次性结果需要一个统一出口：文案写进 store 后由这里呈现，
 * 到时由 store 侧的定时器自动清空。样式沿用更新提示的底部提示条。
 */
function NoticeToast() {
  const notice = useAppStore((state) => state.notice);
  if (!notice) return null;
  return (
    <div className="toast" role="status">
      <Icon name="info" size={14} />
      <span>{notice}</span>
    </div>
  );
}

/**
 * 应用主壳（开发者 Jan）：标题栏、左栏、消息流、输入区与右栏的布局与全局快捷键。
 *
 * 启动时的各类加载（会话、模型配置、技能、MCP、SSH、产物、自动化）都收在这里，
 * 让「应用起来要准备什么」有一个明确且唯一的入口。
 */
export function AppShell() {
  useBrowserAnnotations();
  const view = useAppStore((state) => state.view);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const rightPanelWidth = useAppStore((state) => state.rightPanelWidth);
  const rightPanelMaximized = useAppStore((state) => state.rightPanelMaximized);
  /** 是否正在拖动右栏分隔条：拖动期间关掉列宽过渡，否则列宽会追着动画走、拖不跟手 */
  const [resizingRightPanel, setResizingRightPanel] = useState(false);
  const commandPaletteOpen = useAppStore((state) => state.commandPaletteOpen);
  const setCommandPaletteOpen = useAppStore((state) => state.setCommandPaletteOpen);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const terminalOpen = useAppStore((state) => state.terminalOpen);

  const projects = useAppStore((state) => state.projects);
  const project = projects.find((item) => item.id === activeProjectId);
  const Page = PAGES[view];
  /**
   * 当前打开的会话（开发者 Jan）。
   *
   * 会话与项目是两条独立的线：独立会话不归属任何项目，因此判定「主区该显示什么」看的是
   * 有没有当前会话，而不是当前项目下有没有会话。项目本身不再参与这一判定。
   */
  const activeThread = useAppStore(selectActiveThread);

  // 主界面挂载期间把会话记录与产物同步到缓存路径
  useCacheSync();
  useVideoWorker();
  useKnowledgeSync();

  // 拖放统一路由：图纸导入工作目录、其余文件转交输入框当附件（幂等，只装一次监听）
  useFileDropRouter();

  // 启动时落定平台：桌面端取 Tauri 权威值，浏览器演示环境回落 UA 推断值。
  // 结果写入 store 触发重渲染，同时更新 <html data-platform> 让 CSS 变量随之切换。
  const setPlatform = useAppStore((state) => state.setPlatform);
  const platform = useAppStore((state) => state.platform);
  useEffect(() => {
    void resolvePlatform().then(setPlatform);
  }, [setPlatform]);

  // 启动时先把缓存目录里的会话读回来，再允许落盘（useCacheSync 内部按 sessionsRestored 把关）
  const sessionsRestored = useAppStore((state) => state.sessionsRestored);
  const sessionsRestoring = useAppStore((state) => state.sessionsRestoring);
  const sessionsRestoreError = useAppStore((state) => state.sessionsRestoreError);
  const sessionScope = useAppStore((state) => state.cachePath);
  const restoreSessions = useAppStore((state) => state.restoreSessions);
  useEffect(() => {
    if (sessionsRestored || sessionsRestoring || sessionsRestoreError) return;
    void restoreSessions();
  }, [sessionsRestored, sessionsRestoring, sessionsRestoreError, sessionScope, restoreSessions]);

  // 重启后已处于登录态时补取一次模型连接信息（连接信息不持久化）
  const modelConfigStatus = useAppStore((state) => state.modelConfigStatus);
  const loadModelConfig = useAppStore((state) => state.loadModelConfig);
  useEffect(() => {
    if (modelConfigStatus === "idle") void loadModelConfig();
  }, [modelConfigStatus, loadModelConfig]);

  // 启动时查一次客户端新版本：该接口免登录，进入主界面即可查询；
  // 查到新版本由 UpdatePrompt 弹出提示，查不到（含失败）静默跳过。
  // 本地模式不连管理端，跳过——没有可查的版本源
  const updateCheckStatus = useAppStore((state) => state.updateCheckStatus);
  const checkUpdate = useAppStore((state) => state.checkUpdate);
  const modelSource = useAppStore((state) => state.modelSource);
  useEffect(() => {
    if (updateCheckStatus === "idle" && modelSource === "remote") void checkUpdate();
  }, [updateCheckStatus, checkUpdate, modelSource]);

  // 托盘菜单的「检查更新」：原生侧负责唤起窗口并把点击转成事件，这里接住后发起一次手动检查。
  // 手动检查带 manual 标记，因此没有新版本时也会给出「已是最新版本」的反馈
  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | null = null;
    void listenTrayCheckUpdate(() => void useAppStore.getState().checkUpdate(true)).then((off) => {
      if (disposed) off();
      else stopListening = off;
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  // 读回上一次更新的结论：更新期间客户端已经退出，安装成败只能事后说明。
  // 必须等启动检查更新结束再读——检查开始时会清空提示条，先读的话刚写进去的失败原因会被立刻抹掉
  const consumeUpdateOutcome = useAppStore((state) => state.consumeUpdateOutcome);
  const updateCheckSettled = updateCheckStatus === "ready" || updateCheckStatus === "error";
  useEffect(() => {
    if (!updateCheckSettled) return;
    void consumeUpdateOutcome();
  }, [updateCheckSettled, consumeUpdateOutcome]);

  // 启动时扫描一次技能并读取产物列表与自动化任务，缓存目录变更后重新读取；
  // 技能扫描同时会刷新技能索引 SKILLS.md
  const cachePath = useAppStore((state) => state.cachePath);
  useEffect(() => {
    if (!cachePath) return;
    void retireLegacyHost(cachePath).catch((error: unknown) => {
      if (useAppStore.getState().cachePath === cachePath) {
        const message = error instanceof Error ? error.message : String(error);
        useAppStore.getState().showNotice(message);
      }
    });
  }, [cachePath]);
  const loadSkills = useAppStore((state) => state.loadSkills);
  const loadAgents = useAppStore((state) => state.loadAgents);
  const loadMcpServers = useAppStore((state) => state.loadMcpServers);
  const loadSshHosts = useAppStore((state) => state.loadSshHosts);
  const loadArtifacts = useAppStore((state) => state.loadArtifacts);
  const loadAutomations = useAppStore((state) => state.loadAutomations);
  const loadParallelBatches = useAppStore((state) => state.loadParallelBatches);
  const loadUsage = useAppStore((state) => state.loadUsage);
  useEffect(() => {
    if (!cachePath) return;
    void loadSkills();
    // Agent 同样启动即扫描，新建会话选择器与自动化绑定依赖这份列表
    void loadAgents();
    // MCP 服务启动时一并读取配置并拉取工具，保证首轮对话就能挂上 MCP 工具
    void loadMcpServers();
    // 远程主机配置同样是运行期依赖：启动就读，首轮对话即可使用已启用的主机
    void loadSshHosts();
    void loadAutomations();
    void loadParallelBatches();
    void loadUsage();
  }, [
    cachePath,
    loadSkills,
    loadAgents,
    loadMcpServers,
    loadSshHosts,
    loadAutomations,
    loadParallelBatches,
    loadUsage,
  ]);

  // 产物列表按「当前会话的产物目录」读取：项目会话在项目 `output/`，临时会话在缓存 `outputs/<日期>/`。
  // 目录一变（切会话、切项目、换工作区、换缓存目录、启动时会话读回）就重读一次，
  // 这样启动时即使会话还没读回来，读回之后也会自动补上，不必在每个切换入口各写一遍
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  useEffect(() => {
    void loadArtifacts();
  }, [artifactDir, loadArtifacts]);

  // 旧产物一次性迁移（开发者 Jan）：产物目录改成按会话定位之前，所有会话共用 `<缓存>/artifacts/`，
  // 历史产物留在旧目录里，右栏按新目录列就什么都看不到。归属要靠会话记录里的工具片段算，
  // 所以必须等会话读回来再跑；每次启动最多一次，见 store 里的 `migrateLegacyArtifacts`
  const migrateLegacyArtifacts = useAppStore((state) => state.migrateLegacyArtifacts);
  useEffect(() => {
    if (!sessionsRestored || !cachePath) return;
    void migrateLegacyArtifacts();
  }, [sessionsRestored, cachePath, migrateLegacyArtifacts]);

  // 会话/项目切换后重新汇总用量：两个维度都跟着当前会话走
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  useEffect(() => {
    if (!cachePath || !sessionsRestored) return;
    void loadUsage();
  }, [cachePath, sessionsRestored, activeThreadId, activeProjectId, loadUsage]);

  useEffect(() => {
/** 函数级说明（开发者 Jan）：执行 handleKeyDown 的单一职责，并返回可供调用方继续处理的结果。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      // 主修饰键按平台取：macOS 是 ⌘，其余平台是 Ctrl。二者只取其一而不是「任一命中」，
      // 否则 macOS 上 Ctrl+K 会被抢走，打断集成终端里的 readline 快捷键。
      const primaryModifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (!primaryModifier) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setCommandPaletteOpen(!useAppStore.getState().commandPaletteOpen);
      }
      if (key === "j") {
        event.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [platform, setCommandPaletteOpen, toggleTerminal]);

  /**
   * 三栏骨架的类名（开发者 Jan）。
   *
   * 只负责叠加状态类，具体列宽交给 CSS 变量决定；右栏开合、右栏最大化、
   * 拖动中三者可以同时成立，因此用拼接而不是三元表达式。
   */
  const shellClass = [
    "shell",
    rightPanelOpen ? "shell--right-open" : "",
    rightPanelMaximized ? "shell--right-maximized" : "",
    resizingRightPanel ? "shell--resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  /**
   * 拖动过的右栏宽度以行内变量落地（开发者 Jan）。
   *
   * 未拖动过（`rightPanelWidth` 为 null）时不写行内值，宽度由 tokens.css 的默认值决定；
   * 最大化时列宽由 `--col-right: 1fr` 决定，行内值必须让位，否则会把最大化的结果覆盖掉。
   */
  const shellStyle =
    rightPanelOpen && !rightPanelMaximized && typeof rightPanelWidth === "number"
      ? ({ "--col-right": `${rightPanelWidth}px` } as CSSProperties)
      : undefined;

  return (
    <div className="app-root">
      <header className="titlebar" data-tauri-drag-region>
        <img className="brand-mark brand-mark--sm" src="/logo.png" alt="" />
        <span className="titlebar__brand">{APP_NAME}</span>
        {project && <span className="titlebar__crumb" title={project.name}>{project.name}</span>}
        <span className="spacer" />
        <div className="titlebar__actions">
          <ModelSourceBadge />
          <IconButton
            icon="search"
            label={`命令面板 (${shortcutHint("K")})`}
            title={`命令面板 (${shortcutHint("K")})`}
            aria-haspopup="dialog"
            aria-expanded={commandPaletteOpen}
            onClick={() => setCommandPaletteOpen(true)}
          />
          {/* 集成终端开关只保留会话头部一处：顶栏重复入口已移除，⌘J 快捷键仍全局可用 */}
        </div>
        <WindowControls />
      </header>

      <div className={shellClass} style={shellStyle}>
        <div className="shell__sidebar">
          <Sidebar />
        </div>
        <main className="shell__main" data-view={view}>
          {Page ? (
            <>
              {/*
                管理页头部与会话头部保持同一形态（开发者 Jan）：标题在上、次要信息在下，
                结构收进 `main-head__identity` 由布局决定换行。
                目录用 `main-head__workspace` 压成单行省略号并把完整路径放进 title——
                它可能是很深的绝对路径，铺在头部会把操作区挤走或直接撑出边界。
              */}
              <header className="main-head main-head--management">
                <div className="main-head__identity">
                  <h1 className="main-head__title">{VIEW_TITLE[view]}</h1>
                  {project?.path && <div
                    className="main-head__path main-head__workspace"
                    title={project.path}
                  >
                    {project.path}
                  </div>}
                </div>
              </header>
              <Suspense fallback={<div className="panel-empty" role="status">正在加载页面…</div>}>
                <Page />
              </Suspense>
            </>
          ) : activeThread ? (
            <ThreadView />
          ) : project ? (
            /* 项目下没有会话时先引导新建：任务必须有项目归属，不能把消息发到空会话上 */
            <ProjectTaskOnboarding projectId={project.id} projectName={project.name} />
          ) : (
            /* 既没有当前会话也没有当前项目时，先引导用户添加项目 */
            <ProjectOnboarding />
          )}
          {/*
           * 集成终端挂在骨架层而不是会话视图里（开发者 Jan）。
           *
           * 终端属于整个客户端而非某一个会话：原先它只由 ThreadView 渲染，导致在设置、
           * 知识库这类页面点顶栏的终端按钮时状态改了却无处呈现，看起来就是「点了没反应」。
           * 放在主区末尾后，任何视图下都能开合，且切换视图不会打断正在跑的 shell。
           */}
          {terminalOpen ? (
            <Suspense fallback={<div className="panel-empty" role="status">正在加载终端…</div>}>
              <Terminal />
            </Suspense>
          ) : null}
        </main>
        <PanelSplitter onResizingChange={setResizingRightPanel} />
        <div className="shell__right">
          <RightPanel />
        </div>
      </div>

      <CommandPalette />
      <UpdatePrompt />
      <UpdateNotice />
      <NoticeToast />
      <ProjectDialog />
      <WorkflowDialog />
      <AutomationScheduler />
      <GoalWorker />
    </div>
  );
}
