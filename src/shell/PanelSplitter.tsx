import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { useAppStore } from "../app/state";

/**
 * 拖动分隔条时的吸附关闭阈值（px）（开发者 Jan）。
 *
 * 松手时右栏宽度小于它即视为「被拖没了」：直接收起右栏，而不是留一条看不见的窄缝。
 * 集中在这里定义，避免同一个阈值散落在拖动与收尾两处。
 */
export const SPLITTER_SNAP_CLOSE_PX = 96;

/** 把数值约束到 [min, max]（开发者 Jan） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 读取 shell 内某个子元素当前的像素宽度，取不到时按 0 处理 */
function measureWidth(shell: HTMLElement, selector: string): number {
  return shell.querySelector(selector)?.getBoundingClientRect().width ?? 0;
}

/**
 * 读取中间栏最小可用宽度（开发者 Jan）。
 *
 * 值写在 tokens.css 的 `--main-min-width` 里而不是这里：它是布局约束，和侧栏、分隔条宽度
 * 属于同一组常量，放在同一处才好一起调。读不到时回落到 0（等于不做限制），
 * 保证变量被误删时只是恢复到旧行为，而不是让分隔条彻底拖不动。
 */
function readMainMinWidth(shell: HTMLElement): number {
  const raw = getComputedStyle(shell).getPropertyValue("--main-min-width");
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

/** 一次拖动期间不变的上下文：窗口右边缘与可拖范围，pointermove 里只做减法 */
interface DragContext {
  shell: HTMLElement;
  /** 窗口右边缘的 x 坐标，右栏宽度 = 它减去指针 x */
  edgeX: number;
  /**
   * 右栏能占的最大宽度：扣掉左侧栏、分隔条与中间栏的最小可用宽度。
   *
   * 最后那一项是必要的：只扣前两者的话中间栏可以被压到 0，输入框会跟着被压成一条缝。
   */
  maxWidth: number;
}

interface PanelSplitterProps {
  /** 拖动开始 / 结束回调：外层据此关闭列宽过渡，保证拖动跟手 */
  onResizingChange: (resizing: boolean) => void;
}

/**
 * 中间栏与右栏之间的分隔条（开发者 Jan）。
 *
 * 它是三栏栅格的第 4 个子元素：右栏收起时所在列宽为 0，因此既不占位也命中不到。
 * 两种交互：
 *   1. 拖动 —— 实时改 `--col-right` 行内变量，松手才写回 store，
 *      避免每次 pointermove 都触发一次 React 重渲染；
 *   2. 双击 —— 还原成默认宽度（写回 `null`）。
 * 上界按「窗口右边缘到指针」与「扣掉侧栏、分隔条、中间栏最小可用宽度后的剩余宽度」实时计算：
 * 右栏可以被拖到 0（吸附收起），但中间栏不会被压到 0——否则输入区会先一步变成一条缝。
 * （右栏「最大化」不是拖出来的，那个模式走 `--col-main: 0`，与这里的边界无关。）
 */
export function PanelSplitter({ onResizingChange }: PanelSplitterProps) {
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const rightPanelMaximized = useAppStore((state) => state.rightPanelMaximized);
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const setRightPanelWidth = useAppStore((state) => state.setRightPanelWidth);
  const setRightPanelMaximized = useAppStore((state) => state.setRightPanelMaximized);

  /** 当前拖动上下文；为 null 表示没有在拖动 */
  const drag = useRef<DragContext | null>(null);

/** 函数级说明（开发者 Jan）：执行 handlePointerDown 的单一职责，并返回可供调用方继续处理的结果。 */
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rightPanelOpen || event.button !== 0) return;
    const splitter = event.currentTarget;
    const shell = splitter.parentElement;
    if (!shell) return;
    const shellRect = shell.getBoundingClientRect();

    // 在最大化状态下开始拖动：先把「当前实宽」固化成手动宽度、再退出最大化，
    // 两步在同一帧内落地，右栏不会先弹回默认宽度再被拖动
    if (rightPanelMaximized) {
      setRightPanelWidth(measureWidth(shell, ".shell__right"));
      setRightPanelMaximized(false);
    }

    drag.current = {
      shell,
      edgeX: shellRect.right,
      maxWidth: Math.max(
        shellRect.width -
          measureWidth(shell, ".shell__sidebar") -
          splitter.getBoundingClientRect().width -
          readMainMinWidth(shell),
        0,
      ),
    };
    splitter.setPointerCapture(event.pointerId);
    onResizingChange(true);
  };

/** 函数级说明（开发者 Jan）：执行 handlePointerMove 的单一职责，并返回可供调用方继续处理的结果。 */
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const context = drag.current;
    if (!context) return;
    const width = clamp(context.edgeX - event.clientX, 0, context.maxWidth);
    context.shell.style.setProperty("--col-right", `${width}px`);
  };

  /**
   * 结束拖动并把结果落库（开发者 Jan）。
   *
   * `pointerup` 与 `pointercancel` 都走这里：两者都必须把行内变量与 store 对齐，
   * 否则会出现「界面停在拖动宽度、store 还是旧值」的错位。
   * 宽度低于吸附阈值时改判为「收起右栏」，此时代码要清掉行内变量——面板收起后
   * `--right-open` 不再提供 `--col-right`，残留的行内值会撑出一条空白列。
   */
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const context = drag.current;
    if (!context) return;
    drag.current = null;
    const splitter = event.currentTarget;
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    onResizingChange(false);

    const width = clamp(context.edgeX - event.clientX, 0, context.maxWidth);
    if (width < SPLITTER_SNAP_CLOSE_PX) {
      context.shell.style.removeProperty("--col-right");
      setRightPanelWidth(null);
      setRightPanelOpen(false);
      return;
    }
    setRightPanelWidth(width);
  };

  /** 双击分隔条还原默认宽度：写回 null，让宽度重新由 tokens.css 决定 */
  const handleDoubleClick = () => {
    if (!rightPanelOpen) return;
    setRightPanelMaximized(false);
    setRightPanelWidth(null);
  };

  return (
    <div
      className="shell__splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整右侧面板宽度，双击还原默认宽度"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={handleDoubleClick}
    />
  );
}
