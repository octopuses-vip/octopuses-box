import { useState } from "react";

import { useAppStore } from "../app/state";
import { APP_NAME } from "../app/meta";
import type { AgentItem, Automation, AutomationRun, AutomationSuggestion, Project } from "../app/types";
import { describeSchedule, parseCron } from "../automations/cron";
import { useAutomationRunner } from "../automations/useAutomationRunner";
import { Icon } from "../components/Icon";

const RUN_STATUS: Record<AutomationRun["status"], string> = {
  queued: "排队中", running: "运行中", success: "已完成", failed: "失败", aborted: "已中断",
};

/** 触发间隔预设；0 表示只手动触发，不参与定时检查 */
const INTERVAL_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: "仅手动触发" },
  { value: 15, label: "每 15 分钟" },
  { value: 60, label: "每小时" },
  { value: 360, label: "每 6 小时" },
  { value: 1440, label: "每天" },
  { value: 10080, label: "每周" },
];

/** 触发时间戳换成「本地时间」文案 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

/** 任务归属项目名；项目已被移除时回落为 id，保证任务仍可辨识 */
function projectName(projects: Project[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

/**
 * 自动化任务：任务清单（本地落盘在缓存目录 automations/tasks.json）与运行记录。
 *
 * 「立即运行」与定时触发共用同一条执行链路，任何时候同一任务只会有一轮运行。每个任务复用自己的
 * 会话：首轮运行创建线程并回写，之后每轮接在同一个会话里，上下文连续；应用关闭期间由注册到
 * 系统的后台定时项（LaunchAgent）到点重新唤起执行。
 */
export function AutomationsPage() {
  const automations = useAppStore((state) => state.automations);
  const automationRuns = useAppStore((state) => state.automationRuns);
  const automationError = useAppStore((state) => state.automationError);
  const scheduleError = useAppStore((state) => state.automationScheduleError);
  const cachePath = useAppStore((state) => state.cachePath);
  const createAutomation = useAppStore((state) => state.createAutomation);
  const toggleAutomation = useAppStore((state) => state.toggleAutomation);
  const removeAutomation = useAppStore((state) => state.removeAutomation);
  const threads = useAppStore((state) => state.threads);
  const sessionsRestored = useAppStore((state) => state.sessionsRestored);
  const sessionsRestoreError = useAppStore((state) => state.sessionsRestoreError);
  const projects = useAppStore((state) => state.projects);
  const agents = useAppStore((state) => state.agents);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const runAutomation = useAutomationRunner();

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [cron, setCron] = useState("");
  // 默认归属当前项目：新建任务多半就是给正在做的项目加一条定时任务
  const defaultProjectId = projects.some((project) => project.id === activeProjectId)
    ? activeProjectId
    : projects[0]?.id ?? "";
  const [projectId, setProjectId] = useState(defaultProjectId);
  // 绑定的 Agent：空串表示不绑定，运行时按普通会话跑
  const [agentId, setAgentId] = useState("");

  const enabledCount = automations.filter((task) => task.enabled).length;
  const threadIds = new Set(threads.map((thread) => thread.id));
  const sessionsReady = sessionsRestored && !sessionsRestoreError;
  const unavailableConversation = sessionsRestoreError
    ? "会话记录读取失败"
    : sessionsRestored ? "关联会话已不存在" : "正在加载会话";
  const invalidCron = cron.trim().length > 0 && !parseCron(cron);
  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0 && projectId.length > 0 && !invalidCron;

/** 函数级说明（开发者 Jan）：执行 handleRun 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleRun = async (automationId: string) => {
    if (await runAutomation(automationId, "manual") === null) {
      useAppStore.getState().showNotice("未能启动任务，请确认会话已恢复且没有同一任务正在运行。");
    }
  };

  const openRunConversation = (threadId: string) => {
    const state = useAppStore.getState();
    if (!state.sessionsRestored || state.sessionsRestoreError || !state.threads.some((thread) => thread.id === threadId)) {
      state.showNotice("关联会话当前不可用，仍可在运行记录中查看结果。");
      return;
    }
    state.openThread(threadId);
  };

/** 函数级说明（开发者 Jan）：执行 resetForm 的单一职责，并返回可供调用方继续处理的结果。 */
  const resetForm = () => {
    setName("");
    setPrompt("");
    setIntervalMinutes(1440);
    setCron("");
    setProjectId(defaultProjectId);
    setAgentId("");
  };

/** 函数级说明（开发者 Jan）：执行 handleCreate 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleCreate = () => {
    if (!canSubmit) return;
    createAutomation({ name, prompt, projectId, intervalMinutes, cron, agentId: agentId || null });
    resetForm();
    setFormOpen(false);
  };

  /** 点建议：把标题与提示词填进新建表单，让用户确认后再建任务 */
  const applySuggestion = (suggestion: AutomationSuggestion, automationId: string) => {
    const owner = automations.find((task) => task.id === automationId);
    setName(suggestion.title);
    setPrompt(suggestion.prompt);
    if (owner) setProjectId(owner.projectId);
    if (owner) setAgentId(owner.agentId ?? "");
    setFormOpen(true);
  };

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          {APP_NAME} 按计划触发任务。普通任务复用会话，本地向量索引的结果直接显示在运行记录。
          任务与运行记录存放在缓存目录
          {cachePath ? ` ${cachePath}/automations/` : "（尚未配置缓存目录）"}；
          应用开着时由应用内调度器计时，应用关闭后由注册到系统的后台定时项到点重新唤起执行，
          错过的最近一次会在下次启动时补跑。
        </p>

        {automationError ? (
          <div className="card">
            <div className="card__desc">读取任务失败：{automationError}</div>
          </div>
        ) : null}
        {scheduleError && <p className="inline-error" role="alert">{scheduleError}</p>}

        <div className="page__section">
          <div className="page__section-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>
              任务 {automations.length} · 已启用 {enabledCount}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setFormOpen((prev) => !prev)}
            >
              {formOpen ? "收起" : "新建任务"}
            </button>
          </div>

          {formOpen ? (
            <div className="card">
              <label className="form__row">
                <span className="form__label">任务名称</span>
                <input
                  className="form__input"
                  value={name}
                  placeholder="例如：每日项目状态整理"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="form__row">
                <span className="form__label">任务提示词</span>
                <textarea
                  className="form__textarea"
                  value={prompt}
                  placeholder="触发时作为用户消息发给模型的内容"
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              <label className="form__row">
                <span className="form__label">cron 表达式（可选）</span>
                <input
                  className="form__input"
                  value={cron}
                  placeholder="留空按触发间隔；例如 30 9 * * 1（每周一 09:30）"
                  onChange={(event) => setCron(event.target.value)}
                />
              </label>
              <div className="form__grid">
                <label className="form__row">
                  <span className="form__label">触发间隔</span>
                  <select
                    className="form__select"
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                  >
                    {INTERVAL_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form__row">
                  <span className="form__label">归属项目</span>
                  <select
                    className="form__select"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form__row">
                  <span className="form__label">绑定 Agent</span>
                  <select
                    className="form__select"
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    <option value="">不绑定（普通会话）</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="page__desc" style={{ marginTop: 0 }}>
                填了 cron 时以 cron 为准（5 段：分 时 日 月 周）；「每 N 分钟」与「每天 / 每周定点」
                可在应用关闭后由系统唤起，其余复杂表达式只在应用运行时触发。
              </p>
              {invalidCron && <p className="inline-error">cron 格式无效，请填写 5 段的时间表达式。</p>}
              <div className="login__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={!canSubmit}
                  onClick={handleCreate}
                >
                  创建
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    resetForm();
                    setFormOpen(false);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {automations.length === 0 ? (
            <div className="card">
              <div className="card__desc">还没有任务。点「新建任务」写下提示词，再按需启用定时触发。</div>
            </div>
          ) : (
            automations.map((task) => (
              <AutomationRow
                key={task.id}
                task={task}
                projects={projects}
                agents={agents}
                hasConversation={sessionsReady && task.threadId !== null && threadIds.has(task.threadId)}
                busy={automationRuns.some(
                  (runItem) =>
                    runItem.automationId === task.id &&
                    (runItem.status === "queued" || runItem.status === "running"),
                )}
                onToggle={() => toggleAutomation(task.id)}
                onRun={() => void handleRun(task.id)}
                onRemove={() => removeAutomation(task.id)}
              />
            ))
          )}
        </div>

        <div className="page__section">
          <div className="page__section-label">运行记录 {automationRuns.length}</div>
          {automationRuns.length === 0 ? (
            <div className="card">
              <div className="card__desc">任务运行后会在这里显示触发方式、完成时间和结果。</div>
            </div>
          ) : (
            automationRuns.map((run) => {
              const canOpen = sessionsReady && threadIds.has(run.threadId);
              return (
                <div className="card" key={run.id}>
                  <div className="list-row">
                    <Icon name={run.trigger === "manual" ? "arrow-up" : "clock"} size={15} />
                    <span className="list-row__main">
                      <span className="list-row__title">{run.name}</span>
                      <span className="list-row__desc">
                        {run.trigger === "manual" ? "手动触发" : "定时触发"} · {RUN_STATUS[run.status] ?? run.status} · 开始{" "}
                        {formatTime(run.startedAt)}
                        {run.finishedAt ? ` · 结束 ${formatTime(run.finishedAt)}` : ""}
                        {run.result ? ` · ${run.result}` : ""}
                        {run.error ? ` · ${run.error}` : ""}
                        {run.threadId && !canOpen ? ` · ${unavailableConversation}` : ""}
                      </span>
                    </span>
                    {run.threadId && canOpen && (
                      <button type="button" className="btn btn--sm" onClick={() => openRunConversation(run.threadId)}>
                        打开会话
                      </button>
                    )}
                  </div>
                  {run.suggestions.length > 0 ? (
                    <div
                      className="list-row"
                      style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}
                    >
                      <span className="list-row__desc" style={{ flexBasis: "100%" }}>
                        后续建议（点击填入新建任务表单）
                      </span>
                      {run.suggestions.map((suggestion) => (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          key={suggestion.title}
                          title={suggestion.prompt}
                          onClick={() => applySuggestion(suggestion, run.automationId)}
                        >
                          {suggestion.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** 单条任务：说明 + 立即运行 / 删除 / 启停开关 */
function AutomationRow({
  task,
  projects,
  agents,
  hasConversation,
  busy,
  onToggle,
  onRun,
  onRemove,
}: {
  task: Automation;
  projects: Project[];
  agents: AgentItem[];
  hasConversation: boolean;
  busy: boolean;
  onToggle: () => void;
  onRun: () => void;
  onRemove: () => void;
}) {
  const planText = task.enabled
    ? `下次 ${task.nextRunAt === null ? "未排程" : formatTime(task.nextRunAt)}`
    : "已停用";
  return (
    <div className="list-row" title={task.prompt}>
      <Icon name="clock" size={15} />
      <span className="list-row__main">
        <span className="list-row__title">{task.name}</span>
        <span className="list-row__desc">
          {task.kind === "knowledge-index" ? "本地向量化" : projectName(projects, task.projectId)} · {describeSchedule(task)} · {planText} · 最近运行{" "}
          {task.lastRunAt === null ? "从未" : formatTime(task.lastRunAt)}
          {hasConversation ? " · 复用同一会话" : ""}
          {task.agentId ? ` · Agent ${agents.find((agent) => agent.id === task.agentId)?.name ?? task.agentId}` : ""}
        </span>
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={busy}
        title={busy ? "有任务正在运行，稍后再试" : "立刻运行一次"}
        onClick={onRun}
      >
        立即运行
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove}>
        删除
      </button>
      <button
        type="button"
        aria-label={`切换 ${task.name}`}
        className={task.enabled ? "switch switch--on" : "switch"}
        onClick={onToggle}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}
