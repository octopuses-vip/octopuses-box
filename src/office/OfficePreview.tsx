import { Icon } from "../components/Icon";
import "./office-preview.css";
import { base64FromBytes } from "../model/toolImage";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../app/state";
import { readArtifactBytes, writeArtifactBytes } from "../app/desktop/artifacts";
import { readOfficeText } from "../context/officeText";
import { draftKey, setDraftText, useConversationDrafts } from "../model/conversationDrafts";
import { editOffice } from "./edit";
import { PdfCanvas } from "./PdfCanvas";

/** Preview a source document and route annotations or new edited copies back to the conversation. */
export function OfficePreview({ directory, name, revision }: { directory: string; name: string; revision: number }) {
  const [source, setSource] = useState<Uint8Array | null>(null); const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [page, setPage] = useState(1); const [pages, setPages] = useState(1); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [text, setText] = useState(""); const [note, setNote] = useState(""); const [find, setFind] = useState(""); const [replacement, setReplacement] = useState("");
  const [sheet, setSheet] = useState(""); const [address, setAddress] = useState(""); const format = name.split(".").pop()!.toLowerCase();
  const countPages = useCallback((n: number) => setPages(n), []);
  useEffect(() => {
    let live = true; setSource(null); setPdf(null); setText(""); setSelected(""); setNote(""); setFind(""); setReplacement(""); setError(""); setPage(1); setBusy(true);
    void (async () => {
      const bytes = await readArtifactBytes(directory, name); if (!live) return; setSource(bytes);
      if (["docx", "xlsx", "pptx"].includes(format)) { try { setText(readOfficeText(format, bytes)); } catch { /* Image-only documents can still render. */ } }
      const { invoke } = await import("@tauri-apps/api/core"); const result = await invoke<number[]>("office_render", { directory, name }); if (live) setPdf(new Uint8Array(result));
    })().catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [directory, name, revision, format]);
  const annotate = () => {
    const selection = selected || window.getSelection()?.toString() || ""; const state = useAppStore.getState(); const key = draftKey(state.cachePath, state.activeThreadId);
    setDraftText(key, [useConversationDrafts.getState().text[key], `Office 批注：${directory}/${name}\n预览第 ${page} 页\n选区：${selection}\n修改要求：${note}`].filter(Boolean).join("\n\n")); state.showNotice("已将文档选区和修改要求加入输入框");
  };
  const save = async () => {
    if (!source) return; setError(""); setBusy(true);
    try {
      const changed = editOffice(source, format, format === "xlsx" ? { kind: "cell", sheet, address: address.toUpperCase(), value: replacement } : { kind: "replace", find, replacement });
      const output = name.replace(/\.[^.]+$/, "") + `.edited-${Date.now()}.${format}`;
      await writeArtifactBytes(directory, output, base64FromBytes(changed)); await useAppStore.getState().loadArtifacts(); await useAppStore.getState().selectArtifact(output);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="office-preview">
    <header className="office-preview__head"><Icon name="file" size={15} /><strong title={name}>{name}</strong><span>{format.toUpperCase()}</span></header>
    {pdf && <><div className="office-preview__toolbar"><button className="icon-btn" aria-label="上一页" disabled={page <= 1} onClick={() => { setSelected(""); setPage((p) => p - 1); }}><Icon name="chevron-left" size={14} /></button><span>{page} / {pages}</span><button className="icon-btn" aria-label="下一页" disabled={page >= pages} onClick={() => { setSelected(""); setPage((p) => p + 1); }}><Icon name="chevron-right" size={14} /></button><span className="spacer" /><small>选择文字以添加批注</small></div><div className="office-preview__page"><PdfCanvas bytes={pdf} page={page} onPages={countPages} onSelection={setSelected} /></div></>}
    {busy && <p className="inspector-caption" role="status">正在转换／保存文档…</p>}{error && <p className="inline-error" role="alert">{error}</p>}
    {!pdf && text && <pre className="workflow-output">{text}</pre>}
    <section className="office-preview__annotation">{selected && <blockquote>{selected}</blockquote>}<textarea className="form__input" rows={3} aria-label="文档修改要求" value={note} onChange={(e) => setNote(e.target.value)} placeholder="描述希望修改的内容…" /><div className="action-row"><span className="inspector-caption">{selected ? "附上选中文字" : `针对第 ${page} 页`}</span><button className="btn btn--sm" disabled={!note.trim()} onMouseDown={(e) => e.preventDefault()} onClick={annotate}><Icon name="message" size={13} />添加到会话</button></div></section>
    {["docx", "xlsx", "pptx"].includes(format) && <details className="disclosure office-preview__edit"><summary><Icon name="code" size={13} />编辑并另存副本<Icon name="chevron-down" size={11} /></summary><div className="inspector-stack">
      {format === "xlsx" ? <><input className="form__input" value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="工作表名称" /><input className="form__input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="单元格，例如 A1" /></> : <input className="form__input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="要替换的原文" />}
      <textarea className="form__input" value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder={format === "xlsx" ? "新值或以 = 开头的公式" : "替换为"} />
      <button className="btn btn--sm" disabled={busy || !source || (format === "xlsx" ? !sheet || !address : !find)} onClick={() => void save()}>保存副本并预览</button>
    </div></details>}
  </div>;
}
