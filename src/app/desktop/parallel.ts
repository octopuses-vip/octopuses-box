/** 桌面适配层：parallel。运行环境差异在此处理，界面只调用公开函数。 */
import { type ParallelBatch } from "../types";
import { readCacheFile, writeCacheFile } from "./cache";
import { isDesktopRuntime } from "./runtime";

/* ============================ 并行任务批次 ============================ */

/**
 * 多项目并行任务的批次档案，落盘在缓存目录 `parallel/batches.json`。
 *
 * 批次只是「把同一条提示词分发给哪些项目、各自跑成什么样」的记录：真正的并行执行由前端的
 * 按会话运行队列完成（见 `src/hooks/useAgentRun.ts`），因此这里没有本地进程依赖，浏览器演示
 * 环境同样可读写（走内存缓存），与桌面端行为一致。
 */
export const PARALLEL_FILE = "parallel/batches.json";

/** 本地保留的批次数上限，与后端 `parallel.rs` 的 BATCH_LIMIT 保持一致 */
export const PARALLEL_BATCH_LIMIT = 50;

/** 解析批次档案；文件缺失或损坏时按空列表处理 */
export function parseParallelBatches(body: string | null): ParallelBatch[] {
  if (!body) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ParallelBatch =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as ParallelBatch).id === "string" &&
        typeof (item as ParallelBatch).prompt === "string" &&
        Array.isArray((item as ParallelBatch).items),
    );
  } catch {
    return [];
  }
}

/**
 * 读取并行任务批次（开发者 Jan）。
 *
 * 桌面端走 Rust 命令；浏览器演示环境没有落盘能力，退回读缓存文件并自行解析。
 * 读盘或解析失败一律返回空列表——这是列表页的首次加载，宁可显示空态也不要抛错打断页面。
 */
export async function listParallelBatches(cachePath: string | null): Promise<ParallelBatch[]> {
  if (!cachePath) return [];
  if (!isDesktopRuntime()) {
    return parseParallelBatches(await readCacheFile(cachePath, PARALLEL_FILE));
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ParallelBatch[]>("parallel_list_batches", { cacheDir: cachePath });
}

/**
 * 保存一个并行任务批次（开发者 Jan），返回保存后的完整列表。
 *
 * 按 id 覆盖式 upsert（同 id 只留最新一份），再按创建时间倒序截断到
 * PARALLEL_BATCH_LIMIT——批次只是「一批待发任务」的临时台账，留最近若干条即可，
 * 不设上限会让缓存目录无限膨胀。
 */
export async function saveParallelBatch(
  cachePath: string | null,
  batch: ParallelBatch,
): Promise<ParallelBatch[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法保存并行任务。");
  if (!isDesktopRuntime()) {
    const batches = await listParallelBatches(cachePath);
    const next = [batch, ...batches.filter((item) => item.id !== batch.id)]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, PARALLEL_BATCH_LIMIT);
    await writeCacheFile(cachePath, PARALLEL_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ParallelBatch[]>("parallel_save_batch", { cacheDir: cachePath, batch });
}

/** 删除一个并行任务批次（开发者 Jan）：id 不存在时报错，避免「以为删掉了其实没删」 */
export async function deleteParallelBatch(
  cachePath: string | null,
  batchId: string,
): Promise<ParallelBatch[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法删除并行任务。");
  if (!isDesktopRuntime()) {
    const batches = await listParallelBatches(cachePath);
    const next = batches.filter((item) => item.id !== batchId);
    if (next.length === batches.length) throw new Error(`并行任务批次不存在：${batchId}`);
    await writeCacheFile(cachePath, PARALLEL_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ParallelBatch[]>("parallel_delete_batch", { cacheDir: cachePath, batchId });
}
