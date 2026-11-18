import type { IconName } from "../components/Icon";

/** 快捷开场将完整提示填入输入框，方便先补充背景再发送。 */
export const NEW_CHAT_SUGGESTIONS: readonly { icon: IconName; label: string; detail: string; prompt: string }[] = [
  { icon: "folder", label: "了解项目", detail: "梳理结构和主要功能", prompt: "请帮我梳理这个项目的目录结构、主要功能和运行方式。" },
  { icon: "search", label: "排查问题", detail: "根据现象和日志定位原因", prompt: "请帮我分析下面的问题，先确认原因，再给出最小修复方案。\n\n问题现象：" },
  { icon: "clipboard-check", label: "补充测试", detail: "覆盖关键路径和边界条件", prompt: "请检查当前模块的关键路径和边界条件，并补充缺失的单元测试。" },
  { icon: "book", label: "起草文档", detail: "整理步骤、说明或变更", prompt: "请根据以下内容起草一份结构清晰的使用说明。\n\n背景和要点：" },
];
