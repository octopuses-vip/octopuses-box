import { openExternal } from "../../../app/desktop/system";
import { selectActiveSources } from "../../../app/storeSelectors";
import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";

/**
 * 右栏「来源」页签（开发者 Jan）：把当前会话检索 / 读正文命中的网页排成列表。
 *
 * 数据取自会话级 `Thread.sources`，因此切会话即换列表，不会串台；摘要与网址分行展示，
 * 右侧按钮走系统浏览器打开。
 */
export function Sources() {
  // 来源是会话级数据：只读当前会话自己检索到的结果（见 `Thread.sources`）
  const sources = useAppStore(selectActiveSources);

  if (sources.length === 0) {
    return <div className="panel-empty">当前会话还没有检索到的来源</div>;
  }

  return (
    <div style={{ padding: 10 }}>
      {sources.map((source, index) => (
        <div className="list-row" key={source.url} style={{ alignItems: "flex-start" }}>
          <span className="source-row__index">{index + 1}</span>
          <div className="list-row__main">
            <div className="list-row__title">{source.title}</div>
            <div className="list-row__desc">{source.snippet}</div>
            <div className="source-row__url">{source.url}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="打开来源"
            onClick={() => void openExternal(source.url)}
          >
            <Icon name="external" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
