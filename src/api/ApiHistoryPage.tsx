import { useCallback, useEffect, useState } from "react";
import {
  listApiHistory, readApiHistory, type ApiHistoryItem, type ApiHistoryPageData, type ApiHistoryScope, type ApiHistoryTurn, type ApiHistoryView,
} from "../app/desktop/apiHistory";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { Segmented } from "../components/Segmented";
import { Markdown } from "../conversation/Markdown";
import { formatBytes } from "../model/attachments";
import "./api-history.css";

const views: { value: ApiHistoryView; label: string }[] = [
  { value: "sessions", label: "会话" },
  { value: "jobs", label: "独立任务" },
];
const jobLabels: Record<string, string> = { chat: "对话任务", transcribe: "语音转写", image: "生成图片", video: "生成视频" };
const statusLabels: Record<string, string> = { queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" };
const clock = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

/** Keep current-account results only and discard stale replies when the selection changes. */
function useHistoryPage<T>(load: () => Promise<ApiHistoryPageData<T>>, refresh: number) {
  const [result, setResult] = useState<{
    request: typeof load; data?: ApiHistoryPageData<T>; error?: string;
  }>();
  useEffect(() => {
    let active = true;
    void load().then(
      (data) => { if (active) setResult({ request: load, data }); },
      (error: unknown) => {
        if (active) setResult({ request: load, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { active = false; };
  }, [load, refresh]);
  return result?.request === load ? result : undefined;
}

/** Use the start of the first request as the session title when available. */
function recordLabel(item: ApiHistoryItem): string {
  return item.preview?.replace(/\s+/g, " ").trim() || (item.kind ? jobLabels[item.kind] ?? item.kind : "API 会话");
}

/** List pages move toward older records. Session turns use the same direction. */
function HistoryPagination({ page, hasMore, setPage }: { page: number; hasMore: boolean; setPage: (page: number) => void }) {
  if (page === 0 && !hasMore) return null;
  return (
    <div className="api-history__pagination">
      <button type="button" className="btn btn--ghost btn--sm" disabled={page === 0} onClick={() => setPage(page - 1)}>较新</button>
      <button type="button" className="btn btn--ghost btn--sm" disabled={!hasMore} onClick={() => setPage(page + 1)}>更早</button>
    </div>
  );
}

/** Show saved prompts and replies as read-only history. */
function HistoryTurn({ turn }: { turn: ApiHistoryTurn }) {
  return (
    <article className="api-history__turn">
      <div className="api-history__meta muted">
        <time dateTime={new Date(turn.createdAt).toISOString()}>{clock.format(turn.createdAt)}</time>
        <span>{statusLabels[turn.status] ?? turn.status}</span>
      </div>
      {turn.prompt && (
        <div className="api-history__body">
          <div className="api-history__role">请求</div>
          <div className="api-history__prompt">{turn.prompt}</div>
        </div>
      )}
      {turn.text && (
        <div className="api-history__body">
          <div className="api-history__role">回复</div>
          <Markdown text={turn.text} allowImages={false} />
        </div>
      )}
      {turn.skillIds.length > 0 && <p className="api-history__note muted">技能 {turn.skillIds.join("、")}</p>}
      {turn.artifact && (
        <p className="api-history__note">
          <Icon name="file" size={14} /> {turn.artifact.name} <span className="muted">{formatBytes(turn.artifact.bytes)}</span>
        </p>
      )}
      {turn.error && <p className="api-history__note" role="status">{turn.error}</p>}
      <code className="api-history__job-id muted" title="任务 ID">{turn.id}</code>
    </article>
  );
}

/** Read a bounded number of turns at a time to keep large sessions responsive. */
function HistoryDetail({ scope, view, record, refresh }: {
  scope: ApiHistoryScope; view: ApiHistoryView; record: ApiHistoryItem; refresh: number;
}) {
  const [page, setPage] = useState(0);
  const load = useCallback(() => readApiHistory(scope, view, record.id, page), [scope, view, record.id, page]);
  const result = useHistoryPage(load, refresh);
  return (
    <section className="api-history__detail" aria-label="记录详情">
      <header className="api-history__detail-head">
        <h2>{recordLabel(record)}</h2>
        <p className="api-history__meta muted">
          <span>{record.model}</span>
          {record.agentId && <span>Agent {record.agentId}</span>}
        </p>
        <code className="api-history__job-id muted" title={view === "sessions" ? "会话 ID" : "任务 ID"}>{record.id}</code>
      </header>
      {result?.error && <div className="panel-empty" role="alert">{result.error}</div>}
      {!result && <div className="panel-empty" role="status">正在读取记录…</div>}
      {result?.data && (
        <>
          {result.data.items.length === 0 && <div className="panel-empty">这条会话还没有请求。</div>}
          {result.data.items.map((turn) => <HistoryTurn key={turn.id} turn={turn} />)}
          <HistoryPagination page={page} hasMore={result.data.hasMore} setPage={setPage} />
        </>
      )}
    </section>
  );
}

/** Place API conversations and independent jobs in one local history view. */
function HistoryWorkspace({ scope }: { scope: ApiHistoryScope }) {
  const [view, setView] = useState<ApiHistoryView>("sessions");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState("");
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(() => listApiHistory(scope, view, page), [scope, view, page]);
  const result = useHistoryPage(load, refresh);
  const items = result?.data?.items ?? [];
  const active = items.find((record) => record.id === selected) ?? items[0];
  return (
    <div className="page api-history">
      <div className="page__inner">
        <div className="api-history__toolbar">
          <Segmented options={views} value={view} onChange={(next) => {
            if (next === view) return;
            setView(next);
            setPage(0);
            setSelected("");
          }} ariaLabel="API 记录类型" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRefresh((value) => value + 1)}>
            <Icon name="refresh" size={14} /> 刷新
          </button>
        </div>
        {result?.error && <div className="panel-empty" role="alert">{result.error}</div>}
        {!result && <div className="panel-empty" role="status">正在读取 API 历史…</div>}
        {result?.data && (
          <div className="api-history__layout">
            <section className="api-history__list" aria-label="API 记录列表">
              {items.length === 0 && <p className="panel-empty">暂无{view === "sessions" ? " API 会话" : "独立任务"}。</p>}
              {items.map((record) => (
                <button key={record.id} type="button" className="api-history__item"
                  aria-current={active?.id === record.id ? "true" : undefined} onClick={() => setSelected(record.id)}
                >
                  <span className="api-history__title" title={recordLabel(record)}>{recordLabel(record)}</span>
                  <span className="api-history__meta muted">
                    <span>{clock.format(record.updatedAt)}</span>
                    {record.status && <span>{statusLabels[record.status] ?? record.status}</span>}
                  </span>
                </button>
              ))}
              <HistoryPagination page={page} hasMore={result.data.hasMore} setPage={setPage} />
            </section>
            {active && <HistoryDetail key={active.id} scope={scope} view={view} record={active} refresh={refresh} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Remount the workspace when the desktop moves to a different data scope. */
export function ApiHistoryPage() {
  const cachePath = useAppStore((state) => state.cachePath);
  const source = useAppStore((state) => state.modelSource);
  const endpoint = useAppStore((state) => state.endpoint);
  const username = useAppStore((state) => state.currentUser);
  if (!isDesktopRuntime() || !cachePath) return <div className="panel-empty">请在配置好缓存的桌面客户端查看 API 会话。</div>;
  const local = source === "local";
  const key = JSON.stringify([cachePath, local, endpoint?.host, endpoint?.port, username]);
  return <HistoryWorkspace key={key} scope={{ cachePath, local, endpoint, username }} />;
}
