import { useState } from "react";

import { APP_NAME } from "../app/meta";
import { useAppStore } from "../app/state";
import type { ParallelBatch, ParallelItem, ParallelItemStatus } from "../app/types";
import { Icon } from "../components/Icon";
import { useAgentRun } from "../hooks/useAgentRun";

/** 状态文案与徽标样式 */
const STATUS_META: Record<ParallelItemStatus, { label: string; badge: string }> = {
  queued: { label: "排队中", badge: "badge" },
  running: { label: "运行中", badge: "badge badge--info" },
  success: { label: "完成", badge: "badge badge--ok" },
  failed: { label: "失败", badge: "badge badge--warn" },
  aborted: { label: "已中断", badge: "badge" },
};

/** 把时间戳换成「本地时间」文案 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 多项目并行任务：把同一条提示词同时分发给多个项目，各项目在自己的会话里并行执行。
 *
 * 真正的并行来自 [useAgentRun.ts](../hooks/useAgentRun.ts) 的「按会话分槽」运行队列——
 * 不同会话互不排队，本页只负责建批次、建会话、逐项发起运行并把结果回写到看板。
 * 批次档案落盘在缓存目录 `parallel/batches.json`，重启后可回看历史。
 */
export function ParallelPage() {
  const projects = useAppStore((state) => state.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const parallelBatches = useAppStore((state) => state.parallelBatches);
  const parallelError = useAppStore((state) => state.parallelError);
  const cachePath = useAppStore((state) => state.cachePath);
  const threadRunStates = useAppStore((state) => state.threadRunStates);
  const createParallelBatch = useAppStore((state) => state.createParallelBatch);
  const updateParallelItem = useAppStore((state) => state.updateParallelItem);
  const removeParallelBatch = useAppStore((state) => state.removeParallelBatch);
  const openThread = useAppStore((state) => state.openThread);
  const { run } = useAgentRun();

  const [prompt, setPrompt] = useState("");
  // 默认勾选当前项目：多数并行任务就包含用户正在做的项目
  const [selectedIds, setSelectedIds] = useState<string[]>(
    projects.some((project) => project.id === activeProjectId) ? [activeProjectId] : [],
  );

  const canLaunch = prompt.trim().length > 0 && selectedIds.length > 0;

/** 函数级说明（开发者 Jan）：执行 toggleProject 的单一职责，并返回可供调用方继续处理的结果。 */
  const toggleProject = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

/** 函数级说明（开发者 Jan）：执行 handleLaunch 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleLaunch = () => {
    const targets = projects
      .filter((project) => selectedIds.includes(project.id))
      .map((project) => ({ id: project.id, name: project.name }));
    const created = createParallelBatch(prompt, targets);
    if (!created) return;
    setPrompt("");
    for (const job of created.jobs) {
      updateParallelItem(created.batchId, job.threadId, { status: "running" });
      // 每个项目一个会话，不同会话互不排队：这里逐个发起即可同时推进
      void run(job.threadId, created.prompt, [], { mode: "run", source: "user" }).then((outcome) => {
        updateParallelItem(created.batchId, job.threadId, {
          status: outcome,
          finishedAt: Date.now(),
          error: outcome === "failed" ? "运行失败，请打开会话查看详情。" : null,
        });
      });
    }
  };

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          让 {APP_NAME} 把同一条任务同时分发给多个项目：每个项目各建一个独立会话并<b>同时</b>执行，
          互不排队。批次与进度存放在缓存目录
          {cachePath ? ` ${cachePath}/parallel/` : "（尚未配置缓存目录）"}，
          点击任一项目可跳转到对应会话查看过程。
        </p>

        {parallelError ? (
          <div className="card">
            <div className="card__desc">读取并行任务失败：{parallelError}</div>
          </div>
        ) : null}

        <div className="page__section">
          <div className="page__section-label">新建并行任务</div>
          <div className="card">
            <label className="form__row">
              <span className="form__label">任务提示词</span>
              <textarea
                className="form__textarea"
                value={prompt}
                placeholder="例如：检查本项目的测试是否全部通过，并给出修复建议"
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <div className="form__row">
              <span className="form__label">分发到项目</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {projects.length === 0 ? (
                  <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
                    暂无项目，请先在左栏「项目」右侧点 + 新增项目
                  </span>
                ) : (
                  projects.map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      title={project.path || "未选择项目目录"}
                      className={
                        selectedIds.includes(project.id)
                          ? "btn btn--primary btn--sm"
                          : "btn btn--ghost btn--sm"
                      }
                      onClick={() => toggleProject(project.id)}
                    >
                      {selectedIds.includes(project.id) ? "✓ " : ""}
                      {project.name}
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="login__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={!canLaunch}
                onClick={handleLaunch}
              >
                并行运行（{selectedIds.length} 个项目）
              </button>
              <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
                未选择项目目录的项目无法使用工程工具，但仍可完成对话类任务。
              </span>
            </div>
          </div>
        </div>

        <div className="page__section">
          <div className="page__section-label">批次看板 {parallelBatches.length}</div>
          {parallelBatches.length === 0 ? (
            <div className="card">
              <div className="card__desc">
                还没有并行任务。写下任务、勾选多个项目后点「并行运行」，这里会按项目展示各自进度。
              </div>
            </div>
          ) : (
            parallelBatches.map((batch) => (
              <BatchBoard
                key={batch.id}
                batch={batch}
                runStates={threadRunStates}
                onOpen={openThread}
                onRemove={() => removeParallelBatch(batch.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** 一个批次看板：任务提示词 + 各项目运行条目 */
function BatchBoard({
  batch,
  runStates,
  onOpen,
  onRemove,
}: {
  batch: ParallelBatch;
  runStates: Record<string, { status: "idle" | "queued" | "running" }>;
  onOpen: (threadId: string) => void;
  onRemove: () => void;
}) {
  const runningCount = batch.items.filter(
    (item) => liveStatus(item, runStates) === "running",
  ).length;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="branch" size={15} />
        <span className="list-row__title">{batch.prompt}</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
          {formatTime(batch.createdAt)} · {batch.items.length} 个项目
          {runningCount > 0 ? ` · 运行中 ${runningCount}` : ""}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove}>
          删除
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
        {batch.items.map((item) => (
          <BatchItemRow
            key={item.threadId}
            item={item}
            status={liveStatus(item, runStates)}
            onOpen={() => onOpen(item.threadId)}
          />
        ))}
      </div>
    </div>
  );
}

/** 单个项目条目：项目名 + 实时状态 + 打开会话 */
function BatchItemRow({
  item,
  status,
  onOpen,
}: {
  item: ParallelItem;
  status: ParallelItemStatus;
  onOpen: () => void;
}) {
  const meta = STATUS_META[status];
  return (
    <div className="list-row">
      <Icon name="folder" size={15} />
      <span className="list-row__main">
        <span className="list-row__title">{item.projectName}</span>
        <span className="list-row__desc">
          {STATUS_META[item.status].label === meta.label ? "" : `已记录：${STATUS_META[item.status].label} · `}
          {item.finishedAt ? `结束 ${formatTime(item.finishedAt)}` : "运行中…"}
          {item.error ? ` · ${item.error}` : ""}
        </span>
      </span>
      <span className={meta.badge}>{meta.label}</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onOpen}>
        打开会话
      </button>
    </div>
  );
}

/**
 * 条目的实时状态：优先反映会话当前的运行态（队列是内存态、且刷新后更准），
 * 会话不在运行时回落到档案里记录的状态。
 */
function liveStatus(
  item: ParallelItem,
  runStates: Record<string, { status: "idle" | "queued" | "running" }>,
): ParallelItemStatus {
  const live = runStates[item.threadId]?.status;
  if (live === "running" || live === "queued") return live;
  return item.status;
}
