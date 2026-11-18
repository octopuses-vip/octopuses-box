import { useState } from "react";
import { useAppStore } from "../app/state";
import { hostRequest } from "../app/desktop/companion";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { draftKey, setDraftText, useConversationDrafts } from "../model/conversationDrafts";
import { Icon } from "../components/Icon";
import { useWorkflowUI } from "./store";
/** Preview and connected tabs are distinct actions on the same browser inspector. */
export function BrowserPanel() {
  const scope = useAppStore((s) => s.cachePath); const [url, setUrl] = useState("http://localhost:3000"); const [tabs, setTabs] = useState<{ id: number; title: string; url: string }[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const reveal = async () => { const { invoke } = await import("@tauri-apps/api/core"); const paths = await invoke<{ browserExtension: string }>("integration_paths"); const { revealItemInDir } = await import("@tauri-apps/plugin-opener"); await revealItemInDir(paths.browserExtension + "/manifest.json"); };
  const open = async () => { if (!isDesktopRuntime()) throw new Error("浏览器预览需要桌面客户端"); const { invoke } = await import("@tauri-apps/api/core"); await invoke("browser_preview_open", { url }); };
  return <div className="inspector browser-inspector"><header className="inspector-head"><div><h2>浏览器</h2><p>预览页面，或使用已授权的标签页。</p></div><Icon name="globe" size={17} /></header>
    <section className="inspector-section"><label className="field-label" htmlFor="preview-url">页面预览</label><form className="browser-url" onSubmit={(e) => { e.preventDefault(); void action(open); }}><Icon name="globe" size={14} /><input id="preview-url" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="预览网址" /><button className="icon-btn" title="打开预览窗口" aria-label="打开预览窗口" disabled={busy || !url.trim()}><Icon name="chevron-right" size={15} /></button></form><p className="inspector-caption">在独立窗口预览。选中文字后可引用到当前会话。</p></section>
    <section className="inspector-section"><div className="section-title"><h3>已连接的标签页</h3><button className="icon-btn" aria-label="刷新已授权标签页" disabled={!scope || busy} onClick={() => void action(async () => { if (scope) { setTabs(await hostRequest<typeof tabs>(scope, "/browser/action", { action: "tabs" })); setLoaded(true); } })}><Icon name="refresh" size={14} /></button></div>
    {tabs.length ? <div className="browser-tabs">{tabs.map((tab) => <button key={tab.id} onClick={() => { const s = useAppStore.getState(); const key = draftKey(s.cachePath, s.activeThreadId); setDraftText(key, [useConversationDrafts.getState().text[key], `请使用 browser_live 查看标签页 ${tab.id}：${tab.title}（${tab.url}）`].filter(Boolean).join("\n")); s.showNotice("已将标签页加入输入框"); }}><Icon name="globe" size={17} /><span><strong>{tab.title || "无标题"}</strong><small>{tab.url}</small></span><Icon name="plus" size={14} /></button>)}</div> : <div className="inspector-empty"><Icon name="globe" size={28} /><h3>{loaded ? "没有已授权的标签页" : "连接你的浏览器"}</h3><p>安装配套扩展并授权网站后，Agent 可以使用现有登录状态查看和操作页面。</p></div>}
    <details className="disclosure" open={!tabs.length}><summary>连接 Chrome 或 Edge<Icon name="chevron-down" size={11} /></summary><ol className="setup-steps"><li>启动本地后台服务，生成设备配对码。</li><li>在浏览器扩展管理页启用开发者模式，加载扩展目录。</li><li>输入配对码，并在扩展弹窗授权需要使用的网站。</li></ol><div className="action-row"><button className="btn btn--sm" onClick={() => void action(reveal)}>打开扩展目录</button><button className="quiet-action" onClick={() => useWorkflowUI.getState().open("connections")}>设置后台服务<Icon name="chevron-right" size={12} /></button></div></details></section>
    {busy && <p className="inspector-caption" role="status">正在连接…</p>}{error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
