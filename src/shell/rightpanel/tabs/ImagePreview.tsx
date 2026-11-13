import { useEffect } from "react";

import { effectiveArtifactDir } from "../../../app/state/artifacts";
import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";
import { FileRow } from "../FileRow";

/** 把字节数格式化为便于阅读的大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 图片预览：列出当前会话产物目录里的图片产物（模型通过 generate_image 生成），选中后直接展示。
 *
 * 图片一律经 blob 地址交给 `<img>` 渲染，与网页预览一样不把模型产出内联进主 DOM——
 * SVG 产物尤其要这样处理，否则模型产出的脚本就进入了应用上下文。
 */
export function ImagePreview() {
  const artifacts = useAppStore((state) => state.artifacts);
  const activeArtifact = useAppStore((state) => state.activeArtifact);
  const artifactStatus = useAppStore((state) => state.artifactStatus);
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  const loadArtifacts = useAppStore((state) => state.loadArtifacts);
  const selectArtifact = useAppStore((state) => state.selectArtifact);

  const images = artifacts.filter((item) => item.kind === "image");

  useEffect(() => {
    if (artifactStatus === "idle") void loadArtifacts();
  }, [artifactStatus, loadArtifacts]);

  // 当前选中的不是图片时自动切到最新一张，避免切到本 tab 后空着
  useEffect(() => {
    if (artifactStatus === "loading") return;
    const latest = artifacts.filter((item) => item.kind === "image")[0];
    if (!latest) return;
    const current = useAppStore.getState().activeArtifact;
    if (current && current.kind === "image") return;
    void selectArtifact(latest.name);
  }, [artifacts, artifactStatus, selectArtifact]);

  if (images.length === 0) {
    return (
      <div className="panel-empty">
        {artifactStatus === "loading"
          ? "正在读取产物…"
          : "还没有图片产物。让模型生成配图时会自动写到这里。"}
      </div>
    );
  }

  const current = activeArtifact?.kind === "image" ? activeArtifact : null;

  return (
    <div>
      <div className="list-row" style={{ margin: 10, flexDirection: "column", gap: 4 }}>
        {images.map((artifact) => (
          <FileRow
            key={artifact.name}
            icon="image"
            name={artifact.name}
            bytes={artifact.bytes}
            active={artifact.name === current?.name}
            onSelect={() => void selectArtifact(artifact.name)}
            source={{ kind: "artifact", dir: artifactDir ?? "", name: artifact.name }}
          />
        ))}
      </div>

      {current?.objectUrl ? (
        <div className="file-preview">
          <div className="file-preview__head">
            <Icon name="image" size={13} />
            <span>{current.name}</span>
            <span className="spacer" />
            <span className="badge">{formatBytes(current.bytes)}</span>
          </div>
          <div className="media-preview__stage">
            <img className="media-preview__image" src={current.objectUrl} alt={current.name} />
          </div>
        </div>
      ) : (
        <div className="panel-empty">正在读取图片…</div>
      )}
    </div>
  );
}