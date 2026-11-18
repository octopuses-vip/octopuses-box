import { useEffect } from "react";

import { effectiveArtifactDir } from "../../../app/state/artifacts";
import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";
import { VideoPlayer } from "./VideoPlayer";
import { FileRow } from "../FileRow";

/** 把字节数格式化为便于阅读的大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 预览当前会话产物目录中的图片与视频。
 *
 * 图片一律经 blob 地址交给 `<img>` 渲染，与网页预览一样不把模型产出内联进主 DOM——
 * SVG 产物尤其要这样处理，否则模型产出的脚本就进入了应用上下文。
 */
export function MediaPreview() {
  const artifacts = useAppStore((state) => state.artifacts);
  const activeArtifact = useAppStore((state) => state.activeArtifact);
  const artifactStatus = useAppStore((state) => state.artifactStatus);
  const artifactError = useAppStore((state) => state.artifactError);
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  const loadArtifacts = useAppStore((state) => state.loadArtifacts);
  const selectArtifact = useAppStore((state) => state.selectArtifact);

  const media = artifacts.filter((item) => item.kind === "image" || item.kind === "video");

  useEffect(() => {
    if (artifactStatus === "idle") void loadArtifacts();
  }, [artifactStatus, loadArtifacts]);

  // 当前选中的不是图片时自动切到最新一张，避免切到本 tab 后空着
  useEffect(() => {
    if (artifactStatus === "loading") return;
    const latest = artifacts.find((item) => item.kind === "image" || item.kind === "video");
    if (!latest) return;
    const current = useAppStore.getState().activeArtifact;
    if (current?.kind === "image" || current?.kind === "video") return;
    void selectArtifact(latest.name);
  }, [artifacts, artifactStatus, selectArtifact]);

  if (media.length === 0) {
    return (
      <div className="panel-empty">
        {artifactStatus === "loading"
          ? "正在读取产物…"
          : "还没有图片或视频产物。"}
      </div>
    );
  }

  const current = activeArtifact?.kind === "image" || activeArtifact?.kind === "video" ? activeArtifact : null;

  return (
    <div>
      <div className="list-row" style={{ margin: 10, flexDirection: "column", gap: 4 }}>
        {media.map((artifact) => (
          <FileRow
            key={artifact.name}
            icon={artifact.kind === "video" ? "video" : "image"}
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
            <Icon name={current.kind === "video" ? "video" : "image"} size={13} />
            <span>{current.name}</span>
            <span className="spacer" />
            <span className="badge">{formatBytes(current.bytes)}</span>
          </div>
          {current.kind === "video" ? <VideoPlayer url={current.objectUrl} name={current.name} /> : <div className="media-preview__stage">
            <img className="media-preview__image" src={current.objectUrl} alt={current.name} />
          </div>}
        </div>
      ) : (
        <div className="panel-empty">{artifactError ?? "正在读取媒体…"}</div>
      )}
    </div>
  );
}