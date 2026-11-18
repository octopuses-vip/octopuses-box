/** 桌面适配层：automation。运行环境差异在此处理，界面只调用公开函数。 */
import { isDesktopRuntime } from "./runtime";

export interface AutomationDueEvent {
  automationId: string;
  dueAt: number;
}

/**
 * 把当前启用中的自动化任务同步给 Rust 侧调度器（开发者 Jan）。
 *
 * 前端只负责算「有哪些任务、各自什么节奏」，实际计时交给后端：
 * 界面刷新或路由切换都不该影响任务是否按时触发。
 */
export async function syncAutomationScheduler(tasks: import("../types").Automation[]): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("automation_sync_tasks", { tasks });
}

/**
 * 释放某个任务的「本次已触发」占用（开发者 Jan）。
 *
 * 后端会去重以免同一时刻重复唤起；一次运行结束后必须显式释放，
 * 否则该任务在下一轮到点前不会再被触发。
 */
export async function releaseScheduledAutomation(automationId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("automation_release", { automationId });
}

/** 订阅「任务到点」事件（开发者 Jan），返回取消订阅函数；浏览器环境返回空函数以统一调用方写法 */
export async function listenAutomationDue(
  handler: (event: AutomationDueEvent) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => { };
  const { listen } = await import("@tauri-apps/api/event");
  return listen<AutomationDueEvent>("automation-due", (event) => handler(event.payload));
}

/* ============================ 后台定时项（LaunchAgent） ============================ */

/**
 * 一个要注册为系统后台定时项的任务规格，与 Rust `AgentSpec` 对应。
 *
 * 应用完全退出后进程内定时器不再运行，只有注册成 LaunchAgent 才能由系统到点唤起本应用。
 * 规格由 `src/automations/cron.ts` 从任务的 cron / 间隔推导，复杂表达式不可表达时不注册。
 */
export interface AgentSpec {
  id: string;
  /** 固定间隔（秒）；与 `calendar` 二选一 */
  intervalSeconds?: number;
  /** 日历式触发；与 `intervalSeconds` 二选一 */
  calendar?: { minute?: number; hour?: number; weekday?: number; day?: number };
}

/** 一个已注册的后台定时项 */
export interface AgentInfo {
  taskId: string;
  label: string;
  path: string;
}

/** 注册（或按当前路径重装）一批后台定时项；重复调用幂等 */
export async function installAutomationAgents(specs: AgentSpec[]): Promise<AgentInfo[]> {
  if (!isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentInfo[]>("launch_agent_install", { specs });
}

/** 卸载一个后台定时项 */
export async function uninstallAutomationAgent(taskId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("launch_agent_uninstall", { taskId });
}

/** 列出当前已注册的后台定时项 */
export async function listAutomationAgents(): Promise<AgentInfo[]> {
  if (!isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentInfo[]>("launch_agent_status");
}

/** 只保留 activeIds 里的定时项，其余卸载；传空数组即「移除全部后台定时项」，返回被移除的任务 id */
export async function pruneAutomationAgents(activeIds: string[]): Promise<string[]> {
  if (!isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("launch_agent_prune", { activeIds });
}

/** 取回启动参数指定的待执行任务（只取一次）；无则为 null */
export async function takeAutomationWake(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("automation_take_wake");
}

/** 退出应用：被定时项唤起并执行完成后调用，避免留下多余窗口 */
export async function exitApp(): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("automation_exit");
}
