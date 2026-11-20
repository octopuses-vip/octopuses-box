import type { ModelConnection } from "../app/desktop/connectionTypes";
import { fetchAudioTranscription } from "../app/desktop/audio";
import { prepareAudio, fetchAudioSegment, releaseAudio } from "../app/desktop/audioSegments";
import type { RemoteModel } from "../app/types";
import { connectionFromModel } from "../app/storeSelectors";
import { isNativeAudioFile, type AudioFile, type NativeAudioFile, validateAudio } from "./files";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { nativeAudioSource } from "../app/desktop/audioFiles";
import { checkpointKey, readCheckpoint, saveCheckpoint, withCheckpointLock, type TranscriptionOptions } from "./checkpoints";
import { selectTranscriptionModel, transcriptionCapability } from "./models";

/** Allow an explicit capable model, or the only known speech model when auto is selected. */
export function transcriptionConnection(models: RemoteModel[], code: string): ModelConnection {
  const selected = selectTranscriptionModel(models, code);
  if (!selected) {
    const configured = code ? models.find((model) => model.code === code) : undefined;
    if (configured && transcriptionCapability(configured) === "unsupported") {
      throw new Error(`${configured.name || configured.code} 不支持文件转写，请在「设置 → 模型与连接」选择支持 /audio/transcriptions 的语音识别模型。`);
    }
    throw new Error("请先在「设置 → 模型与连接 → 音频转文字模型」选择可用的语音识别模型。");
  }
  return connectionFromModel(selected, false);
}

/** Convert service failures into actionable messages without treating malformed responses as transcripts. */
export function parseTranscription(status: number, body: string, allowSilence = false): string {
  if (status < 200 || status >= 300) {
    const hint = status === 401 || status === 403 ? "请检查模型授权和访问密钥。"
      : status === 404 || status === 405 ? "服务未开通音频转写接口，请检查模型和服务地址。"
      : status === 413 ? "服务拒绝了文件大小，请压缩或分段后重试。"
      : status === 429 ? "请求过多或额度不足，请稍后重试或检查服务额度。"
      : "请检查语音识别模型配置或稍后重试。";
    throw new Error(`音频转写失败（HTTP ${status}）。${hint}`);
  }
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new Error("音频接口返回了无效 JSON，请检查服务是否支持音频转写。"); }
  if (!payload || typeof payload !== "object" || !("text" in payload) || typeof payload.text !== "string") {
    throw new Error("音频接口未返回转写文字，请检查所选模型是否支持语音识别。");
  }
  const text = payload.text.trim();
  if (!text && !allowSilence) throw new Error("未识别到文字，请检查录音是否包含清晰的人声。");
  return text;
}

/** A single transcription attempt is cancellable and never silently retried or submitted to chat. */
export async function transcribeAudio(file: AudioFile, connection: ModelConnection, signal?: AbortSignal, onProgress?: (status: string) => void, options: TranscriptionOptions = {}): Promise<string> {
  validateAudio(file);
  signal?.throwIfAborted();
  if (isDesktopRuntime()) {
    onProgress?.("正在准备本地音视频文件…");
    const source = await nativeAudioSource(file, signal);
    try {
      const key = await checkpointKey(source.file, connection, options.scope);
      return await withCheckpointLock(`${options.cachePath ?? ""}/${key}`, signal,
        () => transcribeLocalAudio(source.file, connection, key, signal, onProgress, options));
    } finally { await source.release(); }
  }
  if (isNativeAudioFile(file)) throw new Error("本地音视频文件请使用桌面客户端。");
  onProgress?.("正在上传并转写音频…");
  let result;
  try {
    result = await fetchAudioTranscription(connection, file, signal);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new Error("无法连接音频转写服务，请检查网络与模型服务地址。");
  }
  signal?.throwIfAborted();
  if (result.aborted) throw new DOMException("音频转写已取消", "AbortError");
  return parseTranscription(result.status, result.body);
}

/** Native processing streams files from disk and reuses completed segment text across attempts. */
async function transcribeLocalAudio(file: NativeAudioFile, connection: ModelConnection, key: string, signal: AbortSignal | undefined, onProgress: ((status: string) => void) | undefined, options: TranscriptionOptions): Promise<string> {
  const checkpoint = await readCheckpoint(key, options.cachePath);
  signal?.throwIfAborted();
  if (checkpoint && checkpoint.texts.every((text) => text !== null)) {
    onProgress?.("已恢复完整转写结果。");
    return completedText(checkpoint.texts as string[]);
  }
  onProgress?.("正在读取音轨并自动分段…");
  const prepared = await prepareAudio(file, signal);
  const texts = checkpoint?.count === prepared.count ? checkpoint.texts : Array<string | null>(prepared.count).fill(null);
  try {
    // Verify persistence before making paid calls; every completed result is saved before advancing.
    await saveCheckpoint(key, { count: prepared.count, texts }, options.cachePath);
    const restored = texts.filter((text) => text !== null).length;
    if (restored) onProgress?.(`已恢复 ${restored}/${prepared.count} 段，继续转写…`);
    for (let index = 0; index < prepared.count; index++) {
      signal?.throwIfAborted();
      if (texts[index] !== null) continue;
      onProgress?.(`正在转写第 ${index + 1}/${prepared.count} 段…`);
      try {
        const result = await fetchAudioSegment(connection, prepared.id, index, signal);
        if (result.aborted) throw new DOMException("音频转写已取消", "AbortError");
        texts[index] = parseTranscription(result.status, result.body, true);
        await saveCheckpoint(key, { count: prepared.count, texts }, options.cachePath);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        const detail = (error instanceof Error ? error.message : String(error)).replace(/[。\s]+$/, "");
        throw new Error(`第 ${index + 1}/${prepared.count} 段转写失败：${detail}。再次转写可继续已保存的进度。`);
      }
    }
    return completedText(texts as string[]);
  } finally { await releaseAudio(prepared.id); }
}

/** Never label an entirely silent recording as a successful transcript. */
function completedText(texts: string[]): string {
  const text = texts.filter((part) => part.trim()).join("\n\n");
  if (!text) throw new Error("未识别到文字，请检查录音是否包含清晰的人声。");
  return text;
}
