/** 桌面适配层：updates。运行环境差异在此处理，界面只调用公开函数。 */
import { type Endpoint, type UpdateCheckResult, type UpdateDownloadProgress } from "../types";
import { isDesktopRuntime } from "./runtime";

/**
 * 检查客户端是否有新版本。
 *
 * 该接口免登录（客户端可能在未登录状态下检测新版本），桌面端走 Rust 命令发起原生请求；
 * 浏览器演示环境没有后端可查询，直接抛错由调用方静默处理，不虚构版本信息。
 */
export async function checkForUpdate(
  endpoint: Endpoint,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  if (!isDesktopRuntime()) throw new Error("检查更新仅在桌面端可用。");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UpdateCheckResult>("client_check_update", { endpoint, currentVersion });
}

/** 监听安装包下载进度（Rust 侧边下边推，界面据此渲染进度条） */
export async function listenUpdateDownloadProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => { };
  const { listen } = await import("@tauri-apps/api/event");
  return listen<UpdateDownloadProgress>("update-download-progress", (event) =>
    handler(event.payload),
  );
}

/** 托盘「检查更新」菜单推来的事件名，与 Rust 侧 `tray.rs` 的 `EVENT_CHECK_UPDATE` 一一对应 */
export const TRAY_CHECK_UPDATE_EVENT = "tray-check-update";

/**
 * 监听托盘菜单的「检查更新」（开发者 Jan）。
 *
 * 托盘菜单点在被原生接管的系统托盘上，前端收不到点击，只能由 Rust 侧转成事件推过来。
 * 浏览器演示环境没有托盘，直接给出空订阅，调用方无需分支。
 */
export async function listenTrayCheckUpdate(handler: () => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => { };
  const { listen } = await import("@tauri-apps/api/event");
  return listen(TRAY_CHECK_UPDATE_EVENT, () => handler());
}

/**
 * 下载安装包并交由独立进程完成更新（Windows 专用）。
 *
 * 顺带带上服务端声明的安装包体积：Rust 侧据此计算进度并校验下载完整性。
 * 调用成功意味着更新进程已拉起、客户端随即退出，因此正常情况下再没有后续可做。
 */
export async function downloadAndInstallUpdate(
  downloadUrl: string,
  expectedSize: number,
): Promise<void> {
  if (!isDesktopRuntime()) throw new Error("应用内更新仅在桌面端可用。");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("update_download_and_install", { downloadUrl, expectedSize });
}

/** 上一次更新的结论：客户端退出后由更新进程写入，下次启动时读走 */
export interface UpdateOutcome {
  /** 安装是否成功 */
  installed: boolean;
  /** 安装程序退出码；授权被取消等场景可能没有 */
  exitCode: number | null;
  /** 是否改用提权身份安装过 */
  elevated: boolean;
  /** 更新日志路径，安装失败时供排查 */
  logPath: string;
  /** 可直接显示给用户的一句话结论 */
  message: string;
}

/**
 * 读取上一次更新的结论（开发者 Jan）。
 *
 * 点击「立即更新」后客户端就会退出，安装成败不可能当场反馈，只能由更新进程把结论落盘、
 * 下次启动时读回来告诉用户，否则界面只会表现成「点了更新，客户端没了」。读取即删除，
 * 同一条结论只提示一次。浏览器演示环境没有更新进程，返回空表示没有结论。
 */
export async function takeUpdateOutcome(): Promise<UpdateOutcome | null> {
  if (!isDesktopRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UpdateOutcome | null>("update_take_result");
}
