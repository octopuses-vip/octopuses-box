import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * 点击容器外部或按 Esc 时触发回调（开发者 Jan），用于关闭下拉菜单、弹层。
 *
 * `active` 为 false 时不注册任何监听——菜单没打开就不该占用全局事件；
 * 依赖数组里带上 `onClose`，回调变化时会重新绑定，避免闭包捕获旧的 state。
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!active) return;
    // 用 mousedown 而非 click：在目标元素上按下鼠标时即判定为「外部」，避免拖拽选择文本后误判
    const handlePointerDown = (event: MouseEvent) => {
      const node = ref.current;
      if (!node) return;
      if (node.contains(event.target as Node)) return;
      onClose();
    };
/** 函数级说明（开发者 Jan）：执行 handleKey 的单一职责，并返回可供调用方继续处理的结果。 */
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [ref, active, onClose]);
}
