import type { RemoteModel } from "../app/types";

/** Honor explicit provider declarations, with compatibility for known model IDs. */
export function transcriptionCapability(model: RemoteModel): "supported" | "unsupported" | "unverified" {
  if (typeof model.supportsAudioTranscription === "boolean") {
    return model.supportsAudioTranscription ? "supported" : "unsupported";
  }
  const code = model.code.trim().toLowerCase().split("/").at(-1) ?? "";
  if (/^(gpt-transcribe|gpt-4o(?:-mini)?-transcribe|whisper)(?:$|-)/.test(code)) return "supported";
  if (/^(gpt-\d+(?:\.\d+)*[a-z]?|o[1-9])(?:$|-)/.test(code)) return "unsupported";
  return "unverified";
}
