import { useEffect, useState } from "react";
import { useAppStore } from "../app/state";
import { DEFAULT_KNOWLEDGE_FILE_MB, MAX_KNOWLEDGE_FILE_MB } from "./importLimits";

/** 知识库上传限制按设备保存，输入完成后显式保存，避免输入中间值生效。 */
export function ImportLimitSettings() {
  const limit = useAppStore((state) => state.knowledgeFileLimitMb);
  const setLimit = useAppStore((state) => state.setKnowledgeFileLimitMb);
  const [draft, setDraft] = useState(String(limit));
  const [message, setMessage] = useState("");
  useEffect(() => { setDraft(String(limit)); }, [limit]);
  const save = () => {
    const value = Number(draft);
    if (!draft.trim() || !Number.isInteger(value) || value < 1 || value > MAX_KNOWLEDGE_FILE_MB) {
      setMessage(`请输入 1–${MAX_KNOWLEDGE_FILE_MB} 之间的整数。`);
      return;
    }
    setLimit(value);
    setMessage(`已保存，后续导入的单文件上限为 ${value} MB。`);
  };
  return <div className="page__section">
    <label className="knowledge-field">单文件大小上限（MB）
      <input className="form__input" type="number" aria-label="知识库单文件大小上限（MB）"
        min={1} max={MAX_KNOWLEDGE_FILE_MB} step={1} value={draft}
        onChange={(event) => { setDraft(event.target.value); setMessage(""); }} />
    </label>
    <p className="page__desc">默认 {DEFAULT_KNOWLEDGE_FILE_MB} MB，可设为 1–{MAX_KNOWLEDGE_FILE_MB} MB。仅用于知识库上传，保存后立即生效并在重启后保留。解析后的正文最多 32 MB。</p>
    <button type="button" className="btn btn--sm" onClick={save}>保存上传限制</button>
    {message ? <p role="status" className="page__desc">{message}</p> : null}
  </div>;
}
