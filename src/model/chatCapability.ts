import type { RemoteModel } from "../app/types";
import { transcriptionCapability } from "../audio/models";

export interface SpecializedModelSelection {
  videoModelCode: string;
  audioModelCode: string;
}

// Older catalogs omit capabilities. Match known dedicated families and task names in model IDs.
const dedicatedModelFamilies = [
  /^(?:(?:doubao-)?seedance|sora|veo|kling|wan-?\d+(?:\.\d+)?|vidu)(?:$|[-_.:])/i,
  /^(?:(?:doubao-)?seedream|gpt-image|dall-e|imagen|flux|stable-diffusion)(?:$|[-_.:])/i,
  /^(?:(?:distil-|faster-)?whisper|paraformer|sensevoice(?:small|large)?|fun-?asr|cosyvoice|bge)(?:$|[-_.:])/i,
];
const dedicatedTaskInCode = /(?:^|[-_.:])(?:embeddings?|embed|rerank(?:er)?|moderation|transcrib(?:e|er)|asr|tts|speech-to-text|text-to-speech|text-to-video|image-to-video)(?:$|[-_.:])/i;

/** Explicit chat capability takes precedence, including for models that also power a tool. */
export function supportsChat(model: RemoteModel, { videoModelCode, audioModelCode }: SpecializedModelSelection): boolean {
  if (typeof model.supportsChat === "boolean") return model.supportsChat;

  const code = model.code.trim().split("/").at(-1) ?? "";
  const transcription = transcriptionCapability(model);
  return model.code !== videoModelCode
    && !(model.code === audioModelCode && transcription === "unverified")
    && transcription !== "supported"
    && !dedicatedModelFamilies.some((family) => family.test(code))
    && !dedicatedTaskInCode.test(code);
}
