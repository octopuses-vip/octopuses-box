/** 状态辅助层：parallel。不依赖 Store 实例，调用方显式传入上下文。 */
import { saveParallelBatch } from "../desktop/parallel";
import { type ParallelBatch } from "../types";

/* ============================ 并行任务批次落盘 ============================ */

/** 本地保留的批次数上限，与后端 `parallel.rs` 保持一致 */
export const PARALLEL_BATCH_LIMIT = 50;

/** 把单个批次写入缓存目录；未配置缓存目录时只在内存里生效 */
export function persistParallelBatch(cachePath: string | null, batch: ParallelBatch): void {
  if (!cachePath) return;
  void saveParallelBatch(cachePath, batch).catch(() => { });
}
