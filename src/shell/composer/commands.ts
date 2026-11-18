/** 斜杠菜单项（开发者 Jan）：内置命令，或一条技能（技能项选中后插入调用标记而非立即执行） */
export interface SlashItem {
  id: string;
  name: string;
  description: string;
  kind: "command" | "skill";
}

/**
 * 内置斜杠命令表（开发者 Jan）。
 *
 * 只列客户端自己实现的动作；技能由调用方另行拼接后一起交给菜单渲染，
 * 因此这里不包含任何依赖后端的功能项。
 */
export const SLASH_COMMANDS: SlashItem[] = [
  { id: "plan", name: "/plan", description: "先调查并制定计划", kind: "command" },
  { id: "goal", name: "/goal", description: "设置持续目标和验收条件", kind: "command" },
  { id: "memories", name: "/memories", description: "管理长期记忆", kind: "command" },
  { id: "worktree", name: "/worktree", description: "管理独立工作目录与交接", kind: "command" },
  { id: "review", name: "/review", description: "查看 PR、审查和 CI", kind: "command" },
  { id: "browser", name: "/browser", description: "网页预览与已授权浏览器标签页", kind: "command" },
  { id: "model", name: "/model", description: "切换当前会话使用的模型", kind: "command" },
  { id: "video", name: "/video", description: "生成短片，可附一张首帧图片", kind: "command" },
  { id: "diff", name: "/diff", description: "在右侧面板打开 Git Diff", kind: "command" },
  { id: "sources", name: "/sources", description: "在右侧面板打开来源", kind: "command" },
  { id: "terminal", name: "/terminal", description: "显示或隐藏集成终端", kind: "command" },
  { id: "new", name: "/new", description: "开始一个新的对话", kind: "command" },
  { id: "settings", name: "/settings", description: "打开设置", kind: "command" },
];
