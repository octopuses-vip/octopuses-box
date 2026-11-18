import type { ModelConnection } from "./connectionTypes";
import { isDesktopRuntime } from "./runtime";
import { abortModelStream, newModelRequestId, type ModelFetchResult } from "./models";
import { audioMime, validateAudioUpload } from "../../audio/files";

/** Replay early cancellation after Rust acknowledges registration; all audio commands share this contract. */
export async function invokeAudioRequest<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  signal?.throwIfAborted();
  const requestId = args.requestId as string || newModelRequestId();
  /** Keep the native request registry in sync with the caller's abort signal. */
  const abort = () => { void abortModelStream(requestId).catch(() => {}); };
  const onReady = new Channel<null>(() => { if (signal?.aborted) abort(); });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await invoke<T>(command, { ...args, requestId, onReady });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** Browser preview supports bounded direct uploads; desktop processing uses native file sources. */
export async function fetchAudioTranscription(
  connection: ModelConnection,
  file: File,
  signal?: AbortSignal,
): Promise<ModelFetchResult> {
  validateAudioUpload(file);
  signal?.throwIfAborted();
  const url = `${connection.url.replace(/\/+$/, "")}/audio/transcriptions`;
  const mime = audioMime(file.name)!;
  if (!isDesktopRuntime()) {
    const form = new FormData();
    form.append("model", connection.modelId);
    form.append("response_format", "json");
    form.append("file", new Blob([file], { type: mime }), file.name);
    const response = await fetch(url, {
      method: "POST",
      headers: connection.key ? { Authorization: `Bearer ${connection.key}` } : {},
      body: form,
      signal,
    });
    return { status: response.status, body: await response.text(), aborted: false };
  }
  throw new Error("桌面端音视频请使用本地文件处理链路。");
}
