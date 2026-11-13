/**
 * 知识库向量索引器（开发者 Jan）。
 *
 * 上传文档、会话同步和自动化计划都复用这条入口：只读取 pending chunk，按模型版本计算向量，
 * 再用 hash 写回，避免重复计算与旧内容覆盖新内容。
 */
import { knowledgeRequest } from "./api";
import { EMBEDDING_VERSION } from "./model";
import type { KnowledgeChunk, KnowledgeStats } from "./types";

const running = new Map<string, Promise<KnowledgeStats>>();

/** 补建指定缓存目录中尚未完成的向量，并返回最新索引统计。 */
export function indexPendingKnowledge(
  scope: string,
  signal?: AbortSignal,
): Promise<KnowledgeStats> {
  const existing = running.get(scope);
  if (existing) return existing;
  const task = (async () => {
    const { embedText } = await import("./embedding");
    // 单个分块失败（文本超长、模型异常）不应该中断整轮索引：
    // 记录后跳过，其余分块照常写入，失败项保留待索引等下次重试。
    const failed = new Set<string>();
    let lastError: unknown = null;
    while (!signal?.aborted) {
      const batch = await knowledgeRequest<KnowledgeChunk[]>(scope, {
        op: "pending",
        model: EMBEDDING_VERSION,
      });
      if (!batch.length) break;
      for (const chunk of batch) {
        if (signal?.aborted) break;
        if (failed.has(chunk.id)) continue;
        try {
          const vector = await embedText(chunk.text);
          if (signal?.aborted) break;
          await knowledgeRequest(scope, {
            op: "embed",
            id: chunk.id,
            hash: chunk.hash,
            model: EMBEDDING_VERSION,
            vector,
          });
        } catch (error) {
          failed.add(chunk.id);
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // 整批都失败说明再取还是同一批，直接跳出，避免死循环
      if (batch.every((chunk) => failed.has(chunk.id))) break;
    }
    if (failed.size > 0) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`有 ${failed.size} 个分块向量化失败，已跳过并保留待索引：${reason}`);
    }
    return knowledgeRequest<KnowledgeStats>(scope, {
      op: "stats",
      model: EMBEDDING_VERSION,
    });
  })();
  running.set(scope, task);
  return task.finally(() => {
    if (running.get(scope) === task) running.delete(scope);
  });
}
