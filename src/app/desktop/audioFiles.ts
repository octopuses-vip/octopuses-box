import { type AudioFile, type NativeAudioFile, isNativeAudioFile, validateAudio } from "../../audio/files";
import { isDesktopRuntime } from "./runtime";
import { newModelRequestId } from "./models";

/** Native pickers and drops read metadata only, preserving the user's file on disk. */
export async function inspectAudioFile(path: string, base?: string | null): Promise<NativeAudioFile> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeAudioFile>("audio_inspect", { path, base: base ?? null });
}

export interface NativeAudioSource {
  file: NativeAudioFile;
  release: () => Promise<void>;
}

/** Keep an unchanged local copy with the conversation, without decoding or contacting a model. */
export async function saveAudioAttachment(file: AudioFile, cachePath?: string | null): Promise<NativeAudioFile> {
  if (!isDesktopRuntime()) throw new Error("附加音视频原文件请使用桌面客户端。");
  if (!cachePath) throw new Error("请先配置缓存目录以保存音视频附件。");
  const source = await nativeAudioSource(file);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<NativeAudioFile>("audio_attachment_import", { cachePath, source: source.file });
  } finally { await source.release(); }
}

/** Clipboard/browser Blobs are staged one MiB at a time; file-path sources require no copy. */
export async function nativeAudioSource(file: AudioFile, signal?: AbortSignal): Promise<NativeAudioSource> {
  validateAudio(file);
  signal?.throwIfAborted();
  if (isNativeAudioFile(file)) {
    const fresh = await inspectAudioFile(file.path);
    signal?.throwIfAborted();
    return { file: fresh, release: async () => {} };
  }
  if (!isDesktopRuntime()) throw new Error("音视频文件处理请使用桌面客户端。");
  const { invoke } = await import("@tauri-apps/api/core");
  const id = newModelRequestId();
  /** Drop the private original on completion, cancellation or failed import. */
  const release = async () => { await invoke("audio_stage_release", { id }); };
  try {
    await invoke("audio_stage_create", { id, name: file.name, size: file.size });
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
      const blocks: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x8000) blocks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      signal?.throwIfAborted();
      await invoke("audio_stage_append", { id, offset, encoded: btoa(blocks.join("")) });
    }
    signal?.throwIfAborted();
    const source = await invoke<NativeAudioFile>("audio_stage_finish", { id });
    signal?.throwIfAborted();
    return { file: source, release };
  } catch (error) {
    await release().catch(() => {});
    signal?.throwIfAborted();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
