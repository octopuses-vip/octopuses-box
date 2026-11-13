/**
 * 内置工具清单（开发者 Jan）。
 *
 * 桌面客户端没有集中式工具注册表：工具表在 `useAgentRun` 里按挂载条件（有没有项目目录、
 * 模型是否支持视觉、是不是 macOS）临时拼装，Agent 声明的工具白名单还会再收窄一次。
 * 这里把「客户端所有可能挂出的内置工具名」静态列出来，供两处收口使用：
 *
 * 1. 把本轮真正挂出的工具名写进 system——模型不必凭训练记忆猜自己有什么工具；
 * 2. 校验技能正文里写的工具名——写错名字或本轮调不动时当场告知，而不是等模型撞上一次
 *    失败调用后自己下结论「我这边没有检索工具」，再改用委派子代理绕路。
 *
 * 新增内置工具时要把名字加进 `CLIENT_TOOL_NAMES`，否则技能里提到它会被误判为不存在。
 */

import type { ChatTool } from "../model/client";
import { READ_SKILL_TOOL, READ_SKILL_TOOL_NAME } from "../skills/tool";
import { ASK_USER_TOOL, ASK_USER_TOOL_NAME } from "./askUser";
import { CONTROL_TOOLS, CONTROL_TOOL_NAMES } from "./control";
import { CV_TOOLS } from "./cv";
import { IMAGE_GEN_TOOL, IMAGE_GEN_TOOL_NAME } from "./imageGen";
import { KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_SEARCH_TOOL_NAME } from "./knowledge";
import { READ_URL_TOOL, READ_URL_TOOL_NAME } from "./readUrl";
import { SSH_TOOLS } from "./ssh";
import { RUN_SUBAGENT_TOOL, RUN_SUBAGENT_TOOL_NAME } from "./subagent";
import { VISION_TOOLS } from "./vision";
import { WEB_SEARCH_TOOL } from "./webSearch";
import { WORKSPACE_TOOLS } from "./workspace";
import { WRITE_FILE_TOOL, WRITE_FILE_TOOL_NAME } from "./writeFile";

/** 内置工具名全集：与挂载条件无关，用于判断「客户端到底有没有这个工具」 */
export const CLIENT_TOOL_NAMES: string[] = [
  WRITE_FILE_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL.function.name,
  READ_URL_TOOL_NAME,
  ...CONTROL_TOOL_NAMES,
  ...VISION_TOOLS.map((tool) => tool.function.name),
  ...CV_TOOLS.map((tool) => tool.function.name),
  ...WORKSPACE_TOOLS.map((tool) => tool.function.name),
  ...SSH_TOOLS.map((tool) => tool.function.name),
  ASK_USER_TOOL_NAME,
  READ_SKILL_TOOL_NAME,
  RUN_SUBAGENT_TOOL_NAME,
];

/** 取 ChatTool 数组里的工具名 */
function toolNamesOf(tools: { function: { name: string } }[]): string[] {
  return tools.map((tool) => tool.function.name);
}

/**
 * 「本轮实际可用工具」清单（开发者 Jan）：把真正挂进工具表的名字逐个写进 system。
 *
 * 各类别提示只讲「这类工具怎么用」，没有任何一处告诉模型本轮到底有哪些工具。挂载条件与
 * Agent 白名单都会把工具摘掉，模型看不到清单就只能凭其他客户端的习惯去猜工具名——猜不中
 * 就回一句「我这边没有这个工具」，再委派一个工具表完全相同的子代理去绕路，白跑一轮。
 */
export function buildMountedToolsHint(tools: { function: { name: string } }[]): string {
  const names = toolNamesOf(tools);
  if (names.length === 0) return "";
  const lines = [
    `本轮你实际可调用的工具只有以下 ${names.length} 个：${names.join("、")}。`,
    "清单外的工具名一律调不动：不要凭其他客户端的习惯臆造工具名，本客户端的工具名以本清单为准；",
    "需要某个能力时先在清单里找对应的工具，找不到就说明本轮没有该能力。",
  ];
  if (names.includes(RUN_SUBAGENT_TOOL_NAME)) {
    lines.push(
      "也不要因为缺某类工具就改用 run_subagent 委派：子会话继承同样的挂载条件与工具白名单，" +
        "工具表不会比你更宽，委派出去同样调不动。",
    );
  }
  return lines.join("\n");
}

/**
 * 一组内置工具的展示条目（开发者 Jan）：供「工具」页渲染。
 *
 * `condition` 用一句话讲清这组工具什么时候挂给模型，与 `useAgentExecutor` 的挂载逻辑对齐；
 * 挂载逻辑变化时这里要同步改，避免页面说法与实际行为脱节。
 */
export interface BuiltinToolGroup {
  title: string;
  /** 挂载条件：恒定挂载写「始终可用」，其余写条件本身 */
  condition: string;
  tools: ChatTool[];
}

/**
 * 内置工具分组清单（开发者 Jan）：「工具」页按组渲染，含每个工具的名称与描述。
 *
 * 描述直接取自工具定义里的 `function.description`——它与模型看到的是同一份文本，
 * 页面上看什么、模型就知道什么，避免两处说明各写各的。
 */
export const BUILTIN_TOOL_GROUPS: BuiltinToolGroup[] = [
  {
    title: "文件与工程",
    condition: "write_file 始终可用；工程工具需在会话中选中本地项目目录后挂载",
    tools: [WRITE_FILE_TOOL, ...WORKSPACE_TOOLS],
  },
  {
    title: "联网检索",
    condition: "始终可用",
    tools: [WEB_SEARCH_TOOL, READ_URL_TOOL],
  },
  {
    title: "图像生成",
    condition: "始终可用（网关没有图像渠道时由工具返回可读的不可用提示）",
    tools: [IMAGE_GEN_TOOL],
  },
  {
    title: "浏览器与桌面自动化",
    condition:
      "browser_cdp / open_in_browser 三平台可用；browser_script / computer_script / screenshot / computer_click 仅 macOS",
    tools: [...CONTROL_TOOLS],
  },
  {
    title: "视觉理解",
    condition: "当前模型支持图像输入时挂载",
    tools: [...VISION_TOOLS],
  },
  {
    title: "本地 CV",
    condition: "始终可用（使用本机算力，与模型能力无关）",
    tools: [...CV_TOOLS],
  },
  {
    title: "知识库检索",
    condition: "桌面运行且已配置缓存目录时挂载",
    tools: [KNOWLEDGE_SEARCH_TOOL],
  },
  {
    title: "远程主机（SSH）",
    condition: "存在已启用的远程主机时挂载，并按项目绑定收窄",
    tools: [...SSH_TOOLS],
  },
  {
    title: "会话辅助",
    condition:
      "ask_user 仅首轮且会话尚无产物时挂载（子代理会话不挂）；read_skill 需启用技能；run_subagent 嵌套深度未达上限时挂载",
    tools: [ASK_USER_TOOL, READ_SKILL_TOOL, RUN_SUBAGENT_TOOL],
  },
];
