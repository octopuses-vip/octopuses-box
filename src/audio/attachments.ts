import { nextId } from "../app/ids";
import type { MessageAttachment } from "../app/types";
import { saveAudioAttachment } from "../app/desktop/audioFiles";
import type { AudioFile } from "./files";

/** Adding a recording preserves its original bytes and identity; transcription is a separate action. */
export async function createAudioAttachment(file: AudioFile, cachePath?: string | null): Promise<MessageAttachment> {
  const saved = await saveAudioAttachment(file, cachePath);
  return {
    id: nextId("att"), kind: "audio", name: saved.name, mime: saved.type, size: saved.size,
    audioPath: saved.path, dataUrl: null, text: null,
  };
}
