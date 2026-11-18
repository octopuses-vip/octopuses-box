/** Keep upload validation identical for the transcription dialog and chat attachments. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Native sources carry metadata and a path, never the complete recording in JavaScript memory. */
export interface NativeAudioFile {
  kind: "nativeAudio";
  name: string;
  path: string;
  size: number;
  type: string;
  fingerprint: string;
  contentKey: string;
}
export type AudioFile = File | NativeAudioFile;

/** A native descriptor is distinct from a browser Blob and must never enter FileReader. */
export function isNativeAudioFile(file: AudioFile): file is NativeAudioFile {
  return "kind" in file && file.kind === "nativeAudio";
}
export const AUDIO_MIME: Readonly<Record<string, string>> = {
  flac: "audio/flac", mp3: "audio/mpeg", mp4: "audio/mp4", mpeg: "audio/mpeg",
  mpga: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", webm: "audio/webm",
};
export const AUDIO_ACCEPT = Object.keys(AUDIO_MIME).map((ext) => `.${ext}`).join(",");

/** Filename metadata is required by compatible services, including native file drops. */
export function audioMime(name: string): string | undefined {
  return AUDIO_MIME[name.split(".").pop()?.toLowerCase() ?? ""];
}

/** Recognize unsupported audio too, so it receives a useful format error. */
export function isAudioFile(file: Pick<File, "name" | "type">): boolean {
  return Boolean(audioMime(file.name)) || file.type.startsWith("audio/");
}

/** Validate content metadata without imposing a size limit on the local source. */
export function validateAudio(file: Pick<File, "name" | "size">): void {
  if (!audioMime(file.name)) throw new Error("不支持此音频格式，请选择 MP3、WAV、M4A、FLAC、OGG、MP4、MPEG、MPGA 或 WebM 文件。");
  if (file.size === 0) throw new Error("音频文件为空，请重新选择。");
}

/** Keep the per-request limit even though the complete local recording may be larger. */
export function validateAudioUpload(file: Pick<File, "name" | "size">): void {
  validateAudio(file);
  if (file.size > MAX_AUDIO_BYTES) throw new Error("此音频需要先自动分段，不能直接上传。");
}
