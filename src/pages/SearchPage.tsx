import { useEffect, useState } from "react";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { knowledgeRequest } from "../knowledge/api";
import { SourcePreview } from "../knowledge/KnowledgeLibrary";
import { EMBEDDING_VERSION, useKnowledgeModel } from "../knowledge/model";
import { knowledgeError, useKnowledgeStore } from "../knowledge/store";
import type { KnowledgeHit, KnowledgeSource } from "../knowledge/types";

/** 文档与全部历史会话共用同一知识库，搜索统一使用向量语义召回。 */
export function SearchPage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<KnowledgeSource | null>(null);
  const scope = useAppStore((state) => state.cachePath);
  const openThread = useAppStore((state) => state.openThread);
  const enabled = useKnowledgeModel((state) => state.status?.enabled ?? false);
  const library = useKnowledgeStore();
  const keyword = query.trim();
  const vectorReady = enabled && library.stats.indexed > 0;

  useEffect(() => {
    let active = true;
    setError(""); setHits([]);
    if (!scope || !keyword) { setSearching(false); return; }
    if (!enabled) {
      setSearching(false);
      setError("请先在知识库设置中启用向量模型，再进行语义搜索。");
      return;
    }
    if (!vectorReady) {
      setSearching(false);
      setError(library.stats.chunks > 0 ? "文档正在建立向量索引，请稍后再搜索。" : "知识库暂无可搜索内容。");
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const action = { op: "search" as const, query: keyword, kind: "", model: EMBEDDING_VERSION };
        try {
          const { embedText } = await import("../knowledge/embedding");
          const vector = await embedText(keyword, true);
          if (!active) return;
          const semanticHits = await knowledgeRequest<KnowledgeHit[]>(scope, { ...action, vector });
          if (active) setHits(semanticHits);
        } catch (failure) {
          if (active) setError(`向量搜索暂不可用：${knowledgeError(failure)}`);
        }
        finally { if (active) setSearching(false); }
      })();
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [scope, keyword, enabled, vectorReady, library.revision, library.stats.chunks, library.stats.indexed, library.syncing]);

/** 函数级说明（开发者 Jan）：执行 open 的单一职责，并返回可供调用方继续处理的结果。 */
  const open = async (source: KnowledgeHit) => {
    if (source.kind === "conversation" && source.threadId) {
      if (!useAppStore.getState().threads.some((thread) => thread.id === source.threadId)) {
        setError("这条会话已不存在，请重新同步知识库。"); return;
      }
      useKnowledgeStore.setState({ jumpTarget: "messageId" in source && source.messageId
        ? { threadId: source.threadId, messageId: source.messageId } : null });
      openThread(source.threadId); return;
    }
    if (!scope) return;
    try { setPreview(await knowledgeRequest<KnowledgeSource>(scope, { op: "get", id: source.sourceId })); }
    catch (failure) { setError(knowledgeError(failure)); }
  };
  return (
    <div className={`page search-page${keyword ? " search-page--results" : " search-page--landing"}`}>
      <div className="page__inner search-page__inner">
        <div className="search-page__intro">
          <div className="search-page__eyebrow">知识库搜索</div>
          <p className="page__desc">搜索历史会话与已收录的知识文档，使用向量语义匹配。</p>
        </div>
        <div className="search-page__bar">
          <div className="search-input">
            <Icon name="search" size={14} />
            <input autoFocus type="search" aria-label="搜索知识库" placeholder="搜索会话、文档或问题…" maxLength={512}
              value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
          </div>
        </div>
        {error ? <p role="alert" className="knowledge-error">{error}</p> : null}
        {!keyword && !searching ? <div className="search-page__empty">输入关键词开始搜索</div> : null}
        {keyword || searching ? <div className="page__section search-page__results" aria-busy={searching}>
          <div className="page__section-label" role="status">{searching ? "正在搜索…" : `找到 ${hits.length} 条结果`}</div>
          {!searching ? hits.map((hit) => <button type="button" key={hit.id} className="list-row list-row--action" onClick={() => void open(hit)}>
            <Icon name={hit.kind === "document" ? "file" : "message"} size={15} />
            <span className="list-row__main">
              <span className="list-row__title">{hit.title}</span>
              <span className="list-row__desc">{hit.kind === "document" ? "知识文档" : "历史会话"} · 向量语义匹配</span>
              <span className="search-hit__snippet">{hit.text}</span>
            </span>
          </button>) : null}
          {!searching && !hits.length ? <div className="panel-empty">没有找到匹配内容</div> : null}
        </div> : null}
        {preview ? <SourcePreview source={preview} onClose={() => setPreview(null)} /> : null}
      </div>
    </div>
  );
}
