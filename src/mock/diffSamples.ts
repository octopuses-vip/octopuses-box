import type { DiffFile } from "../app/types";

/**
 * 演示用的差异样本（开发者 Jan）：浏览器演示环境与空缓存时给界面兜底，保证差异卡片有内容可渲染。
 * 三份样本分别覆盖「组件重构」「设计变量调整」「打包配置调整」三种典型改动形态。
 */
export const DIFF_APP_SHELL: DiffFile = {
  path: "src/shell/AppShell.tsx",
  additions: 7,
  deletions: 3,
  lines: [
    { kind: "ctx", text: 'import { Sidebar } from "./sidebar/Sidebar";', oldNo: 12, newNo: 12 },
    { kind: "ctx", text: 'import { ConversationStream } from "../conversation/ConversationStream";', oldNo: 13, newNo: 13 },
    { kind: "del", text: 'export function AppShell() {', oldNo: 15, newNo: null },
    { kind: "del", text: "  return <div className=\"shell\" />;", oldNo: 16, newNo: null },
    { kind: "del", text: "}", oldNo: 17, newNo: null },
    { kind: "add", text: "export function AppShell() {", oldNo: null, newNo: 15 },
    { kind: "add", text: "  const rightOpen = useUiStore((s) => s.rightPanelOpen);", oldNo: null, newNo: 16 },
    { kind: "add", text: "  return (", oldNo: null, newNo: 17 },
    { kind: "add", text: "    <div className={rightOpen ? \"shell shell--right\" : \"shell\"}>", oldNo: null, newNo: 18 },
    { kind: "add", text: "      <Sidebar />", oldNo: null, newNo: 19 },
    { kind: "add", text: "      <ConversationStream />", oldNo: null, newNo: 20 },
    { kind: "add", text: "    </div>", oldNo: null, newNo: 21 },
    { kind: "add", text: "  );", oldNo: null, newNo: 22 },
    { kind: "ctx", text: "}", oldNo: 18, newNo: 23 },
  ],
};

export const DIFF_TOKENS: DiffFile = {
  path: "src/styles/tokens.css",
  additions: 4,
  deletions: 1,
  lines: [
    { kind: "ctx", text: ":root {", oldNo: 1, newNo: 1 },
    { kind: "del", text: "  --bg-0: #000000;", oldNo: 2, newNo: null },
    { kind: "add", text: "  --bg-0: #0d0d0d;", oldNo: null, newNo: 2 },
    { kind: "add", text: "  --bg-1: #171717;", oldNo: null, newNo: 3 },
    { kind: "add", text: "  --bg-hover: #242424;", oldNo: null, newNo: 4 },
    { kind: "add", text: "  --radius-lg: 16px;", oldNo: null, newNo: 5 },
    { kind: "ctx", text: "}", oldNo: 3, newNo: 6 },
  ],
};

export const DIFF_BUNDLE: DiffFile = {
  path: "src-tauri/tauri.conf.json",
  additions: 3,
  deletions: 2,
  lines: [
    { kind: "ctx", text: '    "windows": [', oldNo: 13, newNo: 13 },
    { kind: "ctx", text: "      {", oldNo: 14, newNo: 14 },
    { kind: "del", text: '        "title": "octop",', oldNo: 15, newNo: null },
    { kind: "del", text: '        "width": 800,', oldNo: 16, newNo: null },
    { kind: "add", text: '        "title": "octopuses",', oldNo: null, newNo: 15 },
    { kind: "add", text: '        "width": 1440,', oldNo: null, newNo: 16 },
    { kind: "add", text: '        "titleBarStyle": "Overlay",', oldNo: null, newNo: 17 },
    { kind: "ctx", text: "      }", oldNo: 17, newNo: 18 },
    { kind: "ctx", text: "    ]", oldNo: 18, newNo: 19 },
  ],
};

/** 一组示例差异，供差异卡片默认展示 */
export const DIFF_GROUPS: DiffFile[] = [DIFF_APP_SHELL, DIFF_TOKENS];
export const DIFF_BUNDLE_GROUP: DiffFile[] = [DIFF_BUNDLE];
