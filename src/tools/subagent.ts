/**
 * 子代理工具（开发者 Jan）：让主代理把一件独立的任务委派给一个**子会话**去跑。
 *
 * 子会话是一个全新会话，拥有自己的上下文与运行槽位；本工具在父会话里挂起等待它跑完，
 * 再把子会话最后一条助手正文作为工具结果回填。它复用的仍然是同一条运行链路
 * （`createThread` → `enqueueRequest` → `execute`），因此轮数 / 时长 / token 预算、权限闸门、
 * 工具白名单全部沿用，不存在第二条旁路。
 *
 * 三道护栏：
 *   1. 嵌套深度：链路上每个会话记着 `parentThreadId`，深度达到上限后不再挂本工具；
 *   2. 并发上限：同一父会话同时最多跑有限个子会话，避免一次委派炸出大量并行运行；
 *   3. 中断联动：父运行被停止时，正在跑的子会话一并中止。
 *
 * 子会话不挂 ask_user：委派出去的任务不应把问题抛回给一个无人值守的子会话，需要确认时
 * 应由主代理在父会话层面提问。
 */

import type { ChatTool } from "../model/client";
import type { Thread } from "../app/types";

/** 工具名，与模型返回的 function.name 对应 */
export const RUN_SUBAGENT_TOOL_NAME = "run_subagent";

/** 允许委派的最大嵌套深度：深度 < 本值的会话才挂出本工具 */
export const MAX_SUBAGENT_DEPTH = 2;
/** 同一父会话同时运行的子会话上限 */
export const MAX_SUBAGENT_CONCURRENCY = 3;

/** 回填给父会话的子代理结果上限，避免超长正文撑爆父会话上下文 */
export const SUBAGENT_OUTPUT_LIMIT = 8_000;

/** 子代理工具：参数只有「任务」与可选的「指定 Agent」 */
export const RUN_SUBAGENT_TOOL: ChatTool = {
  type: "function",
  function: {
    name: RUN_SUBAGENT_TOOL_NAME,
    description:
      "把一个可以独立完成的任务委派给子代理，在新会话里执行并返回它的最终结论。" +
      "适用于把一个较大的任务拆成互不依赖的子任务、或需要独立上下文探索的调研。子代理任务结束后只回传它的最终正文，" +
      "过程细节不会进入当前上下文；因此请把任务描述写完整、自包含，不要依赖当前会话里未说明的背景。" +
      "调用后本工具会挂起等待子代理跑完，同一时间可并行委派的数量有限。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "交给子代理独立完成的完整任务描述，需自包含：说明目标、涉及的目录或文件、期望的输出形式。",
        },
        agentId: {
          type: "string",
          description:
            "可选：指定一个已定义的 Agent id 来运行子代理（复用它的角色、模型与工具白名单）。不填则继承当前会话绑定的 Agent。",
        },
      },
      required: ["prompt"],
    },
  },
};

/** 子代理可用的系统提示；不允许委派时不注入任何内容 */
export function buildSubagentHint(allowed: boolean): string {
  if (!allowed) return "";
  return [
    "子代理：当任务可以拆成互不依赖的子任务、或需要独立上下文深入探索时，可用 run_subagent 委派；",
    `同一时间最多并行 ${MAX_SUBAGENT_CONCURRENCY} 个子代理，子代理只回传最终正文。`,
    "委派时把任务描述写完整、自包含，不要依赖当前会话里未说明的背景；能在当前会话直接完成的简单任务不要委派。",
  ].join("");
}

export interface SubagentArgs {
  ok: boolean;
  /** 参数不合法时的可读说明，直接回填给模型让它自行纠正 */
  output: string;
  prompt: string;
  /** 指定的 Agent id；未指定为 null（继承父会话绑定） */
  agentId: string | null;
}

/** 解析 run_subagent 参数（开发者 Jan）；缺 prompt 时返回可读错误让模型自行纠正 */
export function parseSubagentArgs(argumentsJson: string): SubagentArgs {
  let payload: unknown;
  try {
    payload = JSON.parse(argumentsJson.trim() || "{}");
  } catch {
    return { ok: false, output: '工具参数不是合法 JSON，请按 { "prompt": "..." } 调用。', prompt: "", agentId: null };
  }
  const record = payload as { prompt?: unknown; agentId?: unknown };
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (prompt.length === 0) {
    return { ok: false, output: "run_subagent 缺少非空 prompt（子代理的任务描述）。", prompt: "", agentId: null };
  }
  const rawAgent = typeof record.agentId === "string" ? record.agentId.trim() : "";
  return { ok: true, output: "", prompt, agentId: rawAgent.length > 0 ? rawAgent : null };
}

/**
 * 计算某个会话在派生子会话链路上的深度（开发者 Jan）。
 *
 * 根会话深度为 0，其直接子会话为 1，依此类推。链路上若出现环（异常数据）则停止上溯，
 * 避免死循环；找不到父会话（父已删除）也按到达顶端处理。
 */
export function threadDepth(threads: Thread[], threadId: string): number {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let depth = 0;
  let current = byId.get(threadId)?.parentThreadId ?? null;
  const seen = new Set<string>([threadId]);
  while (current && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = byId.get(current)?.parentThreadId ?? null;
  }
  return depth;
}

/** 截断子代理回填正文（开发者 Jan） */
export function clipSubagentOutput(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SUBAGENT_OUTPUT_LIMIT
    ? `${trimmed.slice(0, SUBAGENT_OUTPUT_LIMIT)}\n…（子代理输出过长已截断）`
    : trimmed;
}