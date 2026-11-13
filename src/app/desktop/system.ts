/** 桌面适配层：system。运行环境差异在此处理，界面只调用公开函数。 */
import { isDesktopRuntime } from "./runtime";

/**
 * 打开外部链接。
 * 在 Tauri WebView 中走 opener 插件，在普通浏览器（vite dev）中退化为新标签页，
 * 保证界面层在两种运行方式下行为一致。
 */
export async function openExternal(url: string): Promise<void> {
  if (isDesktopRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * 在系统文件管理器里定位到一个本地文件（开发者 Jan）。
 *
 * 用 `revealItemInDir` 而不是 `openPath`：前者在 `opener:default` 权限内且不需要路径 scope，
 * 后者要额外授权并配置 scope，为了「看一眼配置在哪」不值得放宽权限。
 * 浏览器（vite dev）下没有对应能力，返回 false 让调用方给出替代提示。
 */
export async function revealLocalFile(path: string): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
  return true;
}

/** 选择本地目录。仅 Tauri 环境可用，否则返回 null。 */
export async function pickDirectory(title = "选择项目文件夹"): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

/** 系统文件对话框的类型过滤器（与 plugin-dialog 的 DialogFilter 同形，避免上层直接依赖插件类型） */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * 选择一个或多个本地文件，返回绝对路径列表。
 *
 * `filters` 透传给系统对话框（例如只列 STEP / IGES / DWG），让用户在挑文件这一步就没有选错的机会，
 * 而不是选完再报「不是图纸」。仅 Tauri 环境可用，否则返回空数组。
 */
export async function pickFiles(options: {
  title: string;
  filters?: FileFilter[];
}): Promise<string[]> {
  if (!isDesktopRuntime()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: true, title: options.title, filters: options.filters });
  // `multiple: true` 时插件回数组；个别平台/版本可能回单个字符串，两种都兜住
  if (Array.isArray(selected)) return selected;
  return typeof selected === "string" ? [selected] : [];
}

/**
 * 打开系统「另存为」对话框，返回用户选定的绝对路径。
 *
 * 取消选择或非桌面环境返回 `null`，调用方据此静默结束——用户主动取消不该被当成失败提示。
 */
export async function saveFileAs(options: {
  title: string;
  defaultPath: string;
  filters?: FileFilter[];
}): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const target = await save({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  return typeof target === "string" ? target : null;
}

/* ============================ 系统剪贴板 ============================ */

/**
 * 把一段文本写入系统剪贴板。
 *
 * 桌面窗口（Tauri）的 WebView 在部分系统下不满足 `navigator.clipboard` 的安全上下文要求，
 * 因此这里优先走标准接口，不可用或被拒绝时回落到「隐藏输入框 + 原生 copy 命令」的兜底方案，
 * 保证 `pnpm dev` 与桌面端行为一致。返回是否写入成功，调用方据此决定要不要给出「已复制」反馈。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 无权限或非安全上下文：继续走兜底方案
    }
  }
  return copyTextFallback(text);
}

/** 兜底复制：插入一个不可见输入框，选中后执行浏览器原生的 copy 命令 */
export function copyTextFallback(text: string): boolean {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "-1000px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(input);
  }
}
