import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { useAgentRun, threadRuns } from "../hooks/useAgentRun";
import { draftKey, useConversationDrafts } from "../model/conversationDrafts";
import { changeGoal, setGoal, taskKey, useTaskStore } from "./store";
import { journalUpdate, pendingRequests, type DurableRequest } from "./journal";
import "./tasks.css";

const GOAL_STATUS = { active: "进行中", paused: "已暂停", blocked: "需要处理", complete: "已完成" };
/** A compact composer status row, with recovery and goal editing available on demand. */
export function TaskPanel() {
  const id = useAppStore((s) => s.activeThreadId); const scope = useAppStore((s) => s.cachePath);
  const key = taskKey(scope, id); const task = useTaskStore((s) => s.tasks[key]);
  const editing = useTaskStore((s) => s.editorKey === key);
  const [objective, setObjective] = useState(""); const [budget, setBudget] = useState(50);
  const [error, setError] = useState(""); const [recovering, setRecovering] = useState<string | null>(null);
  const [pending, setPending] = useState<DurableRequest[]>([]); const { run, stop } = useAgentRun();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true; setPending([]); setError("");
    if (scope) void pendingRequests(scope).then((items) => { if (live) setPending(items.filter((r) => r.threadId === id && !threadRuns.get(id)?.active && !threadRuns.get(id)?.queue.length)); }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [scope, id]);
  useEffect(() => {
    if (!editing) return;
    setObjective(task?.goal?.objective || useConversationDrafts.getState().text[draftKey(scope, id)] || ""); setBudget(task?.goal?.maxIterations ?? 50);
    const close = (e: PointerEvent) => { if (e.target instanceof Node && !root.current?.contains(e.target)) useTaskStore.getState().edit(null); };
    document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close);
  }, [editing, id, scope]);
  const act = (fn: () => void) => { try { fn(); setError(""); } catch (e) { setError(String(e)); } };
  const resume = async (request: DurableRequest) => {
    setRecovering(request.id); setError("");
    try {
      const outcome = await run(id, `恢复中断的任务。先检查当前文件、终端和已完成步骤，避免重复执行已生效的操作，再完成剩余工作。原任务：\n${request.prompt}`, request.attachments);
      if (outcome !== "success") throw new Error("恢复尚未完成，原任务和附件已保留，可处理问题后重试。");
      await journalUpdate(scope, request.id, { status: "recovered" }); setPending((items) => items.filter((r) => r.id !== request.id));
    } catch (e) { setError(String(e)); } finally { setRecovering(null); }
  };
  const goal = task?.goal;
  const planReady = task?.mode === "plan" && task.plan.length > 0;
  if (!goal && !planReady && !pending.length && !editing && !error) return null;
  return <div className="task-status" ref={root} onKeyDown={(e) => { if (e.key === "Escape") useTaskStore.getState().edit(null); }}>
    {goal && <div className={`goal-strip goal-strip--${goal.status}`}>
      <Icon name={goal.status === "complete" ? "check" : "sparkles"} size={14} />
      <button className="goal-strip__title" title={goal.objective} onClick={() => useTaskStore.getState().edit(key)}><span>{GOAL_STATUS[goal.status]}</span><strong>{goal.objective}</strong></button>
      <span className="goal-strip__budget">{goal.iterations} / {goal.maxIterations}</span>
      {goal.status !== "complete" && <button className="icon-btn" aria-label={goal.status === "active" ? "暂停目标" : "继续目标"} onClick={() => act(() => { if (goal.status === "active") { changeGoal(key, "paused"); stop(id); } else changeGoal(key, "active"); })}><Icon name={goal.status === "active" ? "pause" : "play"} size={13} /></button>}
      <button className="icon-btn" aria-label="目标选项" aria-expanded={editing} onClick={() => useTaskStore.getState().edit(editing ? null : key)}><Icon name="ellipsis" size={15} /></button>
    </div>}
    {planReady && <div className="plan-ready"><Icon name="clipboard-check" size={14} /><span>计划已准备好 · {task.plan.length} 个步骤</span><button className="quiet-action" onClick={() => { useTaskStore.getState().patch(key, { mode: "execute" }); void run(id, "按已确认的计划开始实施，并验证结果。", []); }}>按计划实施<Icon name="arrow-up" size={12} /></button></div>}
    {pending.length > 0 && <details className="recovery-strip"><summary><Icon name="undo" size={14} />{recovering ? "正在恢复任务" : `发现 ${pending.length} 个中断任务`}<Icon name="chevron-down" size={11} /></summary><div className="recovery-strip__list">{pending.map((request) => <div key={request.id}><p>{request.prompt}</p><div className="action-row"><button className="btn btn--sm" disabled={Boolean(recovering)} onClick={() => void resume(request)}>检查并继续</button><button className="quiet-action" disabled={Boolean(recovering)} onClick={() => { void journalUpdate(scope, request.id, { status: "aborted" }).then(() => setPending((items) => items.filter((r) => r.id !== request.id))).catch((e) => setError(String(e))); }}>放弃此任务</button></div></div>)}</div></details>}
    {editing && <section className="goal-editor" role="dialog" aria-label="持续目标"><header><strong>{goal ? "调整目标" : "设定持续目标"}</strong><button className="icon-btn" aria-label="关闭目标设置" onClick={() => useTaskStore.getState().edit(null)}><Icon name="close" size={14} /></button></header><p>描述想得到的结果，以及如何确认已经完成。</p><textarea className="form__input" rows={4} autoFocus aria-label="任务目标" value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="例如：完成数据迁移，保持接口兼容，并通过全部集成测试。" /><div className="goal-editor__budget"><label>运行次数上限<input type="number" min={1} max={250} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label><span>{goal ? `已运行 ${goal.iterations} 次` : "可随时暂停或调整"}</span></div>{goal?.evidence && <div className="inline-note">{goal.evidence}</div>}<footer>{goal && <button className="quiet-action" onClick={() => { stop(id); useTaskStore.getState().patch(key, { goal: null }); useTaskStore.getState().edit(null); }}>清除目标</button>}<span className="spacer" /><button className="btn btn--primary btn--sm" disabled={!objective.trim() || !Number.isFinite(budget) || budget < 1} onClick={() => act(() => { setGoal(key, objective, budget); useTaskStore.getState().edit(null); })}>{goal ? "更新并继续" : "启动目标"}</button></footer></section>}
    {error && <div className="inline-error" role="alert"><Icon name="alert" size={13} />{error}</div>}
  </div>;
}
