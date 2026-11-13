import { expandReviewedSource, reviewExportSource, type ReviewConnection } from "./exportReview";
import type { KnowledgeSource } from "./types";

/** 将文档转换成独立问答；会话可选择评审、扩展，所有结果只用于本次导出。 */
export async function prepareTrainingSource(source: KnowledgeSource, options: {
  questionConnection?: ReviewConnection;
  reviewConnection?: ReviewConnection;
  expand: boolean;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<{ sources: KnowledgeSource[]; reason: string; kept: boolean }> {
  const { signal, onProgress } = options;
  signal.throwIfAborted();
  let material = source;
  let reason = "保留原始会话";
  if (options.reviewConnection) {
    const reviewed = await reviewExportSource(source, options.reviewConnection, signal,
      (done, total) => onProgress(`正在评审：${source.title} · ${done}/${total}`));
    if (!reviewed.source) return { sources: [], reason: reviewed.reason, kept: false };
    material = reviewed.source;
    reason = reviewed.reason;
  }
  if (source.kind === "document") {
    if (!options.questionConnection?.url) throw new Error("请选择已配置服务地址的提问模型");
    const generated = await expandReviewedSource(material, options.questionConnection, signal,
      (done, total) => onProgress(`正在生成文档问答：${source.title} · ${done}/${total}`));
    return { sources: generated, kept: generated.length > 0, reason: `生成 ${generated.length} 条文档问答${options.reviewConnection ? `；${reason}` : ""}` };
  }
  const sources = [material];
  if (options.expand && options.reviewConnection) {
    onProgress(`正在扩展：${source.title}`);
    const generated = await expandReviewedSource(material, options.reviewConnection, signal);
    sources.push(...generated);
    reason += `；生成 ${generated.length} 条补充问答`;
  }
  return { sources, reason, kept: true };
}
