import type { ModelConnection } from "./connectionTypes";
import type { ModelFetchResult } from "./models";
import { newModelRequestId } from "./models";
import { isDesktopRuntime } from "./runtime";
import { invokeAudioRequest } from "./audio";
import type { NativeAudioFile } from "../../audio/files";
import { writeCacheFile } from "./cache";

/** Native checkpoints use atomic replacement; browser preview retains its existing cache adapter. */
export async function writeAudioCheckpoint(cachePath: string, key: string, contents: string): Promise<void> {
  if (!isDesktopRuntime()) return writeCacheFile(cachePath, `temp/audio-transcriptions/${key}.json`, contents);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("audio_checkpoint_save", { cachePath, key, contents });
}

export interface PreparedAudio { id: string; count: number }

/** Release is idempotent, including failed preparation and late cancellation at the IPC boundary. */
export async function releaseAudio(preparedId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("audio_release", { preparedId });
}

/** Only opaque session IDs cross IPC after decoding; chunk bytes stay in private native temporary files. */
export async function prepareAudio(file: NativeAudioFile, signal?: AbortSignal): Promise<PreparedAudio> {
  if (!isDesktopRuntime()) throw new Error("大音频自动分段请使用桌面客户端。");
  signal?.throwIfAborted();
  const requestId = newModelRequestId();
  try {
    const prepared = await invokeAudioRequest<PreparedAudio>("audio_prepare", { requestId, source: file }, signal);
    signal?.throwIfAborted();
    return prepared;
  } catch (error) {
    await releaseAudio(requestId).catch(() => {});
    signal?.throwIfAborted();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Upload exactly one generated WAV using the same service and authorization as the original file. */
export async function fetchAudioSegment(connection: ModelConnection, preparedId: string, index: number, signal?: AbortSignal): Promise<ModelFetchResult> {
  const result = await invokeAudioRequest<ModelFetchResult>("audio_transcribe_segment", {
    url: `${connection.url.replace(/\/+$/, "")}/audio/transcriptions`, key: connection.key,
    model: connection.modelId, preparedId, index,
  }, signal);
  return result;
}
