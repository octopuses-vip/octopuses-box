import { openExternal } from "../../app/desktop/system";
import type { SourceItem } from "../../app/types";
import { Icon } from "../../components/Icon";

interface SourcesCardProps {
  items: SourceItem[];
}

/**
 * 来源卡片（开发者 Jan）：逐条列出检索 / 读正文命中的网页，点击走系统浏览器打开。
 *
 * 用 `item.url` 作 key（同一批结果里网址唯一），显示序号方便与正文里的引用角标对应。
 */
export function SourcesCard({ items }: SourcesCardProps) {
  return (
    <div className="sources-card">
      <div className="sources-card__head">
        <Icon name="book" size={14} />
        <span>来源 · {items.length}</span>
      </div>
      {items.map((item, index) => (
        <button
          type="button"
          className="source-row"
          key={item.url}
          onClick={() => void openExternal(item.url)}
        >
          <span className="source-row__index">{index + 1}</span>
          <span style={{ minWidth: 0 }}>
            <div className="source-row__title">{item.title}</div>
            <div className="source-row__url">{item.url}</div>
          </span>
        </button>
      ))}
    </div>
  );
}
