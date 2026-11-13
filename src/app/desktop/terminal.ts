/** 桌面适配层：terminal。运行环境差异在此处理，界面只调用公开函数。 */
import { type PtySessionInfo, type PtyEvent } from "../types";
import { isDesktopRuntime } from "./runtime";

/** PTY 终端的前置检查（开发者 Jan）：终端要在本机开真实登录 shell，浏览器环境不做任何模拟 */
export function requireDesktopPty(): void {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器环境不提供本地 PTY；终端是桌面端的用户控制面，不会模拟执行命令。");
  }
}

/**
 * 创建一个持久 PTY 会话（开发者 Jan），返回会话 id 与初始尺寸。
 *
 * `cwd` 传 null 时由后端回落到用户主目录；集成终端打开时按会话有效工作区传值，
 * 因此终端的工作目录始终跟随当前会话。
 */
export async function createPtySession(
  cwd: string | null,
  cols = 120,
  rows = 32,
): Promise<PtySessionInfo> {
  requireDesktopPty();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PtySessionInfo>("pty_create", { cwd, cols, rows });
}

/** 向 PTY 会话写入用户输入（开发者 Jan）：键盘输入原样转发，不在前端做行编辑 */
export async function writePtySession(sessionId: string, data: string): Promise<void> {
  requireDesktopPty();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("pty_write", { sessionId, data });
}

/**
 * 调整 PTY 尺寸（开发者 Jan）。
 *
 * 必须同步给后端：shell 与全屏程序（如 vim、top）按列宽决定换行与布局，
 * 不同步会出现输出错位。
 */
export async function resizePtySession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  requireDesktopPty();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("pty_resize", { sessionId, cols, rows });
}

/** 关闭 PTY 会话（开发者 Jan）：连带结束其子进程；非桌面端是空操作，便于组件统一卸载 */
export async function closePtySession(sessionId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("pty_close", { sessionId });
}

/** 列出当前存活的 PTY 会话（开发者 Jan）：用于界面重挂载后接回已有终端 */
export async function listPtySessions(): Promise<PtySessionInfo[]> {
  if (!isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PtySessionInfo[]>("pty_list");
}

/**
 * 订阅 PTY 的输出事件（开发者 Jan），返回取消订阅函数。
 *
 * 输出走事件而不是请求-响应：终端输出是持续不断的推流，用事件才能实时刷新，
 * 返回的取消函数供组件卸载时调用，避免会话关闭后仍往已卸载组件里写数据。
 */
export async function listenPtyEvents(
  handler: (event: PtyEvent) => void,
): Promise<() => void> {
  requireDesktopPty();
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PtyEvent>("pty-event", (event) => handler(event.payload));
}
