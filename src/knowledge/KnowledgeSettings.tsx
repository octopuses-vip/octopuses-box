import { useEffect } from "react";

import { isDesktopRuntime } from "../app/desktop/runtime";
import { KNOWLEDGE_MODEL, KNOWLEDGE_MODEL_BYTES, useKnowledgeModel } from "./model";
import { useKnowledgeAutoRetrieval } from "./retrieval";
import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { ImportLimitSettings } from "./ImportLimitSettings";

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** 函数级说明（开发者 Jan）：执行 KnowledgeSettings 的单一职责，并返回可供调用方继续处理的结果。 */
export function KnowledgeSettings() {
  const { status, busy, progress, error, refresh, download, setEnabled, cancel, remove } = useKnowledgeModel();
  const autoRetrieval = useKnowledgeAutoRetrieval((state) => state.enabled);
  const setAutoRetrieval = useKnowledgeAutoRetrieval((state) => state.setEnabled);
  const desktop = isDesktopRuntime();
  useEffect(() => { void refresh(); }, [refresh]);
  const percent = progress ? Math.min(100, Math.floor(progress.downloaded / progress.total * 100)) : 0;
  const label = busy === "checking" ? "检查中…"
    : busy === "downloading" ? "正在下载…"
    : busy === "saving" ? "保存中…"
    : status?.enabled ? "已开启"
    : status?.ready ? "启用模型" : "下载并启用";

  return (
    <section className="page__section" aria-labelledby="knowledge-settings-title">
      <div className="page__section-label" id="knowledge-settings-title">知识库</div>
      <div className="list-row">
        <span className="list-row__main">
          <span className="list-row__title">对话自动检索</span>
          <span className="list-row__desc">
            每轮提问前先用问题检索本地向量库，命中片段作为参考资料随系统提示一起发给模型。
            关闭后只有模型主动调用 knowledge_search 时才会检索。
          </span>
        </span>
        <button
          type="button"
          className={autoRetrieval ? "btn btn--sm" : "btn btn--ghost btn--sm"}
          disabled={!desktop}
          aria-pressed={autoRetrieval}
          aria-label={autoRetrieval ? "关闭对话自动检索" : "开启对话自动检索"}
          onClick={() => setAutoRetrieval(!autoRetrieval)}
        >
          {autoRetrieval ? "已开启" : "已关闭"}
        </button>
      </div>
      <div className="list-row list-row--top">
        <span className="list-row__main">
          <span className="list-row__title">本地向量模型</span>
          <span className="list-row__desc">
            默认关闭，按需下载，用于历史对话与文档的语义检索。模型在本机运行。
          </span>
          <span className="list-row__desc">
            {KNOWLEDGE_MODEL.label} · 含分词器约 {megabytes(KNOWLEDGE_MODEL_BYTES)}
          </span>
        </span>
        <button
          type="button"
          className={status?.enabled ? "btn btn--sm" : "btn btn--ghost btn--sm"}
          disabled={!desktop || !!busy || !status}
          aria-pressed={status?.enabled ?? false}
          aria-label={status?.enabled ? "关闭知识库向量模型" : "启用知识库向量模型"}
          onClick={() => void (status?.ready ? setEnabled(!status.enabled) : download())}
        >
          {label}
        </button>
      </div>
      <p className="page__desc">
        {desktop
          ? status?.ready
            ? "关闭后保留模型和资料，但搜索会暂停；再次启用后自动补建尚未完成的语义索引。"
            : "点击后从 ModelScope（modelscope.cn）下载模型与分词器，仅下载资源，不上传对话；搜索需要先启用向量模型。"
          : "请在桌面应用中下载和管理模型；浏览器预览不会下载文件。"}
      </p>
      {busy === "downloading" && progress ? (
        <div className="knowledge-download" aria-live="polite">
          <div className="knowledge-download__status">
            <span className="list-row__desc">
              {percent === 100 ? "正在校验并安装…" : `${megabytes(progress.downloaded)} / ${megabytes(progress.total)} · ${percent}%`}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={percent === 100} onClick={() => void cancel()}>取消下载</button>
          </div>
          <div className="progress" role="progressbar" aria-label="向量模型下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="progress__bar" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="knowledge-download__status" role="alert">
          <span className="list-row__desc">{error}</span>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void refresh()}>重新检查</button>
        </div>
      ) : null}
      {desktop && status?.installed ? (
        <div className="knowledge-download__status">
          <span className="list-row__desc">{status.ready ? "已保存到应用数据目录" : "模型文件不完整，请重新下载"}</span>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void remove()}>
            {busy === "removing" ? "删除中…" : "删除模型"}
          </button>
        </div>
      ) : null}
      <ImportLimitSettings />
      <KnowledgeLibrary />
    </section>
  );
}
