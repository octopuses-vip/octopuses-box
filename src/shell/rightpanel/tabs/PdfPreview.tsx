import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";

/** 把字节数格式化为便于阅读的大小（开发者 Jan）；不足 1KB 显示 B，不足 1MB 显示 KB，其余显示 MB */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * PDF 预览（开发者 Jan）：把 PDF 产物包成 blob 交给 `<iframe>`，由 WebView 自带的 PDF 阅读器渲染。
 *
 * 零依赖优先：若不引入 pdfjs 就能看，就不必把 worker 与解析器打进包里。
 * 渲染失败时用户仍可从缓存目录取到原文件，因此这里不额外做降级渲染。
 */
export function PdfPreview() {
  const activeArtifact = useAppStore((state) => state.activeArtifact);

  if (!activeArtifact) {
    return <div className="panel-empty">点击上方文件查看内容</div>;
  }

  if (!activeArtifact.objectUrl) {
    return <div className="panel-empty">正在读取 PDF…</div>;
  }

  return (
    <div className="file-preview file-preview--fill">
      <div className="file-preview__head">
        <Icon name="file" size={13} />
        <span>{activeArtifact.name}</span>
        <span className="spacer" />
        <span className="badge">{formatBytes(activeArtifact.bytes)}</span>
      </div>
      <iframe
        className="pdf-preview__frame"
        title={`预览 ${activeArtifact.name}`}
        src={activeArtifact.objectUrl}
      />
    </div>
  );
}