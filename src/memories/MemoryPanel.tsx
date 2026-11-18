import { useState } from "react";
import { useAppStore } from "../app/state";
import { taskKey } from "../tasks/store";
import { useMemoryStore } from "./store";
import { Icon } from "../components/Icon";
/** Memory controls describe their effect and keep individual entries editable. */
export function MemoryPanel() {
  const scope = useAppStore((s) => s.cachePath) ?? ""; const thread = useAppStore((s) => s.activeThreadId);
  const project = useAppStore((s) => s.threads.find((t) => t.id === thread)?.projectId ?? "");
  const memories = useMemoryStore(); const [text, setText] = useState(""); const key = taskKey(scope, thread);
  const chat = memories.chats[key] ?? { use: true, contribute: true };
  const flag = (field: "use" | "contribute", value: boolean) => useMemoryStore.setState((s) => ({ chats: { ...s.chats, [key]: { ...chat, [field]: value } } }));
  const entries = memories.entries.filter((m) => m.scope === scope && (!m.projectId || m.projectId === project));
  return <div className="preferences-stack">
    <section className="preference-group"><label className="preference-row"><span><strong>长期记忆</strong><small>在后续任务中使用本机保存的偏好与项目经验。</small></span><input role="switch" type="checkbox" checked={memories.enabled} onChange={(e) => useMemoryStore.setState({ enabled: e.target.checked })} /></label><label className="preference-row"><span><strong>自动整理经验</strong><small>任务完成后由当前模型提炼，需要使用模型额度。</small></span><input role="switch" type="checkbox" checked={memories.contribute} onChange={(e) => useMemoryStore.setState({ contribute: e.target.checked })} /></label></section>
    <section className="preference-group"><h3>当前会话</h3><label className="preference-row"><span>使用已保存的记忆</span><input role="switch" type="checkbox" checked={chat.use} onChange={(e) => flag("use", e.target.checked)} /></label><label className="preference-row"><span>将经验保存为记忆</span><input role="switch" type="checkbox" checked={chat.contribute} onChange={(e) => flag("contribute", e.target.checked)} /></label></section>
    <section className="preference-group"><div className="section-title"><h3>已保存的记忆</h3><span className="muted-count">{entries.length}</span></div><div className="memory-add"><textarea className="form__input" rows={3} aria-label="新增记忆" value={text} onChange={(e) => setText(e.target.value)} placeholder="添加已验证的项目约定或个人偏好…" /><div className="action-row"><span className="inspector-caption">{project ? "保存到当前项目" : "保存为个人偏好"}</span><button className="btn btn--sm" disabled={!scope || !text.trim()} onClick={() => { memories.add({ scope, projectId: project, text, sourceThread: thread }); setText(""); }}><Icon name="plus" size={13} />添加记忆</button></div></div>
      {entries.map((m) => <article className="memory-entry" key={m.id}><textarea className="form__input" aria-label="记忆内容" defaultValue={m.text} onBlur={(e) => useMemoryStore.setState((s) => ({ entries: s.entries.map((v) => v.id === m.id ? { ...v, text: e.target.value, updatedAt: Date.now() } : v) }))} /><footer><span>{m.projectId ? "项目记忆" : "个人偏好"} · {new Date(m.updatedAt).toLocaleDateString()}</span><button className="icon-btn" aria-label="删除记忆" onClick={() => memories.remove(m.id)}><Icon name="trash" size={14} /></button></footer></article>)}
      {!entries.length && <p className="inspector-caption">暂时没有记忆。你可以手动添加，也可以在完成任务后自动整理。</p>}
    </section>
  </div>;
}
