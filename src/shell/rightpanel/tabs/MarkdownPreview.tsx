import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";
import { Markdown } from "../../../conversation/Markdown";

/**
 * Markdown 产物预览（开发者 Jan）：复用对话区的 Markdown 渲染，产物里的链接同样在新标签页打开。
 *
 * 渲染的是文本产物内容，因此只在「文件」tab 里按扩展名分发时使用。
 */
export function MarkdownPreview() {
  const activeArtifact = useAppStore((state) => state.activeArtifact);

  if (!activeArtifact) {
    return <div className="panel-empty">点击上方文件查看内容</div>;
  }

  return (
    <div className="file-preview file-preview--fill">
      <div className="file-preview__head">
        <Icon name="book" size={13} />
        <span>{activeArtifact.name}</span>
      </div>
      <div className="file-preview__md">
        <Markdown text={activeArtifact.content} />
      </div>
    </div>
  );
}