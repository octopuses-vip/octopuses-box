import { useRef, useState } from "react";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { pickFiles } from "../app/desktop/system";
import { readContextPath } from "../app/desktop/files";
import { useAppStore } from "../app/state";
import { readKnowledgeDocument } from "./importDocument";
import { ExportDialog, type ExportKind } from "./ExportDialog";
import { knowledgeRequest } from "./api";
import { useKnowledgeModel } from "./model";
import { knowledgeError, useKnowledgeStore } from "./store";
import type { KnowledgeSource } from "./types";

/** 函数级说明（开发者 Jan）：执行 KnowledgeLibrary 的单一职责，并返回可供调用方继续处理的结果。 */
export function KnowledgeLibrary({ showDocuments = true }: { showDocuments?: boolean }) {
  const scope = useAppStore((state) => state.cachePath);
  const fileLimitMb = useAppStore((state) => state.knowledgeFileLimitMb);
  const state = useKnowledgeStore();
  const enabled = useKnowledgeModel((model) => model.status?.enabled ?? false);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [preview, setPreview] = useState<KnowledgeSource | null>(null);
  const [visible, setVisible] = useState(20);
  const current = scope === state.scope;
  const documents = current ? state.sources.filter((source) => source.kind === "document") : [];

  const importFiles = async (files: { name: string; read: () => Promise<Uint8Array<ArrayBuffer>> }[]) => {
    if (!scope || !files.length) return;
    let success = 0;
    const errors: string[] = [];
    setMessage("");
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setBusy(`正在读取 ${index + 1}/${files.length}：${file.name}`);
        try {
          const source = await readKnowledgeDocument(file.name, await file.read(), fileLimitMb);
          setBusy(`正在分块并保存 ${index + 1}/${files.length}：${file.name}`);
          await state.put(scope, source);
          success++;
        } catch (error) { errors.push(`${file.name}：${knowledgeError(error)}`); }
      }
      await state.refresh(scope);
      const indexingNotice = enabled
        ? "，已加入向量化队列"
        : "；启用向量模型后会建立语义索引";
      setMessage(`已导入 ${success} 个文件${errors.length ? `；${errors.join("；")}` : `，相同正文自动去重${indexingNotice}。`}`);
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(""); }
  };

/** 函数级说明（开发者 Jan）：执行 choose 的单一职责，并返回可供调用方继续处理的结果。 */
  const choose = async () => {
    if (!isDesktopRuntime()) { input.current?.click(); return; }
    try {
      const paths = await pickFiles({ title: "导入知识库文档" });
      await importFiles(paths.map((path) => ({ name: path.split(/[\\/]/).at(-1) || path, read: async () => {
        const file = await readContextPath(path, null, fileLimitMb);
        if (file.kind !== "file") throw new Error("请选择文件");
        return file.bytes;
      } })));
    } catch (error) { setMessage(knowledgeError(error)); }
  };
/** 函数级说明（开发者 Jan）：执行 remove 的单一职责，并返回可供调用方继续处理的结果。 */
  const remove = async (id: string) => {
    if (!scope) return;
    setBusy("正在移除文档…");
    try { await state.remove(scope, id); } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(""); }
  };

  return (
    <div className="knowledge-library">
      <div className="knowledge-summary" role="status">
        <span>{current ? state.stats.conversations : 0} 条会话</span><span>{documents.length} 个文档</span>
        <span>{current ? state.stats.chunks : 0} 个片段</span>
        <span>{enabled ? `语义索引 ${current ? state.stats.indexed : 0}/${current ? state.stats.chunks : 0}` : "需启用向量模型"}</span>
      </div>
      <div className="knowledge-toolbar">
        <button type="button" className="btn btn--sm" disabled={!scope || !!busy} onClick={() => void choose()}>上传文档</button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!scope || !current || !!busy || state.syncing} onClick={() => setExporting("training")}>导出训练数据</button>
        <button type="button" className="btn btn--ghost btn--sm" title="勾选会话，分别导出为 Markdown" disabled={!scope || !current || !state.stats.conversations || !!busy || state.syncing} onClick={() => setExporting("markdown")}>导出知识文档</button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!scope || !documents.length || !!busy} onClick={() => setExporting("documents")}>导出原始资料</button>
        {enabled ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => useKnowledgeStore.setState((s) => ({ paused: !s.paused, retry: s.retry + 1 }))}>{state.paused ? "继续建立索引" : "暂停索引"}</button> : null}
        <button type="button" className="btn btn--ghost btn--sm" disabled={!scope || state.syncing} onClick={() => useKnowledgeStore.setState((s) => ({ retry: s.retry + 1 }))}>重新同步</button>
      </div>
      <input hidden ref={input} type="file" multiple aria-label="上传知识库文档" onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        void importFiles(files.map((file) => ({ name: file.name, read: async () => {
          if (file.size > fileLimitMb * 1024 * 1024) throw new Error(`文件超过 ${fileLimitMb} MB，请调整知识库上传限制`);
          return new Uint8Array(await file.arrayBuffer());
        } })));
      }} />
      <p className="page__desc knowledge-hint">支持 PDF、DOCX、XLSX、PPTX、Markdown、文本和源码，每个文件不超过 {fileLimitMb} MB（可在知识库中配置），解析后的正文不超过 32 MB。长文档自动分块，无需按字符数手动拆分。全部历史会话自动收录，新回复结束后增量更新；删除会话会同步移除其知识库记录。</p>
      {busy || message || state.syncing || state.indexing ? <p role="status" className="list-row__desc">{busy || message || (state.syncing ? "正在同步历史会话…" : "正在后台建立语义索引…")}</p> : null}
      {state.error || state.indexError ? <p role="alert" className="knowledge-error">{state.error || state.indexError}。可点击“重新同步”重试。</p> : null}
      {showDocuments ? <div className="page__section">
        <div className="page__section-label">已上传文档</div>
        {documents.slice(0, visible).map((source) => <div className="list-row" key={source.id}>
          <button type="button" className="knowledge-source-name" onClick={() => { if (scope) void knowledgeRequest<KnowledgeSource>(scope, { op: "get", id: source.id }).then(setPreview).catch((error) => setMessage(knowledgeError(error))); }}>{source.title}</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void remove(source.id)}>移除</button>
        </div>)}
        {!documents.length ? <p className="page__desc">还没有上传文档。会话记录会自动加入知识库。</p> : null}
        {documents.length > visible ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => setVisible((count) => count + 20)}>加载更多文档</button> : null}
      </div> : null}
      {exporting && scope ? <ExportDialog key={`${scope}:${exporting}`} scope={scope} kind={exporting} onClose={() => setExporting(null)} /> : null}
      {preview ? <SourcePreview source={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** 函数级说明（开发者 Jan）：执行 SourcePreview 的单一职责，并返回可供调用方继续处理的结果。 */
export function SourcePreview({ source, onClose }: { source: KnowledgeSource; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 原生 dialog 提供焦点圈定、Esc 关闭与返回触发按钮的焦点恢复。
  const open = (node: HTMLDialogElement | null) => { ref.current = node; if (node && !node.open) node.showModal(); };
  return <dialog ref={open} className="knowledge-dialog" aria-label={source.title} onClose={onClose}>
    <h2>{source.title}</h2>
    <pre className="knowledge-preview knowledge-preview--document">{source.body}</pre>
    <div className="login__actions"><button type="button" className="btn" onClick={() => ref.current?.close()}>关闭</button></div>
  </dialog>;
}
