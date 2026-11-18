import { useEffect, useState } from "react";
import { useAppStore } from "../app/state";
import { connectHost, hostRequest, startHost } from "../app/desktop/companion";
import { Icon } from "../components/Icon";
interface HostJob { id: string; prompt: string; status: string; workspace: string; result?: string; error?: string; approval?: { id: string; tool: string; arguments: unknown } }
interface HostStatus { modelReady: boolean; browserOnline: boolean; projects: { id: string; name: string }[]; jobs: HostJob[] }
const STATUS: Record<string, string> = { queued: "排队中", running: "运行中", approval: "等待批准", paused: "已暂停", interrupted: "运行中断", completed: "已完成", complete: "已完成", failed: "失败", error: "失败" };
const active = (job: HostJob) => ["queued", "running", "approval"].includes(job.status);
/** Show the exact side effect before a job can continue. */
function JobApproval({ approval, busy, decide }: { approval: NonNullable<HostJob["approval"]>; busy: boolean; decide: (approved: boolean) => void }) {
  const args = approval.arguments && typeof approval.arguments === "object" ? approval.arguments as Record<string, unknown> : {};
  const command = approval.tool === "exec_command";
  return <section className="job-approval"><div className="job-approval__title"><Icon name={command ? "terminal" : "file"} size={15} /><strong>{command ? "允许执行此命令？" : "允许修改此文件？"}</strong></div><pre>{command ? String(args.command ?? "") : String(args.path ?? "")}</pre>{!command && <details><summary>查看写入内容</summary><pre>{String(args.content ?? "")}</pre></details>}<div className="action-row"><button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decide(false)}>拒绝</button><button className="btn btn--primary btn--sm" disabled={busy} onClick={() => decide(true)}>允许一次</button></div></section>;
}
/** Jobs remain visible while host and pairing configuration stays out of the way. */
export function ConnectionsPanel() {
  const scope = useAppStore((s) => s.cachePath);
  const [status, setStatus] = useState<HostStatus | null>(null); const [error, setError] = useState("");
  const [lan, setLan] = useState(false); const [remote, setRemote] = useState(false); const [url, setUrl] = useState("");
  const [code, setCode] = useState(""); const [pair, setPair] = useState(""); const [prompt, setPrompt] = useState("");
  const [project, setProject] = useState(""); const [container, setContainer] = useState(false); const [network, setNetwork] = useState(false); const [busy, setBusy] = useState(false); const [creating, setCreating] = useState(false);
  const refresh = async () => { if (scope) setStatus(await hostRequest<HostStatus>(scope, "/status", undefined, remote)); };
  useEffect(() => {
    let live = true;
    const update = () => { if (scope) void hostRequest<HostStatus>(scope, "/status", undefined, remote).then((v) => { if (live) setStatus(v); }).catch(() => { if (live) setStatus(null); }); };
    setStatus(null); update(); const timer = setInterval(update, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [scope, remote]);
  const action = async (fn: () => Promise<unknown>, reload = true) => { setBusy(true); setError(""); try { await fn(); if (reload) await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const sync = async () => {
    if (!scope) return; const state = useAppStore.getState(); const model = state.modelConfig;
    await hostRequest(scope, "/configure", { projects: state.projects.filter((p) => p.path), model: model ? { url: model.url, key: model.key, model: model.modelId } : null });
  };
  if (!scope) return <div className="inspector-empty"><Icon name="folder" size={26} /><h3>先设置缓存目录</h3><p>后台服务会在本机保存任务进度。</p></div>;
  return <div className="inspector">
    <header className="inspector-head"><div><h2>后台任务</h2><p>关闭客户端后，独立服务继续工作。</p></div><button className="icon-btn" aria-label="新建后台任务" disabled={!status} onClick={() => setCreating(!creating)}><Icon name="plus" size={16} /></button></header>
    <div className="host-state"><span className={status ? "status-dot status-dot--active" : "status-dot"} /><span>{remote ? "远程主机" : "本地服务"} · {status ? "已连接" : "未连接"}</span>{status && <span className="host-state__model">{status.modelReady ? "模型就绪" : "待同步模型"}</span>}</div>
    {creating && status && <section className="inspector-section job-create"><h3>新建任务</h3><select className="form__input" aria-label="后台任务项目" value={project} onChange={(e) => setProject(e.target.value)}><option value="">选择项目</option>{status.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><textarea className="form__input" rows={4} value={prompt} placeholder="描述任务目标和验收条件…" onChange={(e) => setPrompt(e.target.value)} /><details className="disclosure"><summary>执行选项<Icon name="chevron-down" size={12} /></summary><label className="check-row"><input type="checkbox" checked={container} onChange={(e) => setContainer(e.target.checked)} />在 Docker 中运行已提交版本的独立副本</label><label className="check-row"><input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} />允许命令联网</label></details><div className="action-row"><button className="quiet-action" onClick={() => setCreating(false)}>取消</button><button className="btn btn--primary btn--sm" disabled={busy || !project || !prompt.trim() || !status.modelReady} onClick={() => void action(async () => { await hostRequest(scope, "/jobs", { projectId: project, prompt, container, network }, remote); setPrompt(""); setCreating(false); })}>启动任务<Icon name="arrow-up" size={13} /></button></div></section>}
    <div className="job-list">{status?.jobs.length ? status.jobs.slice().reverse().map((job) => <article className={`job-card job-card--${job.status}`} key={job.id}>
      <div className="job-card__head"><Icon name={job.status === "approval" ? "alert" : active(job) ? "clock" : "clipboard-check"} size={15} /><span>{STATUS[job.status] || job.status}</span><span className="spacer" /><button className="icon-btn" aria-label={active(job) ? "暂停任务" : "检查后继续任务"} disabled={busy} onClick={() => void action(() => hostRequest(scope, `/jobs/${job.id}/${active(job) ? "pause" : "resume"}`, {}, remote))}><Icon name={active(job) ? "pause" : "play"} size={13} /></button></div><h3>{job.prompt}</h3><p className="job-card__path" title={job.workspace}><Icon name="folder" size={12} />{job.workspace}</p>
      {job.approval && <JobApproval approval={job.approval} busy={busy} decide={(approved) => void action(() => hostRequest(scope, `/jobs/${job.id}/approve`, { id: job.approval!.id, approved }, remote))} />}
      {(job.result || job.error) && <details className="disclosure" open={Boolean(job.error)}><summary>{job.error ? "查看失败原因" : "查看任务结果"}<Icon name="chevron-down" size={11} /></summary><pre className={job.error ? "workflow-output inline-error" : "workflow-output"}>{job.result || job.error}</pre></details>}
    </article>) : <div className="inspector-empty"><Icon name="clock" size={28} /><h3>把任务交给后台</h3><p>为项目创建独立任务，在这里查看进度、批准操作和接续结果。</p>{status && <button className="btn btn--sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} />新建任务</button>}</div>}</div>
    <details className="disclosure host-settings" open={!status}><summary><Icon name="settings" size={14} />主机与设备<Icon name="chevron-down" size={12} /></summary><div className="inspector-stack">
      <label className="check-row"><input type="checkbox" checked={remote} onChange={(e) => { setRemote(e.target.checked); setError(""); setPair(""); setUrl(""); }} />连接远程主机</label>
      {remote ? <><input className="form__input" value={url} placeholder="https://主机地址，或本机 SSH 转发地址" onChange={(e) => setUrl(e.target.value)} /><input className="form__input" value={code} placeholder="目标主机的一次性配对码" onChange={(e) => setCode(e.target.value)} /><button className="btn btn--sm" disabled={busy || !url || !code} onClick={() => void action(() => connectHost(scope, url, code))}>配对主机</button></> : <>
        <label className="check-row"><input type="checkbox" checked={lan} onChange={(e) => setLan(e.target.checked)} />允许局域网设备访问</label><p className="inspector-caption">启动前设置。局域网使用 HTTP，公网访问需配置 HTTPS。</p>
        <div className="action-row"><button className="btn btn--sm" disabled={busy} onClick={() => void action(async () => { const host = await startHost(scope, lan); setUrl(host.url); await sync(); })}>{status ? "检查本地服务" : "启动本地服务"}</button><button className="quiet-action" disabled={busy || !status} onClick={() => void action(sync)}>同步模型与项目</button></div>
        {url && <p className="inspector-caption">访问地址：{url}。手机访问时将 127.0.0.1 换为本机局域网 IP。</p>}
        <button className="btn btn--sm" disabled={busy || !status} onClick={() => void action(async () => { const result = await hostRequest<{ code: string }>(scope, "/pair-code", {}); setPair(result.code); })}>配对手机或浏览器扩展</button>{pair && <div className="pair-code"><strong>{pair}</strong><small>5 分钟内有效 · 每个设备单独生成</small></div>}
        <details className="disclosure"><summary>高级选项<Icon name="chevron-down" size={11} /></summary><div className="inspector-stack"><button className="quiet-action" disabled={busy || !status} onClick={() => void action(async () => { const { invoke } = await import("@tauri-apps/api/core"); const result = await invoke<string>("prepare_container"); useAppStore.getState().showNotice(result); })}>准备 Docker 隔离环境</button><button className="quiet-action" disabled={busy || !status} onClick={() => void action(() => hostRequest(scope, "/revoke", {}))}>撤销所有设备配对</button><button className="quiet-action" disabled={busy || !status} onClick={() => void action(async () => { await hostRequest(scope, "/shutdown", {}); setStatus(null); }, false)}>停止本地服务</button></div></details>
      </>}
    </div></details>
    {busy && <p className="inspector-caption" role="status">正在处理请求…</p>}{error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
