import { useEffect, useState } from "react";

import { effectiveArtifactDir } from "../../../app/state/artifacts";
import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";
import { isHtmlArtifact } from "../../../tools/writeFile";

/**
 * 网页预览：把模型写出的 HTML 产物放在沙箱 iframe 里渲染。
 *
 * 沙箱只放开脚本与表单，不给 `allow-same-origin`——生成的页面拿不到本应用的源，
 * 也无法访问本地存储，避免模型产出的内容反过来影响应用本身。
 */
export function WebPreview() {
  const artifacts = useAppStore((state) => state.artifacts);
  const activeArtifact = useAppStore((state) => state.activeArtifact);
  const artifactStatus = useAppStore((state) => state.artifactStatus);
  const artifactDir = useAppStore((state) => effectiveArtifactDir(state));
  const loadArtifacts = useAppStore((state) => state.loadArtifacts);
  const selectArtifact = useAppStore((state) => state.selectArtifact);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (artifactStatus === "idle") void loadArtifacts();
  }, [artifactStatus, loadArtifacts]);

  // 当前选中的不是 HTML 时，自动切到最新的 HTML 产物
  useEffect(() => {
    if (artifactStatus === "loading") return;
    const htmlArtifacts = artifacts.filter((item) => isHtmlArtifact(item.name));
    if (htmlArtifacts.length === 0) return;
    const current = useAppStore.getState().activeArtifact;
    if (current && isHtmlArtifact(current.name)) return;
    void selectArtifact(htmlArtifacts[0].name);
  }, [artifacts, artifactStatus, selectArtifact]);

  const html =
    activeArtifact && isHtmlArtifact(activeArtifact.name) ? activeArtifact.content : null;

  if (!html) {
    const hasHtml = artifacts.some((item) => isHtmlArtifact(item.name));
    return (
      <div className="panel-empty">
        <div>
          {artifactStatus === "loading"
            ? "正在读取产物…"
            : hasHtml
              ? "正在读取页面内容…"
              : "还没有 HTML 产物。让模型生成网页（写出 .html 文件）后会自动在这里渲染。"}
        </div>
        {/* 与「文件」tab 一致：没有页面时也把产物目录摊开，说明该去哪儿找 */}
        {artifactDir ? <div className="panel-empty__path">{artifactDir}</div> : null}
      </div>
    );
  }

  return (
    /* 整块预览撑满右栏可用高度：高度从容器一路传到 iframe，页面才能真正铺满屏幕 */
    <div className="web-preview">
      <div className="browser-frame">
        <div className="browser-frame__bar">
          <span className="browser-frame__dots">
            <span className="browser-frame__dot" />
            <span className="browser-frame__dot" />
            <span className="browser-frame__dot" />
          </span>
          <span className="browser-frame__url">{activeArtifact?.name}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={showSource ? "返回预览" : "查看源码"}
            title={showSource ? "返回预览" : "查看源码"}
            onClick={() => setShowSource((value) => !value)}
          >
            <Icon name="code" size={13} />
          </button>
        </div>
        {showSource ? (
          <pre className="file-preview__code web-preview__source">{html}</pre>
        ) : (
          <div className="browser-frame__viewport browser-frame__viewport--fill">
            <iframe
              className="browser-frame__frame"
              title={`预览 ${activeArtifact?.name ?? "产物"}`}
              sandbox="allow-scripts allow-forms allow-modals"
              srcDoc={html}
            />
          </div>
        )}
      </div>
      <div className="panel-empty">本机生成，已在沙箱隔离中渲染</div>
    </div>
  );
}