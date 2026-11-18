import { useState } from "react";
import { useAppStore } from "../app/state";

/** Let Windows users prepare the image used by isolated commands in normal sessions. */
export function WindowsSandboxSetup() {
  const platform = useAppStore((s) => s.platform);
  const showNotice = useAppStore((s) => s.showNotice);
  const [preparing, setPreparing] = useState(false);

  if (platform !== "windows") return null;

  async function prepare() {
    setPreparing(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      showNotice(await invoke<string>("prepare_container"));
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="list-row">
      <span className="list-row__main">
        <span className="list-row__title">Docker 隔离环境</span>
        <span className="list-row__desc">启动 Docker 后，准备会话命令使用的隔离镜像。</span>
      </span>
      <button type="button" className="btn btn--sm" disabled={preparing} onClick={() => void prepare()}>
        {preparing ? "正在准备…" : "准备镜像"}
      </button>
    </div>
  );
}
