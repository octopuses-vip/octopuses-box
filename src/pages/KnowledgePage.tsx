import { useAppStore } from "../app/state";
import { KnowledgeSettings } from "../knowledge/KnowledgeSettings";

/** 知识库独立管理入口：沿用已有资源管理组件与全局索引状态。 */
export function KnowledgePage() {
  const setView = useAppStore((state) => state.setView);
  return (
    <div className="page">
      <div className="page__inner">
        <div className="knowledge-page__header">
          <div>
            <p className="page__desc">管理文档、历史会话收录、向量模型与训练数据导出。</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={() => setView("search")}>搜索知识库</button>
        </div>
        <KnowledgeSettings />
      </div>
    </div>
  );
}
