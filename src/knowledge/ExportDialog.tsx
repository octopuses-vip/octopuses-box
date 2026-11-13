import { useEffect, useRef, useState } from "react";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { pickDirectory, saveFileAs } from "../app/desktop/system";
import { selectModelConnectionByCode } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { knowledgeRequest } from "./api";
import { trainingRecord } from "./content";
import { groupExportSources, selectedExportSources, toggleExportGroup } from "./exportSelection";
import { reviewExportSource } from "./exportReview";
import { prepareTrainingSource } from "./prepareTraining";
import { loadExportSources } from "./exportSources";
import { knowledgeError } from "./store";
import type { KnowledgeSource, MarkdownExportResult, TrainingFormat } from "./types";

/** 函数级说明（开发者 Jan）：执行 exportKnowledgeMarkdown 的单一职责，并返回可供调用方继续处理的结果。 */
export async function exportKnowledgeMarkdown(scope: string, sources?: KnowledgeSource[]): Promise<MarkdownExportResult | null> {
  const desktop = isDesktopRuntime();
  const path = desktop ? await pickDirectory("选择知识文档的导出位置") : "";
  if (desktop && !path) return null;
  const result = await knowledgeRequest<MarkdownExportResult>(scope, { op: "export_markdown", path: path ?? "", sources });
  if (result.files) {
    const { knowledgeMarkdownZip } = await import("./markdown");
    const data = await knowledgeMarkdownZip(result.files);
    const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `octopuses-knowledge-${Date.now()}.zip`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return result;
}

export const TRAINING_FORMATS: { id: TrainingFormat; label: string; description: string }[] = [
  { id: "messages", label: "messages JSONL", description: "每行一条完整多轮对话，使用 role / content 字段。" },
  { id: "alpaca", label: "Alpaca JSONL", description: "每行一条会话；最后一轮作为 instruction / output，之前的对话保留在 input 中。" },
  { id: "sharegpt", label: "ShareGPT JSONL", description: "保留多轮对话，使用 conversations 数组与 human / gpt 角色。" },
];

/** 函数级说明（开发者 Jan）：执行 exportKnowledge 的单一职责，并返回可供调用方继续处理的结果。 */
export async function exportKnowledge(scope: string, format: TrainingFormat | "documents", sources?: KnowledgeSource[]) {
  const filename = `octopuses-${format}-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const path = isDesktopRuntime() ? await saveFileAs({ title: "导出知识库数据", defaultPath: filename,
    filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] }) : filename;
  if (!path) return null;
  const result = await knowledgeRequest<{ count: number; skipped: number; text?: string }>(scope, { op: "export", path, format, sources });
  if (result.text !== undefined) {
    const url = URL.createObjectURL(new Blob([result.text], { type: "application/x-ndjson;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return result;
}

const sample: KnowledgeSource = {
  id: "sample", kind: "conversation", title: "结构示例", threadId: "sample", body: "", hash: "", updatedAt: 0,
  messages: [{ id: "1", role: "user", content: "用户问题" }, { id: "2", role: "assistant", content: "助手回答" }],
};

export type ExportKind = "training" | "markdown" | "documents";

/** 函数级说明（开发者 Jan）：执行 serviceOrigin 的单一职责，并返回可供调用方继续处理的结果。 */
function serviceOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return "未配置有效服务地址"; }
}

/** 函数级说明（开发者 Jan）：执行 ExportDialog 的单一职责，并返回可供调用方继续处理的结果。 */
export function ExportDialog({ scope, kind = "training", onClose }: { scope: string; kind?: ExportKind; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const doneRef = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<TrainingFormat>("messages");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [snapshot] = useState(() => useAppStore.getState());
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [review, setReview] = useState(false);
  const [expand, setExpand] = useState(false);
  const [model, setModel] = useState("");
  const [questionModel, setQuestionModel] = useState("");
  const [prepared, setPrepared] = useState<KnowledgeSource[] | null>(null);
  const [report, setReport] = useState<{ title: string; kept: boolean; reason: string }[]>([]);
  const controller = useRef<AbortController | null>(null);
  const [done, setDone] = useState("");
  const connection = selectModelConnectionByCode(snapshot, model);
  const questionConnection = selectModelConnectionByCode(snapshot, questionModel);
  const hasDocuments = kind === "training" && sources.some((source) => source.kind === "document" && selection.has(source.id));
  const needsPreparation = review || hasDocuments;
  // 与会话内模型请求共用「模型请求重试次数」设置：评审 / 扩展请求失败自动按指数退避重试
  const reviewRetries = useAppStore((state) => state.modelRetryCount);
  useEffect(() => {
    ref.current?.showModal();
    let active = true;
    void (async () => {
      try {
        const result = await loadExportSources(scope, kind, snapshot);
        if (active) {
          setSources(result.sources);
          setSelection(new Set(result.sources.map((s) => s.id)));
          setLoadWarnings(result.warnings);
        }
      } catch (error) { if (active) setMessage(knowledgeError(error)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.current?.abort(); };
  }, [scope, kind, snapshot]);
/** 函数级说明（开发者 Jan）：执行 invalidate 的单一职责，并返回可供调用方继续处理的结果。 */
  const invalidate = () => { setPrepared(null); setReport([]); setMessage(""); };
/** 函数级说明（开发者 Jan）：执行 toggle 的单一职责，并返回可供调用方继续处理的结果。 */
  const toggle = (ids: string[], checked: boolean) => { setSelection((s) => toggleExportGroup(s, ids, checked)); invalidate(); };
  const groups = groupExportSources(sources, snapshot.threads, snapshot.projects, kind !== "markdown");
/** 函数级说明（开发者 Jan）：执行 runReview 的单一职责，并返回可供调用方继续处理的结果。 */
  const runReview = async () => {
    if (review && !connection?.url) { setMessage("请先选择已配置服务地址的评审模型"); return; }
    if (hasDocuments && !questionConnection?.url) { setMessage("请先选择已配置服务地址的提问模型"); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setPrepared(null); setReport([]);
    try {
      const chosen = selectedExportSources(sources, selection);
      const clean: KnowledgeSource[] = [];
      const reports: typeof report = [];
      let keptSources = 0;
      for (const [index, source] of chosen.entries()) {
        const reviewConnection = review && connection ? { url: connection.url, key: connection.key, model: connection.modelId, retries: reviewRetries } : undefined;
        const onProgress = (message: string) => setMessage(`资料 ${index + 1}/${chosen.length} · ${message}`);
        const result = kind === "training"
          ? await prepareTrainingSource(source, { reviewConnection,
            questionConnection: questionConnection ? { url: questionConnection.url, key: questionConnection.key, model: questionConnection.modelId, retries: reviewRetries } : undefined,
            expand, signal: abort.signal, onProgress })
          : await reviewExportSource(source, reviewConnection!, abort.signal,
            (done, total) => onProgress(`正在评审：${source.title} · ${done}/${total}`))
            .then((r) => ({ sources: r.source ? [r.source] : [], kept: !!r.source, reason: r.reason }));
        if (result.kept) keptSources++;
        clean.push(...result.sources);
        reports.push({ title: source.title, kept: result.kept, reason: result.reason });
        setReport([...reports]);
      }
      setPrepared(clean);
      abort.signal.throwIfAborted();
      setMessage(`处理完成：可导出 ${clean.length} 条，${chosen.length - keptSources} 条资料未产生可用结果。请检查下方结果后导出。`);
    } catch (error) { setPrepared(null); setMessage(abort.signal.aborted ? "处理已取消，未生成导出数据。" : `处理失败：${knowledgeError(error)}；未导出任何数据，请重试。`); }
    finally { controller.current = null; setBusy(false); }
  };
/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = async () => {
    setBusy(true); setMessage("");
    try {
      const chosen = needsPreparation ? prepared : selectedExportSources(sources, selection);
      if (!chosen?.length) throw new Error("没有可导出的资料，请完成评审并确认保留结果");
      if (kind === "markdown") {
        const result = await exportKnowledgeMarkdown(scope, chosen);
        if (result) setDone(`已导出 ${result.count} 个 Markdown 文件${result.directory ? `，目录：${result.directory}` : "，请解压下载的 ZIP 查看。"}。`);
      } else {
        const result = await exportKnowledge(scope, kind === "documents" ? "documents" : format, chosen);
        if (result) setDone(`已导出 ${result.count} 条资料，跳过 ${result.skipped} 条无完整问答的会话。`);
      }
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (done) doneRef.current?.showModal(); }, [done]);
  const finishExport = () => { doneRef.current?.close(); setDone(""); onClose(); };
  return (
    <>
    <dialog ref={ref} className="knowledge-dialog" aria-labelledby="knowledge-export-title" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={onClose}>
      <h2 id="knowledge-export-title">{kind === "training" ? "导出训练数据" : kind === "markdown" ? "导出知识文档" : "导出原始资料"}</h2>
      <div className="knowledge-dialog__body">
      <p className="page__desc">按项目、会话或上传的文档勾选。本次使用打开窗口时的内容快照；生成、评审和导出均不修改原始记录。</p>
      <fieldset disabled={busy || loading} className="knowledge-export-selection">
        <label><input type="checkbox" checked={sources.length > 0 && selection.size === sources.length} ref={(node) => { if (node) node.indeterminate = selection.size > 0 && selection.size < sources.length; }} onChange={(e) => toggle(sources.map((s) => s.id), e.target.checked)} />全选 <span className="muted">已选 {selection.size} / {sources.length}</span></label>
        {loading ? <p>正在读取资料…</p> : !sources.length ? <p>暂无可导出的资料。</p> : null}
        <div className="knowledge-export-groups">
          {[...groups].map(([id, group]) => {
            const count = group.sources.filter((s) => selection.has(s.id)).length;
            return <details key={id} open><summary><label onClick={(e) => e.stopPropagation()}><input type="checkbox" disabled={!group.sources.length} checked={group.sources.length > 0 && count === group.sources.length} ref={(node) => { if (node) node.indeterminate = count > 0 && count < group.sources.length; }} onChange={(e) => toggle(group.sources.map((s) => s.id), e.target.checked)} />{group.title} <span className="muted">{count}/{group.sources.length}</span></label></summary>
              {id === "documents" && !group.sources.length ? <p className="page__desc">{loading ? "正在读取上传的文档…" : loadWarnings.some((warning) => warning.includes("文档") && warning.includes("读取失败")) ? "文档读取失败，请查看下方提示后重新打开导出。" : "暂无已上传文档。请关闭此窗口，在知识库中点击“上传文档”，完成后再打开导出。"}</p> : null}
              {group.sources.map((source) => <label className="knowledge-export-item" key={source.id}><input type="checkbox" checked={selection.has(source.id)} onChange={(e) => toggle([source.id], e.target.checked)} /><span>{source.title || "未命名会话"}</span></label>)}
            </details>;
          })}
        </div>
      </fieldset>
      {loadWarnings.map((warning, index) => <p className="page__desc" role="status" key={index}>{warning}</p>)}
      {kind === "training" ? <><label className="knowledge-field">导出格式
        <select className="form__select" aria-label="导出格式" value={format} disabled={busy} onChange={(event) => { setFormat(event.target.value as TrainingFormat); setMessage(""); }}>
          {TRAINING_FORMATS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </label>
      <p className="page__desc">{TRAINING_FORMATS.find((item) => item.id === format)!.description}</p>
      <details><summary>格式示例</summary><pre className="knowledge-preview">{JSON.stringify(trainingRecord(sample, format), null, 2)}</pre></details>
      <p className="page__desc">仅包含正文及文字附件，跳过推理、工具日志和末尾未回答的问题。</p></> : null}
      <label className="knowledge-review-toggle"><input type="checkbox" checked={review} disabled={busy} onChange={(e) => { setReview(e.target.checked); if (!e.target.checked) setExpand(false); invalidate(); }} />导出前使用模型评审并清洗</label>
      {kind === "training" ? <div className="knowledge-export-review">
        <label className="knowledge-field">文档提问模型<select className="form__select" aria-label="提问模型" value={questionModel} disabled={busy || !hasDocuments} onChange={(e) => { setQuestionModel(e.target.value); invalidate(); }}><option value="">选择模型</option>{snapshot.remoteModels.map((m) => <option key={m.code} value={m.code}>{m.name || m.code}</option>)}</select></label>
        {!hasDocuments ? <p className="page__desc">勾选上方“上传的文档”后，可选择提问模型生成训练问答。</p> : null}
        {!snapshot.remoteModels.length ? <p className="page__desc">暂无可用模型，请先在设置的模型配置中添加模型，再打开导出窗口。</p> : null}
        <p className="page__desc">提问模型根据所选文档生成独立问题和答案，长文档自动分批处理。点击“生成训练数据”会将文档发送到所选模型服务{questionConnection?.url ? `（${serviceOrigin(questionConnection.url)}）` : ""}，可能产生费用。请预览生成结果后导出。</p>
      </div> : null}
      {review ? <div className="knowledge-export-review">
        <label className="knowledge-field">评审模型<select className="form__select" value={model} disabled={busy} onChange={(e) => { setModel(e.target.value); invalidate(); }}><option value="">选择模型</option>{snapshot.remoteModels.map((m) => <option key={m.code} value={m.code}>{m.name || m.code}</option>)}</select></label>
        {!snapshot.remoteModels.length ? <p className="page__desc">暂无可用模型，请先在设置的模型配置中添加模型，再打开导出窗口。</p> : null}
        <p className="page__desc">长会话和文档会自动分批评审，不截断正文。单轮过长时继续分段；任一片段被剔除时整轮问答（文档则整篇）一并移除。批次数较多时耗时和费用会增加，可随时取消。</p>
        <p className="page__desc">点击“开始评审”会将勾选资料发送到所选模型服务{connection?.url ? `（${serviceOrigin(connection.url)}）` : ""}，可能产生费用。清洗仅移除消息或将敏感原文替换为 [已脱敏]，不会补写答案。模型无法保证事实正确，请检查结果。</p>
        {kind === "training" ? <><label className="knowledge-review-toggle"><input type="checkbox" checked={expand} disabled={busy || !review} onChange={(e) => { setExpand(e.target.checked); invalidate(); }} />评审后扩展训练数据（枚举、拆分问题并生成更多可回答问答）</label>
        <p className="page__desc">扩展内容只依据清洗后的资料生成；模型会按内容价值决定数量，也可能不生成。扩展结果会作为独立问答一起导出，并增加模型调用次数。</p></> : null}
      </div> : null}
      {needsPreparation ? <div className="knowledge-export-review">
        <button type="button" className="btn btn--sm" disabled={busy || loading || !selection.size || (review && !connection?.url) || (hasDocuments && !questionConnection?.url)} onClick={() => void runReview()}>{busy ? "正在处理…" : hasDocuments ? "生成训练数据" : "开始评审"}</button>
        {busy && controller.current ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => controller.current?.abort()}>取消处理</button> : null}
        {report.map((r, index) => <p className="page__desc" key={index}>{r.kept ? "保留" : "剔除"} · {r.title}：{r.reason}</p>)}
        {prepared?.length ? <details><summary>查看待导出内容（{prepared.length} 条）</summary>{prepared.map((s) => <div key={s.id}><h3>{s.title}</h3><pre className="knowledge-preview">{s.body}</pre></div>)}</details> : null}
      </div> : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="login__actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => ref.current?.close()}>关闭</button>
        <button type="button" className="btn btn--primary" disabled={busy || loading || !selection.size || (needsPreparation && !prepared?.length)} onClick={() => void submit()}>{busy ? "正在处理…" : kind === "markdown" ? "导出 Markdown" : "导出 JSONL"}</button>
      </div>
      </div>
    </dialog>
    {/* 导出完成提示：嵌套在导出弹窗之上，点「确认」后一并关闭整个导出流程 */}
    <dialog ref={doneRef} className="knowledge-dialog knowledge-dialog--notice" aria-labelledby="knowledge-export-done-title" onCancel={(event) => { event.preventDefault(); finishExport(); }} onClose={() => {}}>
      <h2 id="knowledge-export-done-title">导出完成</h2>
      <div className="knowledge-dialog__body">
      <p>{done}</p>
      <div className="login__actions">
        <button type="button" className="btn btn--primary" autoFocus onClick={finishExport}>确认</button>
      </div>
      </div>
    </dialog>
    </>
  );
}
