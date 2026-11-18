import { useState } from "react";
import { useAppStore } from "../app/state";
import { hostRequest, startHost } from "../app/desktop/companion";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { copyText } from "../app/desktop/system";
import { draftKey, setDraftText, useConversationDrafts } from "../model/conversationDrafts";
import { Icon } from "../components/Icon";

interface BrowserTab { id: number; title: string; url: string }
interface Pairing { url: string; code: string; expires: number }

/** Use the common inspector status for preview and extension requests. */
function BrowserInspector({ scope }: { scope: string | null }) {
  const [url, setUrl] = useState("http://localhost:3000");
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function reveal() {
    const { invoke } = await import("@tauri-apps/api/core");
    const { browserExtension } = await invoke<{ browserExtension: string }>("integration_paths");
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(`${browserExtension}/manifest.json`);
  }

  async function openPreview() {
    if (!isDesktopRuntime()) throw new Error("浏览器预览需要桌面客户端。");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_preview_open", { url });
  }

  async function refreshTabs() {
    if (!scope) return;
    await startHost(scope);
    setTabs(await hostRequest<BrowserTab[]>(scope, "/browser/action", { action: "tabs" }));
    setLoaded(true);
  }

  async function createPairing() {
    if (!scope) return;
    const host = await startHost(scope);
    const result = await hostRequest<Omit<Pairing, "url">>(scope, "/pair-code", {});
    setPairing({ url: host.url, ...result });
  }

  async function revokePairings() {
    if (!scope) return;
    await startHost(scope);
    await hostRequest(scope, "/revoke", {});
    setPairing(null);
    setTabs([]);
    setLoaded(false);
    useAppStore.getState().showNotice("已解除浏览器扩展配对。");
  }

  function attachTab(tab: BrowserTab) {
    const state = useAppStore.getState();
    const key = draftKey(state.cachePath, state.activeThreadId);
    const context = `请使用 browser_live 查看标签页 ${tab.id}：${tab.title}（${tab.url}）`;
    setDraftText(key, [useConversationDrafts.getState().text[key], context].filter(Boolean).join("\n"));
    state.showNotice("已将标签页加入输入框");
  }

  async function copyPairing(value: string, label: string) {
    const copied = await copyText(value);
    useAppStore.getState().showNotice(copied ? `已复制${label}` : `无法复制${label}`);
  }

  return (
    <div className="inspector browser-inspector">
      <header className="inspector-head">
        <div><h2>浏览器</h2><p>预览页面，或使用已授权的标签页。</p></div>
        <Icon name="globe" size={17} />
      </header>
      <section className="inspector-section">
        <label className="field-label" htmlFor="preview-url">页面预览</label>
        <form className="browser-url" onSubmit={(event) => { event.preventDefault(); void action(openPreview); }}>
          <Icon name="globe" size={14} />
          <input id="preview-url" value={url} onChange={(event) => setUrl(event.target.value)} />
          <button className="icon-btn" title="打开预览窗口" aria-label="打开预览窗口" disabled={busy || !url.trim()}>
            <Icon name="chevron-right" size={15} />
          </button>
        </form>
        <p className="inspector-caption">在独立窗口预览。选中文字后可引用到当前会话。</p>
      </section>
      <section className="inspector-section">
        <div className="section-title">
          <h3>已连接的标签页</h3>
          <button type="button" className="icon-btn" aria-label="刷新已授权标签页" disabled={!scope || busy} onClick={() => void action(refreshTabs)}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
        {tabs.length ? (
          <div className="browser-tabs">
            {tabs.map((tab) => (
              <button type="button" key={tab.id} onClick={() => attachTab(tab)}>
                <Icon name="globe" size={17} />
                <span><strong>{tab.title || "无标题"}</strong><small>{tab.url}</small></span>
                <Icon name="plus" size={14} />
              </button>
            ))}
          </div>
        ) : (
          <div className="inspector-empty">
            <Icon name="globe" size={28} />
            <h3>{loaded ? "没有已授权的标签页" : "连接你的浏览器"}</h3>
            <p>安装扩展并授权网站后，可以在会话中使用已登录的标签页。</p>
          </div>
        )}
        <details className="disclosure" open={!tabs.length}>
          <summary>连接 Chrome 或 Edge<Icon name="chevron-down" size={11} /></summary>
          <ol className="setup-steps">
            <li>在扩展管理页启用开发者模式，加载下方目录。</li>
            <li>在扩展弹窗输入本机地址和配对码，再授权所需网站。</li>
          </ol>
          <div className="action-row">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void action(reveal)}>打开扩展目录</button>
            <button type="button" className="btn btn--sm" disabled={!scope || busy} onClick={() => void action(createPairing)}>生成配对码</button>
          </div>
          {pairing && (
            <div className="pair-code browser-pairing" aria-label="浏览器扩展配对">
              <button type="button" className="quiet-action" title="复制连接地址" onClick={() => void copyPairing(pairing.url, "连接地址")}>{pairing.url}<Icon name="copy" size={12} /></button>
              <button type="button" className="quiet-action" title="复制配对码" onClick={() => void copyPairing(pairing.code, "配对码")}><strong>{pairing.code}</strong><Icon name="copy" size={13} /></button>
              <small>配对码在 {new Date(pairing.expires).toLocaleTimeString()} 过期，仅可使用一次。</small>
            </div>
          )}
          <button type="button" className="quiet-action" disabled={!scope || busy} onClick={() => void action(revokePairings)}>解除所有扩展配对</button>
        </details>
      </section>
      {busy && <p className="inspector-caption" role="status">正在连接…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}

/** Keep tabs and one-time pairing codes scoped to the selected cache. */
export function BrowserPanel() {
  const scope = useAppStore((s) => s.cachePath);
  return <BrowserInspector key={scope} scope={scope} />;
}
