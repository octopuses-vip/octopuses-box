/**
 * 非 macOS 平台的自绘窗口控制按钮组（开发者 Jan）：最小化 / 最大化 / 关闭。
 *
 * macOS 上窗口保留系统标题栏（红绿灯 + `titleBarStyle: Overlay`），因此这里不渲染任何内容；
 * Windows / Linux 的窗口配置为 `decorations: false`（无原生标题栏），由本组件补齐控制按钮。
 *
 * 按钮不参与标题栏拖拽：标题栏上的 `data-tauri-drag-region` 只作用于自身节点，子元素默认不继承，
 * 因此在按钮上无需额外处理即可正常接收点击。
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isDesktopRuntime } from "../app/desktop/runtime";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";

/** 执行一次原生窗口动作（开发者 Jan）；浏览器演示环境没有窗口可控制，直接忽略 */
async function runWindowAction(action: (window: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (!isDesktopRuntime()) return;
  try {
    await action(getCurrentWindow());
  } catch {
    // 窗口正在关闭等边界情况：控制动作失败不影响界面，静默忽略
  }
}

/**
 * 自绘窗口控制按钮组（开发者 Jan）：非 macOS 才渲染，按钮点击转成原生窗口动作。
 */
export function WindowControls() {
  const platform = useAppStore((state) => state.platform);
  // macOS 用系统红绿灯，不自绘
  if (platform === "macos") return null;

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__btn"
        aria-label="最小化"
        onClick={() => void runWindowAction((window) => window.minimize())}
      >
        <Icon name="minimize" size={14} />
      </button>
      <button
        type="button"
        className="window-controls__btn"
        aria-label="最大化"
        onClick={() => void runWindowAction((window) => window.toggleMaximize())}
      >
        <Icon name="maximize" size={12} />
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--close"
        aria-label="关闭"
        onClick={() => void runWindowAction((window) => window.close())}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}