import { useEffect } from "react";
import { useDesktopApiLifecycle } from "./api/useDesktopApiLifecycle";
import { recordDesktopCacheLocation } from "./app/desktop/cache";
import { AppRouter } from "./app/router";
import { useAppStore } from "./app/state";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { useTheme } from "./hooks/useTheme";

/** 应用根组件（开发者 Jan）：只挂全局副作用与路由出口，不放任何业务逻辑 */
function App() {
  // 主题必须在最顶层挂载：地址页、登录页、缓存目录页都渲染在 AppShell 之外，
  // 挂低了这些界面就不会跟随主题切换（开发者 Jan）。
  useTheme();
  useDesktopApiLifecycle();
  const cachePath = useAppStore((state) => state.cachePath);
  useEffect(() => {
    void recordDesktopCacheLocation(cachePath).catch(() => {
      console.warn("无法保存供独立 API 使用的缓存位置。");
    });
  }, [cachePath]);

  // 确认弹窗同理要与主题同层挂载：AppShell 之外的页面（地址页、登录页、缓存目录页）里的确认也要能弹出
  return (
    <ConfirmProvider>
      <AppRouter />
    </ConfirmProvider>
  );
}

export default App;
