/** 桌面适配层：shell。运行环境差异在此处理，界面只调用公开函数。 */
import { type ShellResult } from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ 集成终端 ============================ */

/**
 * 模型触发命令的内核沙箱参数：工作区根目录 + 前端策略开关。
 *
 * Rust 侧保持无状态，是否启用、是否放行网络都由这里传入；`dir` 为 null 时后端按未启用处理，
 * 退回没有内核隔离的原行为。
 */
export interface ShellSandbox {
  /** 工作区根目录，内核沙箱只允许写入它以及工具链白名单目录 */
  dir: string | null;
  /** 是否启用 macOS 内核级写隔离（默认开启） */
  enabled: boolean;
  /** 是否允许命令访问网络（默认放行） */
  allowNetwork: boolean;
}

/**
 * 在指定目录下执行一条 shell 命令（未传目录或目录不存在时由后端回落到用户主目录）。
 *
 * 桌面端走 Rust 的 `run_shell`（独立线程执行，长命令不会卡住界面）；浏览器演示环境无法执行
 * 本地命令，直接抛出可读错误，由界面提示改用桌面端。
 *
 * 传入 `sandbox` 时叠加 macOS Seatbelt 内核级写隔离；不传即集成终端的原行为（用户直接控制面）。
 */
export async function runShell(
  command: string,
  cwd: string | null,
  sandbox?: ShellSandbox | null,
): Promise<ShellResult> {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器演示环境无法执行本地命令，请在桌面端（pnpm tauri dev）使用集成终端。");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ShellResult>("run_shell", {
    command,
    cwd,
    sandboxDir: sandbox?.dir ?? null,
    sandboxEnabled: sandbox?.enabled ?? null,
    allowNetwork: sandbox?.allowNetwork ?? null,
  });
}
