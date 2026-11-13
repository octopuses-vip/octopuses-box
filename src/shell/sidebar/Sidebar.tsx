import { useEffect, useState } from "react";

import { useAppStore } from "../../app/state";
import type { NavKey } from "../../app/types";
import { Icon } from "../../components/Icon";
import { isStandaloneThread } from "../../project/projects";
import { ThreadList } from "./ThreadList";

const NAV_ITEMS: {
  key: NavKey;
  icon: "terminal" | "clock" | "sparkles" | "cube" | "book" | "code";
  label: string;
}[] = [
  { key: "knowledge", icon: "book", label: "知识库" },
  { key: "mcp", icon: "terminal", label: "MCP" },
  { key: "ssh", icon: "terminal", label: "远程主机" },
  { key: "automations", icon: "clock", label: "自动化" },
  { key: "skills", icon: "sparkles", label: "技能" },
  { key: "agents", icon: "cube", label: "Agent" },
  { key: "tools", icon: "code", label: "工具" },
];

/**
 * 左栏（开发者 Jan）：会话列表与归档、任务页入口、以及技能 / MCP / SSH / 自动化等设置入口。
 *
 * 各类资源的「已启用数量」徽标都在这里汇总，便于一眼看出当前生效的能力范围。
 */
export function Sidebar() {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const newChat = useAppStore((state) => state.newChat);
  const newTaskInProject = useAppStore((state) => state.newTaskInProject);
  const threads = useAppStore((state) => state.threads);
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const setActiveProject = useAppStore((state) => state.setActiveProject);
  const openThread = useAppStore((state) => state.openThread);
  const skills = useAppStore((state) => state.skills);
  const disabledSkillIds = useAppStore((state) => state.disabledSkillIds);
  const automations = useAppStore((state) => state.automations);
  const agents = useAppStore((state) => state.agents);
  const projects = useAppStore((state) => state.projects);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const removeProject = useAppStore((state) => state.removeProject);
  const mcpServers = useAppStore((state) => state.mcpServers);
  const sshHosts = useAppStore((state) => state.sshHosts);

  const enabledSkillCount = skills.filter((skill) => !disabledSkillIds.includes(skill.id)).length;
  const enabledMcpCount = mcpServers.filter((server) => server.enabled).length;
  /** 只有启用的主机才会把远程工具挂给模型，因此徽标统计启用数 */
  const enabledSshCount = sshHosts.filter((host) => host.enabled).length;
  // 只统计会定时触发的任务：仅手动触发的任务常驻启用也不该算作「在跑的自动化」
  const scheduledAutomationCount = automations.filter(
    (task) => task.enabled && task.intervalMinutes > 0,
  ).length;

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /** 已展开任务的项目 id：任务归属在各自项目下，因此展开状态按项目记录 */
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  /** 已点过一次删除、等待二次确认的项目 id（删除会连带影响该项目的会话归属） */
  const [confirmProjectId, setConfirmProjectId] = useState<string | null>(null);

  /**
   * 当前项目自动展开（开发者 Jan）。
   *
   * 切换或新建项目后要能一眼看到它下面的任务，否则「任务归属在项目下」这层关系看不出来。
   * 只在项目 id 变化时补一次展开，用户随后手动折叠当前项目不会被这里反复打开。
   */
  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((previous) => {
      if (previous.has(activeProjectId)) return previous;
      const next = new Set(previous);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  /** 展开或收起某个项目下的任务：只影响这层归属关系的展示，不改变当前项目 */
  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  /**
   * 某个项目下的任务：任务即会话，按 `projectId` 归集到所在项目下。
   *
   * 排除子代理派生的子会话（`parentThreadId` 非空）：子会话继承父会话的项目 id，若不排掉就会
   * 在项目下多出一条独立任务，且每次委派（含停止后模型再委派）都再多一条。子会话只属于父会话，
   * 应通过父会话里的「委派子代理」卡片进入，不单独出现在列表里。
   */
  const tasksOfProject = (projectId: string) =>
    threads.filter((thread) => thread.projectId === projectId && !thread.parentThreadId);

  // 独立会话不跟项目走：它们是「临时开一次、上下文只在本次有效」的会话，跨项目收在「会话记录」里更好找。
  // 同样排除子会话：父会话为独立会话时，其子会话的 projectId 也是空串，不排掉就会混进「会话记录」。
  const standaloneThreads = threads.filter(
    (thread) => isStandaloneThread(thread) && !thread.parentThreadId,
  );

/** 函数级说明（开发者 Jan）：执行 badgeFor 的单一职责，并返回可供调用方继续处理的结果。 */
  const badgeFor = (key: NavKey): string | undefined => {
    if (key === "mcp") return String(enabledMcpCount);
    if (key === "ssh") return String(enabledSshCount);
    if (key === "automations") return String(scheduledAutomationCount);
    if (key === "skills") return String(enabledSkillCount);
    if (key === "agents") return String(agents.length);
    return undefined;
  };

  return (
    <aside className="sidebar">
      <nav className="sidebar__rail" aria-label="主导航">
        <div className="sidebar__rail-main">
          <button
            type="button"
            className={view === "search" ? "sidebar__rail-item sidebar__rail-item--active" : "sidebar__rail-item"}
            aria-label="搜索"
            title="搜索"
            data-tooltip="搜索"
            onClick={() => setView("search")}
          >
            <Icon name="search" size={16} />
          </button>
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.key}
              className={view === item.key ? "sidebar__rail-item sidebar__rail-item--active" : "sidebar__rail-item"}
              aria-label={item.label}
              aria-current={view === item.key ? "page" : undefined}
              title={item.label}
              data-tooltip={item.label}
              onClick={() => setView(item.key)}
            >
              <Icon name={item.icon} size={16} />
              {badgeFor(item.key) ? <span className="sidebar__rail-badge">{badgeFor(item.key)}</span> : null}
            </button>
          ))}
        </div>
        <div className="sidebar__rail-footer">
          <button
            type="button"
            className={view === "settings" ? "sidebar__rail-item sidebar__rail-item--active" : "sidebar__rail-item"}
            aria-label="设置"
            title="设置"
            data-tooltip="设置"
            onClick={() => setView("settings")}
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
      </nav>

      <div className="sidebar__workspace">
      <div className="sidebar__scroll">
        <div className="sidebar__workspace-label">工作空间 <span>WORKSPACE</span></div>
        {/*
          顶部行只保留「新建会话」；模型来源 / 账号标识已上移到顶栏（ModelSourceBadge），
          侧栏不再重复展示身份信息。
        */}
        <div className="sidebar__top-row sidebar__top-row--single">
          {/* 会话是独立临时的上下文：不依赖任何项目，任何时候都能开一个全新会话 */}
          <button
            type="button"
            className="nav-item sidebar__new-chat"
            title="开启一个全新的会话"
            onClick={newChat}
          >
            <Icon name="plus" size={15} />
            <span className="nav-item__label">新建会话</span>
          </button>
        </div>
        <div className="sidebar__section">
          <div className="sidebar__section-head">
            <button
              type="button"
              className="sidebar__label"
              aria-expanded={projectsOpen}
              onClick={() => setProjectsOpen((prev) => !prev)}
            >
              <Icon
                name="chevron-right"
                size={11}
                className={projectsOpen ? "tree-chevron tree-chevron--open" : "tree-chevron"}
              />
              项目
              <span className="sidebar__count">{projects.length}</span>
            </button>
            <button
              type="button"
              className="sidebar__icon-btn"
              title="新建项目"
              aria-label="新建项目"
              onClick={() => openProjectDialog()}
            >
              <Icon name="plus" size={12} />
            </button>
          </div>
          {projectsOpen ? (
            <div className="tree">
              {projects.map((project) => {
                const expanded = expandedProjectIds.has(project.id);
                const tasks = tasksOfProject(project.id);
                const isActive = project.id === activeProjectId;
                return (
                  <div
                    className={isActive ? "project-node project-node--active" : "project-node"}
                    key={project.id}
                  >
                    <div className="project-node__head">
                      <button
                        type="button"
                        className="project-node__toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "收起" : "展开"}项目 ${project.name} 的任务`}
                        title={expanded ? "收起任务" : "展开任务"}
                        onClick={() => toggleProjectExpanded(project.id)}
                      >
                        <Icon
                          name="chevron-right"
                          size={11}
                          className={expanded ? "tree-chevron tree-chevron--open" : "tree-chevron"}
                        />
                      </button>
                      <button
                        type="button"
                        title={project.path || "未选择项目目录"}
                        className={isActive ? "nav-item nav-item--active" : "nav-item"}
                        onClick={() => setActiveProject(project.id)}
                      >
                        <Icon name="folder" size={15} />
                        <span className="nav-item__label">{project.name}</span>
                        {/* 任务数常驻：项目收起时也能一眼看出该项目下有多少任务 */}
                        {tasks.length > 0 ? (
                          <span className="nav-item__badge">{tasks.length}</span>
                        ) : null}
                      </button>
                      {/* 任务是项目内的会话：在项目行右侧单独开一个入口，新建的任务直接挂到该项目下 */}
                      <button
                        type="button"
                        className="project-node__add"
                        title={`在 ${project.name} 下新建任务`}
                        aria-label={`在 ${project.name} 下新建任务`}
                        onClick={() => newTaskInProject(project.id)}
                      >
                        <Icon name="plus" size={12} />
                      </button>
                      {/*
                        项目维护入口（开发者 Jan）：编辑与删除都收在左栏项目行里，
                        设置页不再重复维护同一份列表——一个项目只在一处管理，不会两处各改一半。

                        与「+」同一套显现规则（悬停整行，或键盘聚焦到行内）：操作组绝对定位、
                        不占流内宽度，因此显现时项目名不会重排。
                        它落位的这一小格正是任务数徽标所在处，故悬停期间把徽标隐去让位：
                        徽标是标注、鼠标移开即回，比每次划过项目名都截断一截更划算。
                      */}
                      <div className="project-node__actions">
                        <button
                          type="button"
                          className="project-node__action"
                          aria-label={`编辑项目 ${project.name}`}
                          title="编辑"
                          onClick={() => openProjectDialog(project.id)}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <button
                          type="button"
                          className={
                            confirmProjectId === project.id
                              ? "project-node__action project-node__action--danger"
                              : "project-node__action"
                          }
                          aria-label={`删除项目 ${project.name}`}
                          title={confirmProjectId === project.id ? "再点一次确认删除" : "删除"}
                          onClick={() => {
                            if (confirmProjectId === project.id) {
                              removeProject(project.id);
                              setConfirmProjectId(null);
                              return;
                            }
                            setConfirmProjectId(project.id);
                          }}
                          onBlur={() =>
                            setConfirmProjectId((current) =>
                              current === project.id ? null : current,
                            )
                          }
                        >
                          {confirmProjectId === project.id ? (
                            <span className="project-node__confirm-text">删除?</span>
                          ) : (
                            <Icon name="trash" size={13} />
                          )}
                        </button>
                      </div>
                    </div>
                    {expanded ? (
                      <div className="project-node__tasks">
                        <ThreadList
                          threads={tasks}
                          activeThreadId={activeThreadId}
                          onSelect={openThread}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {projects.length === 0 ? (
                <div className="sidebar__empty">暂无项目，点上方 + 选择项目目录添加</div>
              ) : null}
            </div>
          ) : null}
        </div>

        {standaloneThreads.length > 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__section-head">
              <button
                type="button"
                className="sidebar__label"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen((prev) => !prev)}
              >
                <Icon
                  name="chevron-right"
                  size={11}
                  className={sessionsOpen ? "tree-chevron tree-chevron--open" : "tree-chevron"}
                />
                会话记录
                <span className="sidebar__count">{standaloneThreads.length}</span>
              </button>
            </div>
            {sessionsOpen ? (
              <div className="tree tree--nested">
                <ThreadList
                  threads={standaloneThreads}
                  activeThreadId={activeThreadId}
                  onSelect={openThread}
                  emptyText="暂无会话"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      </div>
    </aside>
  );
}
