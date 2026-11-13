import { useCallback, useEffect, useRef, useState } from "react";

/** 距底部多少像素以内仍算「贴底」（开发者 Jan）：留一点余量，避免亚像素误差导致跟随中断 */
const PIN_THRESHOLD_PX = 48;

/** 判定「用户想让视图往上走」的按键（开发者 Jan）：焦点在消息块里时用键盘翻页同样要立刻断开跟随 */
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * 让容器在内容增长时保持贴底（开发者 Jan）；一旦用户主动向上滚动就停止自动跟随，直到重新滚回底部。
 *
 * `dependency` 通常是「消息条数 / 最后一条内容」，变化即触发一次贴底滚动。
 * 返回 `ref` 绑到滚动容器、`onScroll` 绑到 `onScroll`、`pinned` 用于渲染「回到最新」按钮、
 * `scrollToBottom` 供用户点该按钮时手动贴底。
 *
 * 两个坑都会导致「大模型回答时怎么滚都会被拽回去」，实现时特意绕开：
 *
 * 1. **贴底状态必须同步落到 ref，不能只在渲染时回写**。流式回答期间内容每几十毫秒长高一截，
 *    ResizeObserver 回调也就跟着这么密；用户上滑时 `setPinned(false)` 只是排进 React 更新队列，
 *    提交时机晚于观察者回调，回调于是读到过期的「贴底」又把视图拽回底部，
 *    而这次程序性滚动产生的 scroll 事件因「距底为 0」再把状态判回贴底——
 *    用户的上滑被抹掉，且每一步都在复现，表现为「拉不动」。
 *    因此 ref 是 DOM 侧（scroll / ResizeObserver）的唯一判定依据，state 只用来渲染按钮。
 *
 * 2. **用户意图要在输入事件里就拿下，不等 scroll 事件**。滚轮与按键是同步派发的，
 *    而 scroll 事件由浏览器在自己的渲染流程里补发，可能排在一次内容长高之后；
 *    在滚轮回调里直接断开跟随，这段竞争窗口就不存在了。
 */
export function useAutoScroll<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  /** DOM 侧唯一判定依据（开发者 Jan）：同步写入，不受 React 提交时机影响 */
  const pinnedRef = useRef(true);

  /** 同步更新贴底状态：ref 立刻生效，state 负责按钮重渲染 */
  const syncPinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  /** 滚动时重算是否贴底（开发者 Jan）：用「剩余可滚动距离」判断，比比较 scrollTop 更稳 */
  const onScroll = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    syncPinned(distance < PIN_THRESHOLD_PX);
  }, [syncPinned]);

  /** 立即滚到底部并恢复跟随（开发者 Jan）：供「回到底部」按钮调用 */
  const scrollToBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    syncPinned(true);
  }, [syncPinned]);

  // 内容变化且仍处于贴底状态时才跟随；用户已上滑时不打扰其阅读位置
  useEffect(() => {
    if (!pinnedRef.current) return;
    const node = ref.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [dependency]);

  /*
   * 用户主动上滑即刻断开跟随（开发者 Jan）：滚轮与按键同步到达，先于浏览器补发的 scroll 事件，
   * 在这里写 ref，紧接着的内容长高才不会把视图抢回底部。
   * 内容不足一屏（没有可滚动余量）时不判定——否则会出现「根本没得滚，却弹出回到最新按钮」。
   */
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
/** 函数级说明（开发者 Jan）：执行 detach 的单一职责，并返回可供调用方继续处理的结果。 */
    const detach = () => {
      if (node.scrollHeight - node.clientHeight <= PIN_THRESHOLD_PX) return;
      syncPinned(false);
    };
/** 函数级说明（开发者 Jan）：执行 onWheel 的单一职责，并返回可供调用方继续处理的结果。 */
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) detach();
    };
/** 函数级说明（开发者 Jan）：执行 onKeyDown 的单一职责，并返回可供调用方继续处理的结果。 */
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_UP_KEYS.has(event.key)) detach();
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("keydown", onKeyDown);
    };
  }, [dependency, syncPinned]);

  /*
   * 尺寸兜底（开发者 Jan）：composer 高度变化（输入框自适应、IME 组合提交）、
   * 窗口缩放、悬浮按钮出现/消失等都会改变容器 clientHeight 或内容 scrollHeight，
   * 浏览器随即钳制 scrollTop，把贴底的视图拽离底部——而上面的 effect 因
   * dependency 未变不会重跑，跳走的位置永远回不来。
   * ResizeObserver 同时盯容器与内容：任一尺寸变化且仍处于贴底状态，就立刻重新贴底。
   * 判定读 ref（同步值）而不是 state，回调早于 React 提交时才不会拿到过期的「贴底」。
   */
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    const inner = node.firstElementChild;
    if (inner) observer.observe(inner);
    return () => observer.disconnect();
  }, [dependency]);

  const pauseFollowing = useCallback(() => syncPinned(false), [syncPinned]);
  return { ref, onScroll, pinned, scrollToBottom, pauseFollowing };
}
