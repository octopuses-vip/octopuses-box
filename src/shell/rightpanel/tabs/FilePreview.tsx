import { OfficePreview } from "../../../office/OfficePreview";
import { useEffect } from "react";

import { effectiveArtifactDir } from "../../../app/state/artifacts";
import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";
import { MarkdownLinkScope } from "../../../conversation/Markdown";
import { drawingFormatOf } from "../../../model/drawings";
import { FileRow } from "../FileRow";
import { MarkdownPreview } from "./MarkdownPreview";
import { VideoPlayer } from "./VideoPlayer";
import { PdfPreview } from "./PdfPreview";
import { TablePreview } from "./TablePreview";

/** 把字节数格式化为便于阅读的大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 文本产物的渲染方式：Markdown / 表格各有专用视图，其余按纯文本展示 */
function textRendererOf(name: string): "markdown" | "table" | "plain" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".csv")) return "table";
  return "plain";
}

/**
 * 文件预览：列出当前会话产物目录（项目会话在项目 `output/`，临时会话在缓存 `outputs/<日期>/`）
 * 下由模型写出的产物文件，选中后按种类查看内容。
 *
 * 图片直接在本 tab 渲染（`selectArtifact` 对图片走字节通道，`objectUrl` 已就绪），
 * 不再要求用户切到「图片」tab；HTML 类产物仍建议切到「网页」tab、图纸切到「3D」tab。
 * Markdown 预览里的相对链接在本面板内导航（点击 `.md` / 图片直接切换预览目标）。
 */
export function FilePreview() {
  const artifacts = useAppStore((state) => state.artifacts);
  const activeArtifact = useAppStore((state) => state.activeArtifact);
  const artifactStatus = useAppStore((state) => state.artifactStatus);
  const artifactError = useAppStore((state) => state.artifactError);
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  const loadArtifacts = useAppStore((state) => state.loadArtifacts);
  const selectArtifact = useAppStore((state) => state.selectArtifact);
  const openMarkdownLink = useAppStore((state) => state.openMarkdownLink);

  useEffect(() => {
    if (artifactStatus === "idle") void loadArtifacts();
  }, [artifactStatus, loadArtifacts]);

  // 有产物但没有选中项时自动选中最新一个，避免右栏空着
  useEffect(() => {
    if (artifacts.length === 0) return;
    if (useAppStore.getState().activeArtifact) return;
    void selectArtifact(artifacts[0].name);
  }, [artifacts, selectArtifact]);

  const artifact = activeArtifact;

  /** 按产物种类渲染预览主体：图片 / PDF 走专用视图，Markdown / CSV 走富视图，其余纯文本 */
  const renderArtifact = () => {
    if (!artifact) return null;
    if (artifact.kind === "image") {
      // 图片直接在本 tab 预览：selectArtifact 已把字节包成 objectUrl，无需切 tab
      if (artifact.objectUrl) {
        return (
          <div className="file-preview file-preview--fill">
            <div className="file-preview__head">
              <Icon name="image" size={13} />
              <span>{artifact.name}</span>
              <span className="spacer" />
              <span className="badge">{formatBytes(artifact.bytes)}</span>
            </div>
            <div className="media-preview__stage">
              <img className="media-preview__image" src={artifact.objectUrl} alt={artifact.name} />
            </div>
          </div>
        );
      }
      return <div className="panel-empty">正在读取图片…</div>;
    }
    if (artifact.kind === "video" && artifact.objectUrl) return <VideoPlayer url={artifact.objectUrl} name={artifact.name} />;
    if (artifact.kind === "pdf") return <PdfPreview />;
    if (artifact.source.kind === "artifact" && /\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(artifact.name)) {
      return <OfficePreview directory={artifact.source.dir} name={artifact.name} revision={artifact.modifiedAt} />;
    }
    if (artifact.kind === "binary") {
      // 图纸被归为二进制（不当文本渲染），但它是可看的，只是要看在另一个 tab
      if (drawingFormatOf(artifact.name)) {
        return <div className="panel-empty">该产物是三维图纸，请切到「3D」tab 旋转查看。</div>;
      }
      return (
        <div className="panel-empty">
          该产物是二进制文件（{formatBytes(artifact.bytes)}），暂不支持预览。
        </div>
      );
    }
    const renderer = textRendererOf(artifact.name);
    if (renderer === "markdown") {
      return (
        <MarkdownLinkScope onLink={openMarkdownLink}>
          <MarkdownPreview />
        </MarkdownLinkScope>
      );
    }
    if (renderer === "table") return <TablePreview />;
    return (
      <div className="file-preview file-preview--fill">
        <div className="file-preview__head">
          <Icon name="code" size={13} />
          <span>{artifact.name}</span>
          <span className="spacer" />
          <span className="badge">{formatBytes(artifact.bytes)}</span>
        </div>
        <pre className="file-preview__code">{artifact.content}</pre>
      </div>
    );
  };

  if (artifacts.length === 0 && !activeArtifact) {
    return (
      <div className="panel-empty">
        <div>
          {artifactStatus === "loading"
            ? "正在读取产物…"
            : artifactError ?? "还没有产物文件。让模型生成网页或文档时会自动写到这里。"}
        </div>
        {/* 目录空着也要把路径摊开：否则「文件」tab 一片空白，用户不知道产物到底该在哪 */}
        {artifactDir ? <div className="panel-empty__path">{artifactDir}</div> : null}
      </div>
    );
  }

  return (
    <div className="file-tab">
      {artifacts.length > 0 && <div className="list-row file-tab__list" style={{ margin: 10, flexDirection: "column", gap: 4 }}>
        {artifacts.map((artifact) => (
          <FileRow
            key={artifact.name}
            icon="file"
            name={artifact.name}
            bytes={artifact.bytes}
            active={activeArtifact?.source.kind === "artifact" && artifact.name === activeArtifact.name}
            onSelect={() => void selectArtifact(artifact.name)}
            source={{ kind: "artifact", dir: artifactDir ?? "", name: artifact.name }}
          />
        ))}
      </div>}

      {activeArtifact ? (
        renderArtifact()
      ) : (
        <div className="panel-empty">{artifactError ?? "点击上方文件查看内容"}</div>
      )}
    </div>
  );
}
