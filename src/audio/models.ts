import type { RemoteModel } from "../app/types";

/** Honor explicit provider declarations, with compatibility for known model IDs. */
export function transcriptionCapability(model: RemoteModel): "supported" | "unsupported" | "unverified" {
  if (typeof model.supportsAudioTranscription === "boolean") {
    return model.supportsAudioTranscription ? "supported" : "unsupported";
  }
  const code = model.code.trim().toLowerCase().split("/").at(-1) ?? "";
  if (/^(gpt-transcribe|gpt-4o(?:-mini)?-transcribe|whisper)(?:$|-)/.test(code)) return "supported";
  if (/^qwen3[-_]asr(?:$|[-_.:])/.test(code)) return "supported";
  if (/^(gpt-\d+(?:\.\d+)*[a-z]?|o[1-9])(?:$|-)/.test(code)) return "unsupported";
  return "unverified";
}

/** Every entry point must use the same explicit choice or unique known transcription model. */
export function selectTranscriptionModel(models: RemoteModel[], code: string): RemoteModel | null {
  if (code) {
    const selected = models.find((model) => model.code === code);
    return selected && transcriptionCapability(selected) !== "unsupported" ? selected : null;
  }
  const known = models.filter((model) => transcriptionCapability(model) === "supported");
  return known.length === 1 ? known[0] : null;
}
