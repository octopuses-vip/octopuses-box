import { Icon } from "../components/Icon";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../app/state";
import { transcribeAudio, transcriptionConnection } from "./transcription";
import { messagePlainText } from "../conversation/transcript";

/** MediaRecorder segments are complete containers; never upload arbitrary slices of one WebM. */
export function recordingType(): { mime: string; extension: string } {
  for (const [mime, extension] of [["audio/webm;codecs=opus", "webm"], ["audio/mp4", "m4a"], ["audio/webm", "webm"]]) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, extension };
  }
  throw new Error("当前系统没有可用的录音编码器");
}

/** Capture independent microphone segments with cancellable transcription and optional speech feedback. */
export function VoiceInput({ onText, onTurn }: { onText: (text: string) => void; onTurn: (text: string) => void }) {
  const thread = useAppStore((s) => s.activeThreadId); const scope = useAppStore((s) => s.cachePath);
  const messages = useAppStore((s) => s.messages[thread]); const running = useAppStore((s) => s.threadRunStates[thread]?.status === "running");
  const [open, setOpen] = useState(false); const [listening, setListening] = useState(false);
  const [continuous, setContinuous] = useState(false); const [conversation, setConversation] = useState(false);
  const [text, setText] = useState(""); const [status, setStatus] = useState(""); const [error, setError] = useState("");
  const stream = useRef<MediaStream | null>(null); const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const live = useRef(false); const controller = useRef<AbortController | null>(null);
  const generation = useRef(0); const processing = useRef<Promise<void>>(Promise.resolve()); const queued = useRef(0);
  const conversationRef = useRef(conversation); conversationRef.current = conversation;
  const turnRef = useRef(onTurn); turnRef.current = onTurn;
  const segmentVoice = useRef(0);
  const spoken = useRef(""); const context = useRef<AudioContext | null>(null); const animation = useRef(0);
  const stop = () => {
    live.current = false; if (timer.current) clearTimeout(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
    cancelAnimationFrame(animation.current); void context.current?.close(); context.current = null; setListening(false);
  };
  const close = () => { generation.current++; stop(); controller.current?.abort(); window.speechSynthesis?.cancel(); setOpen(false); setStatus(""); };
  useEffect(() => { setOpen(false); setListening(false); return () => { generation.current++; live.current = false; if (timer.current) clearTimeout(timer.current); recorder.current?.state === "recording" && recorder.current.stop(); stream.current?.getTracks().forEach((t) => t.stop()); controller.current?.abort(); cancelAnimationFrame(animation.current); void context.current?.close(); window.speechSynthesis?.cancel(); }; }, [thread, scope]);
  useEffect(() => {
    if (!open || !conversation || running) return;
    const last = messages?.slice().reverse().find((m) => m.role === "assistant");
    if (!last || spoken.current === last.id) return; spoken.current = last.id;
    const reply = messagePlainText(last).trim();
    if (reply && "speechSynthesis" in window) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(reply.slice(0, 6000)); utterance.lang = "zh-CN"; window.speechSynthesis.speak(utterance); }
  }, [conversation, messages, open, running]);
  const start = async () => {
    setError(""); setStatus("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("当前系统未提供麦克风录音，请检查系统权限或使用文件转写"); return; }
    try {
      const configState = useAppStore.getState(); const connection = transcriptionConnection(configState.remoteModels, configState.audioModelCode);
      const format = recordingType(); const run = ++generation.current; queued.current = 0; controller.current = new AbortController();
      const audio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation.current !== run) { audio.getTracks().forEach((t) => t.stop()); return; }
      stream.current = audio; live.current = true; setListening(true);
      spoken.current = messages?.slice().reverse().find((m) => m.role === "assistant")?.id ?? "";
      // Voice activity interrupts system speech; echo cancellation reduces feedback from speakers.
      if ((conversation || continuous) && typeof AudioContext !== "undefined") {
        const ctx = new AudioContext(); context.current = ctx; const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
        ctx.createMediaStreamSource(audio).connect(analyser); const data = new Uint8Array(256); let loudFrames = 0;
        const measure = () => { if (!live.current) return; analyser.getByteTimeDomainData(data); const energy = Math.sqrt(data.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / data.length); if (energy > 0.018) segmentVoice.current++; loudFrames = energy > 0.1 ? loudFrames + 1 : 0; if (loudFrames >= 8) window.speechSynthesis?.cancel(); animation.current = requestAnimationFrame(measure); }; measure();
      }
      const segment = () => {
        if (!live.current || generation.current !== run) return;
        segmentVoice.current = 0; const chunks: Blob[] = []; const rec = new MediaRecorder(audio, { mimeType: format.mime }); recorder.current = rec;
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onerror = () => { setError("录音设备发生错误"); stop(); };
        rec.onstop = () => {
          if (generation.current !== run) return;
          const file = new File(chunks, `microphone-${Date.now()}.${format.extension}`, { type: format.mime });
          if (file.size > 0 && (!(continuous || conversation) || segmentVoice.current >= 3)) {
            queued.current++;
            if (queued.current > 3) { stop(); setError("识别速度低于录音速度，已暂停录音并保留待识别段落。完成后可继续。"); }
            processing.current = processing.current.catch(() => {}).then(async () => {
              if (generation.current !== run) return; setStatus("正在识别录音…");
              try { const words = await transcribeAudio(file, connection, controller.current!.signal, undefined, { cachePath: scope, scope: "local" }); if (generation.current !== run || !words.trim()) return; setText((v) => [v, words].filter(Boolean).join("\n")); if (conversationRef.current) { window.speechSynthesis?.cancel(); turnRef.current(words); } }
              catch (e) { if (generation.current === run && !controller.current?.signal.aborted) setError(String(e)); }
              finally { if (generation.current === run) { queued.current--; setStatus(queued.current ? "继续识别录音…" : ""); } }
            });
          }
          if (live.current && (continuous || conversation)) segment();
          else stop();
        };
        rec.start(); timer.current = setTimeout(() => { if (rec.state === "recording") rec.stop(); }, continuous || conversation ? 8000 : 60000);
      }; segment();
    } catch (e) { setError(String(e)); stop(); }
  };
  return <>
    <button type="button" className="icon-btn voice-trigger" aria-label="麦克风听写与语音对话" title="麦克风听写与语音对话" onClick={() => setOpen(true)}><Icon name="mic" size={15} /></button>
    {open && <div className="overlay overlay--center" onMouseDown={close}><section className="modal modal--wide" role="dialog" aria-modal="true" aria-label="麦克风与语音" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal__head"><span className="modal__title">麦克风与语音</span><button className="btn btn--ghost btn--sm" onClick={close}>关闭</button></div>
      <div className="modal__body task-panel__body"><label><input type="checkbox" checked={continuous} disabled={listening} onChange={(e) => setContinuous(e.target.checked)} />连续听写（每 8 秒识别一段）</label><label><input type="checkbox" checked={conversation} disabled={listening} onChange={(e) => setConversation(e.target.checked)} />语音对话：识别后发送，使用系统语音朗读回答</label><p>使用设置中选择的语音模型。连续识别有分段延迟，录音期间可停止；说话或点击“停止朗读”可打断播放。</p><textarea className="form__input" aria-label="识别文字" value={text} onChange={(e) => setText(e.target.value)} rows={6} /><p role="status">{listening ? "正在录音… " : ""}{status}</p>{error && <p role="alert">{error}</p>}</div>
      <div className="modal__foot"><button className="btn btn--sm" disabled={!listening && Boolean(status)} onClick={() => listening ? stop() : void start()}>{listening ? "停止录音" : "开始录音"}</button><button className="btn btn--ghost btn--sm" onClick={() => window.speechSynthesis?.cancel()}>停止朗读</button><button className="btn btn--primary" disabled={!text.trim() || listening || Boolean(status)} onClick={() => { onText(text); setText(""); close(); }}>插入输入框</button></div>
    </section></div>}
  </>;
}
