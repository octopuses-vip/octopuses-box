import { useEffect, useState } from "react";
import { desktopApiStatus, startDesktopApi, stopDesktopApi, type DesktopApiAccess } from "../app/desktop/apiService";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { copyText } from "../app/desktop/system";
import { useAppStore } from "../app/state";

/** Show the running desktop instance and allow the user to start or stop it. */
export function DesktopApiSetting() {
  const desktop = isDesktopRuntime();
  const cachePath = useAppStore((state) => state.cachePath);
  const authToken = useAppStore((state) => state.authToken);
  const modelSource = useAppStore((state) => state.modelSource);
  const setView = useAppStore((state) => state.setView);
  const [access, setAccess] = useState<DesktopApiAccess | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const ready = Boolean(cachePath) && (modelSource === "local" || Boolean(authToken));

  useEffect(() => {
    if (!desktop || busy) return;
    let mounted = true;
    /** Refresh status when the page is reopened or a background process exits. */
    async function refresh() {
      try {
        const next = await desktopApiStatus();
        if (mounted) setAccess(next);
      } catch {
        if (mounted) setError("无法读取 API 服务状态。");
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [desktop, busy]);

  /** Read the current settings at the point the user starts the service. */
  async function toggle() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      if (access) {
        await stopDesktopApi();
        setAccess(null);
      } else {
        const current = useAppStore.getState();
        if (!current.cachePath) throw new Error("请先设置缓存目录。");
        setAccess(await startDesktopApi({
          cachePath: current.cachePath,
          local: current.modelSource === "local",
          endpoint: current.endpoint,
          authToken: current.authToken,
          username: current.currentUser,
        }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Copy the Bearer token on demand without displaying it on screen. */
  async function copyToken() {
    if (!access) return;
    if (await copyText(access.token).catch(() => false)) setCopied(true);
    else setError("无法复制 API 令牌。");
  }

  if (!desktop) return null;
  return (
    <div className="page__section">
      <div className="page__section-label">本地 API</div>
      <div className="list-row">
        <span className="list-row__main">
          <span className="list-row__title">API 服务</span>
          <span className="list-row__desc" role="status">
            {busy ? (access ? "正在停止…" : "正在启动…")
              : access ? <span className="mono">{access.url}</span>
                : access === undefined ? "正在读取状态…"
                  : ready ? "启动后可从本机调用，使用当前模型与缓存。" : "请先设置缓存目录和模型来源。"}
          </span>
        </span>
        {access && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void copyToken()}>
            {copied ? "已复制" : "复制调用令牌"}
          </button>
        )}
        <button
          type="button" role="switch" aria-label="启动本地 API" aria-checked={Boolean(access)}
          className={access ? "switch switch--on" : "switch"}
          disabled={busy || access === undefined || (!access && !ready)}
          onClick={() => void toggle()}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setView("apiHistory")}>查看 API 会话</button>
      {error && <p className="page__desc" role="alert">{error}</p>}
    </div>
  );
}
