import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { formatBytes } from "../model/attachments";
import { AUDIO_ACCEPT, AUDIO_MIME, type AudioFile, validateAudio } from "./files";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { inspectAudioFile } from "../app/desktop/audioFiles";
import { pickFiles } from "../app/desktop/system";
import { transcribeAudio, transcriptionConnection } from "./transcription";
import "./audio.css";

/** A focused import-and-review flow keeps transcription independent of chat execution. */
export function AudioTranscriptionButton({ onInsert }: { onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<AudioFile | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const models = useAppStore((s) => s.remoteModels);
  const code = useAppStore((s) => s.audioModelCode);
  const setCode = useAppStore((s) => s.setAudioModelCode);
  const available = models.some((model) => model.code === code);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => () => { controller.current?.abort(); }, []);

  /** Closing or navigating away cancels the upload and ignores any late result. */
  const close = () => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setOpen(false);
  };

  /** A fresh attempt replaces only the review area; the conversation draft stays untouched. */
  const start = async () => {
    if (!file || controller.current) return;
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setError("");
    setText(null);
    try {
      const state = useAppStore.getState();
      const result = await transcribeAudio(file, transcriptionConnection(state.remoteModels, state.audioModelCode), run.signal, (status) => {
        if (controller.current === run && !run.signal.aborted) setProgress(status);
      }, { cachePath: state.cachePath, scope: JSON.stringify([state.modelSource, state.endpoint, state.currentUser]) });
      if (controller.current === run && !run.signal.aborted) setText(result);
    } catch (cause) {
      if (controller.current === run && !run.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "音频转写失败，请重试。");
      }
    } finally {
      if (controller.current === run) { controller.current = null; setBusy(false); }
    }
  };

  return <>
    <button type="button" className="chip" title="音频转文字" aria-label="音频转文字" onClick={() => setOpen(true)}>
      <Icon name="audio" size={14} />
    </button>
    <dialog ref={dialog} className="audio-dialog" aria-labelledby="audio-title" onCancel={(event) => { event.preventDefault(); close(); }} onClose={close}>
      <div className="modal__head">
        <Icon name="audio" />
        <span id="audio-title" className="modal__title">音频转文字</span>
        <button type="button" className="icon-btn audio-dialog__close" aria-label="关闭音频转文字" onClick={close}><Icon name="close" /></button>
      </div>
      <p className="page__desc">上传录音并识别为文字，完成后可编辑并插入输入框。</p>
      <label className="audio-dialog__field">
        <span className="form__label">语音识别模型</span>
        <select className="form__select" value={code} disabled={busy} onChange={(event) => setCode(event.target.value)}>
          <option value="">请选择语音识别模型</option>
          {code && !available ? <option value={code}>原模型已不可用，请重新选择</option> : null}
          {models.map((model) => <option key={model.code} value={model.code}>{model.name || model.code}</option>)}
        </select>
      </label>
      {!available ? <p className="form__hint">请添加或选择支持音频转写的模型。也可在「设置 → 模型与连接」中配置。</p> : null}
      <div className="audio-dialog__field">
        <span className="form__label">音视频文件</span>
        {isDesktopRuntime() ? <button type="button" className="btn" aria-label="选择音视频文件" disabled={busy} onClick={() => {
          void pickFiles({ title: "选择音视频文件", multiple: false, filters: [{ name: "音视频", extensions: Object.keys(AUDIO_MIME) }] }).then(async (paths) => {
            if (!paths[0]) return;
            const source = await inspectAudioFile(paths[0]);
            setFile(source); setError(""); setText(null);
          }).catch((cause) => setError(String(cause)));
        }}>选择音视频文件</button> : null}
        <input ref={fileInput} type="file" aria-label="音视频文件" accept={AUDIO_ACCEPT} disabled={busy} onChange={(event) => {
          const selected = event.target.files?.[0];
          setFile(null); setError(""); setText(null);
          if (!selected) return;
          try { validateAudio(selected); setFile(selected); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); event.target.value = ""; }
        }} hidden={isDesktopRuntime()} />
        <span className="form__hint">{file ? `${file.name} · ${formatBytes(file.size)}` : "支持 MP3、WAV、M4A、FLAC、OGG、MP4、MPEG、MPGA、WebM。本地文件自动提取音轨并分段，无原文件大小和时长门槛。"}</span>
      </div>
      <p className="form__hint">点击「开始转写」后，音频将上传到所选模型服务。</p>
      {busy ? <p className="audio-dialog__status" role="status"><Icon name="spinner" />{progress || "正在准备转写…"}</p> : null}
      {error ? <p className="attach-notice" role="alert">{error}</p> : null}
      {text !== null ? <label className="audio-dialog__field">
        <span className="form__label">转写结果（可编辑）</span>
        <textarea className="form__textarea audio-dialog__result" value={text} onChange={(event) => setText(event.target.value)} />
      </label> : null}
      <div className="modal__foot">
        {busy ? <button type="button" className="btn" onClick={() => {
          controller.current?.abort(); controller.current = null; setBusy(false); setError("转写已取消，可重新开始。");
        }}>取消转写</button> : <button type="button" className="btn" disabled={!file || !available} onClick={() => void start()}>开始 / 继续转写</button>}
        <button type="button" className="btn btn--primary" disabled={busy || !text?.trim()} onClick={() => {
          if (text?.trim()) onInsert(text.trim());
          close(); setText(null); setFile(null);
          if (fileInput.current) fileInput.current.value = "";
        }}>插入输入框</button>
      </div>
    </dialog>
  </>;
}
