import type { Automation } from "../app/types";

/**
 * 首次使用时的示例自动化任务（开发者 Jan）。
 *
 * 只在缓存目录下还没有任务文件时写入一次，且默认停用——避免用户还没看过任务内容，
 * 就被定时触发。普通任务交给模型执行，本地向量化任务由知识库索引器执行。
 */
export const SAMPLE_AUTOMATIONS: Automation[] = [
  {
    id: "sample-daily-status",
    name: "每日项目状态整理",
    prompt:
      "请阅读当前项目目录，整理一份简短的项目状态说明：技术栈、目录职责、最近可改进的点，控制在 200 字以内。",
    projectId: "p-octopuses",
    intervalMinutes: 1440,
    cron: null,
    timezone: null,
    nextRunAt: null,
    threadId: null,
    agentId: null,
    enabled: false,
    lastRunAt: null,
  },
  {
    id: "sample-knowledge-index",
    name: "定时向量化会话记录",
    kind: "knowledge-index",
    prompt: "本地任务：扫描会话记录并补建尚未完成的向量索引。",
    projectId: "",
    intervalMinutes: 60,
    cron: null,
    timezone: null,
    nextRunAt: null,
    threadId: null,
    agentId: null,
    enabled: false,
    lastRunAt: null,
  },
  {
    id: "sample-deps-audit",
    name: "依赖安全检查",
    prompt:
      "检查 package.json 与 src-tauri/Cargo.toml 中的依赖，指出存在已知安全问题或长期未更新风险的依赖，并给出升级建议。",
    projectId: "p-octopuses",
    intervalMinutes: 10080,
    cron: null,
    timezone: null,
    nextRunAt: null,
    threadId: null,
    agentId: null,
    enabled: false,
    lastRunAt: null,
  },
];

/** 默认的本地向量化计划，升级已有任务文件时单独补入（开发者 Jan）。 */
export const DEFAULT_KNOWLEDGE_INDEX_AUTOMATION = SAMPLE_AUTOMATIONS.find(
  (task) => task.id === "sample-knowledge-index",
) as Automation;
