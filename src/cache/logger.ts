import { appendCacheFile } from "../app/desktop/cache";
import { useAppStore } from "../app/state";

/**
 * 追加一条运行日志到缓存路径的 `logs/app.log`（开发者 Jan）。
 *
 * 未配置缓存路径时静默跳过，运行日志写入失败也不上抛——日志属于旁路能力，
 * 不应因为它出错而打断界面；因此这里统一 `catch` 掉 Promise 的拒绝。
 */
export function logCacheEvent(event: string, detail?: string): void {
  const cachePath = useAppStore.getState().cachePath;
  if (!cachePath) return;
  const line = `[${new Date().toISOString()}] ${event}${detail ? ` ${detail}` : ""}\n`;
  void appendCacheFile(cachePath, "logs/app.log", line).catch(() => {});
}
