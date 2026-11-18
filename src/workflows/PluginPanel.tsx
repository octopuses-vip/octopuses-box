import { useEffect, useState } from "react";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { useWorkflowUI } from "./store";
import { isDesktopRuntime } from "../app/desktop/runtime";
interface Installed { id: string; name: string; version: string; source: string }
interface Manifest { id: string; name: string; version: string; skills?: { id: string; content: string }[]; mcp?: unknown[] }
/** Keep plugin commands on the desktop adapter with explicit runtime errors. */
async function native<T>(name: string, args: Record<string, unknown>): Promise<T> { if (!isDesktopRuntime()) throw new Error("插件管理需要桌面客户端"); const { invoke } = await import("@tauri-apps/api/core"); return invoke<T>(name, args); }
/** Preview plugin resources and manage remote MCP account authorizations. */
export function PluginPanel() {
  const scope = useAppStore((s) => s.cachePath); const servers = useAppStore((s) => s.mcpServers);
  const [source, setSource] = useState(""); const [packages, setPackages] = useState<Manifest[]>([]); const [installed, setInstalled] = useState<Installed[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [serverId, setServerId] = useState(""); const [clientId, setClientId] = useState("");
  const [authorization, setAuthorization] = useState<{ id: string; server: string } | null>(null); const [oauthStatus, setOauthStatus] = useState("");
  const refresh = async () => { if (scope) { setInstalled(await native("plugins_list", { cachePath: scope })); await useAppStore.getState().loadSkills(); await useAppStore.getState().loadMcpServers(); } };
  useEffect(() => { if (scope) void native<Installed[]>("plugins_list", { cachePath: scope }).then(setInstalled).catch((e) => setError(String(e))); }, [scope]);
  useEffect(() => {
    if (!scope || !authorization) return; let live = true;
    const timer = setInterval(() => { void native<{ status: string; error?: string }>("mcp_oauth_status", { cachePath: scope, serverId: authorization.server, id: authorization.id }).then((result) => {
      if (!live) return; setOauthStatus(result.status);
      if (result.status === "complete" || result.status === "failed") { setAuthorization(null); if (result.error) setError(result.error); else void useAppStore.getState().loadMcpTools(authorization.server); }
    }).catch((e) => { if (live) { setError(String(e)); setAuthorization(null); } }); }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [authorization, scope]);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <div className="preferences-stack">
    <section className="preference-group"><h3>已安装的插件</h3><p className="inspector-caption">组合技能与 MCP 服务，为项目添加常用能力。</p>
      {installed.length ? installed.map((pkg) => <article className="plugin-entry" key={pkg.id}><span className="plugin-entry__icon"><Icon name="puzzle" size={20} /></span><div><strong>{pkg.name}</strong><small>{pkg.version}</small></div><span className="spacer" /><button className="quiet-action" disabled={busy} onClick={() => { setSource(pkg.source); setPackages([]); }}>检查更新</button><button className="icon-btn" aria-label={`卸载 ${pkg.name}`} disabled={busy} onClick={() => void action(async () => { await native("plugins_uninstall", { cachePath: scope, id: pkg.id }); await refresh(); })}><Icon name="trash" size={14} /></button></article>) : <div className="settings-empty"><Icon name="puzzle" size={24} /><span>尚未安装插件</span></div>}
      <details className="disclosure" open><summary><Icon name="plus" size={14} />从地址安装或更新<Icon name="chevron-down" size={11} /></summary><div className="inspector-stack"><input className="form__input" aria-label="插件来源地址" value={source} onChange={(e) => setSource(e.target.value)} placeholder="HTTPS 插件清单或市场索引地址" /><button className="btn btn--sm" disabled={busy || !source} onClick={() => void action(async () => { const value = await native<Manifest | { plugins: Manifest[] }>("plugins_fetch", { url: source }); setPackages("plugins" in value ? value.plugins : [value]); })}>预览插件</button></div></details>
      {packages.map((pkg) => <article className="plugin-preview" key={pkg.id}><div className="section-title"><h3>{pkg.name}</h3><span className="muted-count">{pkg.version}</span></div><p className="inspector-caption">{pkg.skills?.length ?? 0} 项技能 · {pkg.mcp?.length ?? 0} 个 MCP 服务</p>{pkg.skills?.map((skill) => <details className="disclosure" key={skill.id}><summary><Icon name="sparkles" size={13} />{skill.id}<Icon name="chevron-down" size={11} /></summary><pre className="workflow-output">{skill.content}</pre></details>)}<p className="inspector-caption">新 MCP 默认停用，安装后可在 MCP 设置中启用并绑定项目。</p><button className="btn btn--primary btn--sm" disabled={busy || !scope} onClick={() => void action(async () => { await native("plugins_install", { cachePath: scope, manifest: pkg, source }); await refresh(); setPackages([]); })}>安装所示资源</button></article>)}
    </section>
    <section className="preference-group"><div className="section-title"><h3>账号连接</h3><button className="quiet-action" onClick={() => { useAppStore.getState().setView("mcp"); useWorkflowUI.getState().open(null); }}>管理 MCP<Icon name="chevron-right" size={12} /></button></div><p className="inspector-caption">为已配置的远程 MCP 服务连接账号。授权过程在浏览器中完成。</p>
      <div className="inspector-stack"><select className="form__input" aria-label="账号连接服务" value={serverId} onChange={(e) => setServerId(e.target.value)}><option value="">选择 HTTP MCP 服务</option>{servers.filter((s) => /^https?:\/\//.test(s.command)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><details className="disclosure"><summary>OAuth 客户端设置<Icon name="chevron-down" size={11} /></summary><input className="form__input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID（支持动态注册时可留空）" /></details>
      <div className="action-row"><button className="btn btn--sm" disabled={busy || !scope || !serverId || Boolean(authorization)} onClick={() => void action(async () => {
        const result = await native<{ id: string; authorizationUrl: string }>("mcp_oauth_begin", { cachePath: scope, serverId, clientId });
        setAuthorization({ id: result.id, server: serverId }); setOauthStatus("等待浏览器授权"); const { openUrl } = await import("@tauri-apps/plugin-opener"); await openUrl(result.authorizationUrl);
      })}><Icon name="external" size={13} />连接账号</button><button className="quiet-action" disabled={busy || !serverId} onClick={() => void action(async () => { const server = servers.find((s) => s.id === serverId); if (server) await native("mcp_oauth_disconnect", { url: server.command }); setOauthStatus("已断开账号授权"); })}>断开连接</button></div></div>
      {oauthStatus && <p className="inline-note" role="status">{oauthStatus}</p>}
    </section>
    {busy && <p className="inspector-caption" role="status">正在处理…</p>}{error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
