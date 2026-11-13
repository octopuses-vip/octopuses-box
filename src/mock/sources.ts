import type { SourceItem } from "../app/types";

/**
 * 浏览器演示环境的内置「来源」列表（开发者 Jan）。
 *
 * 桌面端（或接上后端检索时）来源由真实检索结果写入会话；这份常量只在没有后端、
 * 直接 `pnpm dev` 打开界面时兜底，保证右栏「来源」页有内容可看。
 */
export const WEB_SOURCES: SourceItem[] = [
  {
    title: "Tauri v2 — Worktree 与本地任务",
    url: "https://tauri.app/develop/guides/",
    snippet:
      "在本地项目中并行处理多个任务线程时，可使用 git worktree 为每个会话创建独立检出目录，配合内置自动化与 Git 功能隔离改动。",
  },
  {
    title: "Tauri v2 — Configuration reference",
    url: "https://tauri.app/reference/config/",
    snippet:
      "titleBarStyle: Overlay renders the window controls on top of the webview content, allowing a fully custom title bar.",
  },
];
