/**
 * 自动化运行结束后的「后续建议」：拿本轮结果做一次**非流式旁路调用**，产出 1–3 条可一键接续的
 * 任务建议。
 *
 * 建议是附加价值：任何异常（无模型连接、请求失败、输出不是合法 JSON）都静默返回，绝不因为
 * 建议生成失败而影响已完成的运行记录。
 */

import { useAppStore } from "../app/state";
import type { AutomationSuggestion, Message, StreamItem } from "../app/types";
import { requestChatCompletion, type ChatMessage } from "../model/client";
import { closeModelTraces, createModelTrace } from "../model/trace";

/** 建议调用超时（毫秒）：比评审宽松一些，但仍有上限，避免后台挂住 */
const SUGGEST_TIMEOUT_MS = 15_000;
/** 回喂给模型的运行结果上限：只取末尾一段，避免把整段输出塞进请求 */
const RESULT_CHAR_LIMIT = 4_000;

const SYSTEM_PROMPT = [
  "你是自动化任务的助手。用户给出一次定时任务的原始提示词与本次运行结果，",
  "你需要提出 1–3 条**紧接本次结果**的后续任务建议，供用户一键接着做。",
  "",
  "要求：",
  "1. 建议必须是可独立执行的任务提示词，能直接作为一次新运行的用户消息；",
  "2. 只做与本次结果直接相关的延伸（如修掉刚发现的问题、补上缺失的验证），不要泛泛而谈；",
  "3. title 不超过 12 个汉字，prompt 具体、包含必要的文件或范围信息；",
  "4. 若本次结果没有值得接续的动作，返回空数组。",
  "",
  "只输出一个 JSON 数组，不要任何解释、前后缀或代码围栏：",
  '[{"title":"简短标题","prompt":"可直接执行的任务提示词"}]',
].join("\n");

/** 从消息片段里取最后一段助手正文 */
function lastAssistantText(items: StreamItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "text" && item.text.trim().length > 0) return item.text;
  }
  return "";
}

/** 取某个会话里最后一条助手消息的正文（开发者 Jan）；子代理回填复用同一取法 */
export function lastAssistantReply(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = lastAssistantText(message.items);
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * 从模型输出里提取建议列表。
 *
 * 模型可能带代码围栏或前后解释，因此取第一个 `[` 到最后一个 `]` 之间的内容再解析；
 * 缺字段或字段为空的条目直接丢弃，最多保留 3 条。
 */
export function parseSuggestions(text: string): AutomationSuggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      title: String(item.title ?? "").trim().slice(0, 24),
      prompt: String(item.prompt ?? "").trim(),
    }))
    .filter((item) => item.title.length > 0 && item.prompt.length > 0)
    .slice(0, 3);
}

/**
 * 为一次已结束的自动化运行追加后续建议并写回运行记录。
 *
 * 调用方（调度器）在运行结束后 fire-and-forget 调用，不等待、不抛出。
 */
export async function appendRunSuggestions(threadId: string, runId: string): Promise<void> {
  const store = useAppStore.getState();
  const connection = store.modelConfig;
  if (!connection) return;

  const result = lastAssistantReply(store.messages[threadId] ?? []);
  if (result.length === 0) return;

  const run = store.automationRuns.find((item) => item.id === runId);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `任务名称：${run?.name ?? "自动化任务"}`,
        `原始提示词：${store.automations.find((item) => item.id === run?.automationId)?.prompt ?? "（已删除）"}`,
        `本次运行结果（末尾片段）：\n${result.slice(-RESULT_CHAR_LIMIT)}`,
      ].join("\n\n"),
    },
  ];

  try {
    const text = await requestChatCompletion({
      url: connection.url,
      key: connection.key,
      model: connection.modelId,
      messages,
      timeoutMs: SUGGEST_TIMEOUT_MS,
      // 建议生成发生在运行结束之后，单独归档到该会话下以运行 id 命名的文件
      trace: createModelTrace({ scope: "suggest", threadId, runId, round: null }),
    });
    const suggestions = parseSuggestions(text);
    if (suggestions.length === 0) return;
    // 运行记录可能已被清理（超出本地保留条数），此时写回会找不到目标，属于正常情况
    useAppStore.getState().updateAutomationRun(runId, { suggestions });
  } catch {
    // 建议生成失败不影响运行结果，静默处理
  } finally {
    await closeModelTraces(runId);
  }
}