import { useAppStore } from "./state";
import { LoginPage } from "../auth/LoginPage";
import { ModelSourceSetupPage } from "../auth/ModelSourceSetupPage";
import { ServerSetupPage } from "../auth/ServerSetupPage";
import { CacheSetupPage } from "../cache/CacheSetupPage";
import { AppShell } from "../shell/AppShell";

/**
 * 顶层路由（开发者 Jan）：按「模型来源 → 配置 → 登录 → 缓存目录」的先后顺序放行。
 *
 * 第一道门禁问的是「模型从哪来」，因为它决定后面几道要不要存在：选了本地，
 * 管理端地址与登录这两步整体不存在。全新安装时 `modelSource` 为 null，
 * 用户必须先选一次；老版本升级上来由持久化迁移补成 `remote`，不会被打断。
 *
 * 之后是远程模式的两道门禁：未配置地址先停在地址页，再是未登录渲染登录页。
 * 最后「已就绪但未配置缓存路径时先配置缓存目录」对两种模式都生效——
 * 本地模式那份 `models.json` 就落在缓存目录下面，没有目录连模型都读不到。
 */
export function AppRouter() {
  const endpoint = useAppStore((state) => state.endpoint);
  const currentUser = useAppStore((state) => state.currentUser);
  const cachePath = useAppStore((state) => state.cachePath);
  const modelSource = useAppStore((state) => state.modelSource);

  if (!modelSource) return <ModelSourceSetupPage />;

  const remoteOnly = modelSource === "remote";
  if (remoteOnly && !endpoint) return <ServerSetupPage />;
  if (remoteOnly && !currentUser) return <LoginPage />;
  if (!cachePath) return <CacheSetupPage />;
  return <AppShell />;
}
