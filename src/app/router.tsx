import { useAppStore } from "./state";
import { CacheSetupPage } from "../cache/CacheSetupPage";
import { AppShell } from "../shell/AppShell";

/**
 * 顶层路由（开发者 Jan）：只保留一道门禁——未配置缓存路径时先配置缓存目录。
 *
 * 模型列表固定来自缓存目录下的 `models.json`，不再连接管理端，
 * 因此没有「选择模型来源」「配置管理端地址」与「登录」这几步。
 */
export function AppRouter() {
  const cachePath = useAppStore((state) => state.cachePath);

  if (!cachePath) return <CacheSetupPage />;
  return <AppShell />;
}
