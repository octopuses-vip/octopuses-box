import type { ClarificationQuestion } from "../app/types";
import type { ChatTool } from "../model/client";

/** 工具名，与模型返回的 function.name 对应 */
export const ASK_USER_TOOL_NAME = "ask_user";

/** 一次最多追问三个互相独立的决策，避免用户在多轮确认里来回等待 */
const MAX_QUESTIONS = 3;
/** 每题只给 2-3 个互斥建议，客户端另行提供「其他」自由输入 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;

/** 需求确认工具：一次返回 1-3 个问题，选项包含短标签与影响说明 */
export const ASK_USER_TOOL: ChatTool = {
  type: "function",
  function: {
    name: ASK_USER_TOOL_NAME,
    description:
      "仅当完成任务所需的关键决策缺失、且无法用合理默认值继续时，一次提出 1-3 个问题。" +
      "每个问题只确认一个决策，提供 2-3 个互斥选项，把推荐项放在第一位；客户端会自动提供“其他”自由输入。" +
      "调用后本轮立即结束并等待用户统一提交答案，不要在同一轮执行其他工具，也不要在正文重复提问。",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          description: "本轮需要用户确认的 1-3 个独立问题。",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "稳定的小驼峰标识，用于关联答案，例如 outputFormat。",
              },
              header: {
                type: "string",
                description: "不超过 12 个字符的短标题，例如“输出格式”。",
              },
              question: {
                type: "string",
                description: "只询问一个决策的简短问题。",
              },
              options: {
                type: "array",
                minItems: MIN_OPTIONS,
                maxItems: MAX_OPTIONS,
                description: "2-3 个互斥建议，推荐项排第一；无需提供“其他”。",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "不超过 12 个字符的选项标签。" },
                    description: { type: "string", description: "一句话说明该选择的结果或取舍。" },
                  },
                  required: ["label", "description"],
                },
              },
            },
            required: ["id", "header", "question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

/** 需求确认系统提示（开发者 Jan）：允许时一次收齐答案；不允许时直接按合理假设推进 */
export function buildAskUserHint(allowed: boolean): string {
  if (!allowed) {
    return [
      "需求确认：本轮不再提供 ask_user 工具，请直接推进任务并给出结果；",
      "确有需要假设的地方，在开头用一句话说明假设，不要把问题抛回给用户等待答复。",
    ].join("");
  }
  return [
    "需求确认：只在完成任务的关键决策缺失、合理默认值会明显偏离用户意图时调用 ask_user；",
    "一次提交 1-3 个独立问题，每题包含短标题、单一决策问题、2-3 个互斥选项，",
    "推荐项排第一，客户端会补“其他”输入并让用户统一提交；信息足够时直接执行，不要追问无关细节。",
  ].join("");
}

export interface AskUserResult {
  ok: boolean;
  output: string;
  questions: ClarificationQuestion[];
}

/** 把任意文本收敛为可用的问题 id（开发者 Jan），并保证同一批次内不重复 */
function questionId(value: string, index: number, used: Set<string>): string {
  const fallback = `question${index + 1}`;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]/g, "") || fallback;
  let result = normalized;
  let suffix = 2;
  while (used.has(result)) {
    result = `${normalized}${suffix}`;
    suffix += 1;
  }
  used.add(result);
  return result;
}

/** 解析需求确认追问参数（开发者 Jan）；结构不完整时返回可读错误让模型自行纠正 */
export function parseAskUser(argumentsJson: string): AskUserResult {
  let payload: unknown;
  try {
    payload = JSON.parse(argumentsJson.trim() || "{}");
  } catch {
    return {
      ok: false,
      output: '工具参数不是合法 JSON，请按 { "questions": [...] } 调用。',
      questions: [],
    };
  }

  const raw = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) {
    return {
      ok: false,
      output: `questions 必须包含 1-${MAX_QUESTIONS} 个问题。`,
      questions: [],
    };
  }

  const used = new Set<string>();
  const questions: ClarificationQuestion[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index] as Record<string, unknown>;
    const header = typeof item.header === "string" ? item.header.trim().slice(0, 12) : "";
    const question = typeof item.question === "string" ? item.question.trim() : "";
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options = rawOptions
      .map((option) => option as Record<string, unknown>)
      .filter(
        (option) =>
          typeof option.label === "string" &&
          option.label.trim().length > 0 &&
          typeof option.description === "string" &&
          option.description.trim().length > 0,
      )
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        label: String(option.label).trim().slice(0, 12),
        description: String(option.description).trim(),
      }));

    if (header.length === 0 || question.length === 0) {
      return { ok: false, output: `第 ${index + 1} 个问题缺少 header 或 question。`, questions: [] };
    }
    if (options.length < MIN_OPTIONS) {
      return {
        ok: false,
        output: `第 ${index + 1} 个问题必须提供 ${MIN_OPTIONS}-${MAX_OPTIONS} 个带说明的选项。`,
        questions: [],
      };
    }
    questions.push({
      id: questionId(typeof item.id === "string" ? item.id : "", index, used),
      header,
      question,
      options,
    });
  }

  return {
    ok: true,
    output: `已向用户提出 ${questions.length} 个问题并结束本轮，等待统一提交答案后继续。`,
    questions,
  };
}
