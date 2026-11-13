/**
 * 会话上下文自动压缩（开发者 Jan）。
 *
 * 长会话的上下文会一路涨到超出模型的窗口，请求直接被网关拒绝。这里的做法是「滚动摘要」：
 * 每次发起请求前估算整段上下文，超过阈值就把最旧的若干条消息折叠进一段摘要——摘要随会话
 * 持久化（`Thread.contextSummary` / `contextCoveredCount`），后续请求只带摘要 + 最近的消息。
 *
 * 本文件只提供三块纯能力，触发时机与写回都由调用方（`useAgentRun`）决定：
 * 1. token 估算：CJK 感知的启发式，不精确但足以稳定判断「超没超」；
 * 2. 折叠规划：给定每条消息的估算值与保留预算，算出应折叠的最旧消息条数；
 * 3. 摘要生成：走一次非流式模型调用，把旧摘要 + 被折叠的内容合并成新摘要。
 */

import {
  requestChatCompletion,
  type ChatMessage,
} from "../model/client";

/** CJK 字符（含中日韩汉字、假名、谚文、全角标点与西里尔）：一个字符约一个 token */
const CJK_PATTERN =
  /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF\u0400-\u04FF]/;

/** 一条消息的角色 / 分隔等结构开销（ChatML 风格包装的粗略估计） */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** 一张图片的粗略估算：主流多模态模型对单张图计费在几百到一千出头 token */
const IMAGE_TOKEN_ESTIMATE = 1_000;

/**
 * 估算一段文本的 token 数（启发式）。
 *
 * 不用精确分词器：那需要打进几百 KB 的词表，而这里只需要判断「上下文超没超过阈值」，
 * 误差百分之十几完全可接受。CJK 字符按 1 token/字，其余按 4 字符/token——与主流 BPE
 * 对中英文的压缩比大致对齐。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 估算单条对话消息的 token（含正文、图片与工具调用参数） */
export function estimateChatMessageTokens(message: ChatMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  if (typeof message.content === "string") {
    total += estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      total += part.type === "text" ? estimateTextTokens(part.text) : IMAGE_TOKEN_ESTIMATE;
    }
  }
  for (const call of message.tool_calls ?? []) {
    total +=
      MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(call.function.name) +
      estimateTextTokens(call.function.arguments);
  }
  return total;
}

/** 估算一组对话消息的总 token */
export function estimateChatMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateChatMessageTokens(message);
  return total;
}

/**
 * 规划要折叠的最旧消息条数（开发者 Jan）。
 *
 * 入参对齐关系：会话里未覆盖的 N 条消息经 `buildHistory` 展开成若干条 `ChatMessage`
 * （一条助手消息可能拆出多条 tool 配对），`boundaries[k]` 是「前 k 条消息」展开后的
 * `ChatMessage` 条数，`perChatMessageTokens` 与整个 history（含末尾本轮提问）逐条对齐。
 *
 * 从折叠 1 条开始逐步扩大，找到第一个使「保留部分（含本轮提问）估算 ≤ 预算」的条数；
 * 全部试完仍超预算时折叠 N-1 条——**至少保留最近一条消息**，否则会话彻底失忆。
 * 返回 0 表示无需折叠。
 */
export function planFoldCount(
  boundaries: number[],
  perChatMessageTokens: number[],
  keepBudgetTokens: number,
): number {
  const messageCount = boundaries.length - 1;
  if (messageCount <= 1) return 0;

  // 后缀和：suffix[i] = 从第 i 条 ChatMessage 到 history 末尾（含本轮提问）的估算总量
  const suffix: number[] = new Array(perChatMessageTokens.length + 1).fill(0);
  for (let i = perChatMessageTokens.length - 1; i >= 0; i -= 1) {
    suffix[i] = suffix[i + 1] + perChatMessageTokens[i];
  }

  for (let fold = 1; fold <= messageCount - 1; fold += 1) {
    if (suffix[boundaries[fold]] <= keepBudgetTokens) return fold;
  }
  return messageCount - 1;
}

/**
 * 按协议配对划分对话「单元」（开发者 Jan）。
 *
 * assistant(tool_calls) 与其后连续的 tool 结果是同一单元（OpenAI 协议要求 tool 消息
 * 必须紧跟其调用者，拆开会被网关直接拒绝），其余消息各自成单元。返回每个单元的起始
 * 下标（升序）。system 头也是普通单元，由调用方决定是否跳过。
 */
function splitConversationUnits(messages: ChatMessage[]): number[] {
  const unitStart: number[] = [];
  let cursor = 0;
  while (cursor < messages.length) {
    unitStart.push(cursor);
    if (messages[cursor].role === "assistant" && (messages[cursor].tool_calls?.length ?? 0) > 0) {
      cursor += 1;
      while (cursor < messages.length && messages[cursor].role === "tool") cursor += 1;
    } else {
      cursor += 1;
    }
  }
  return unitStart;
}

/**
 * 规划一次就地精简：算出「从哪里丢弃到哪里」，但不改数组（开发者 Jan）。
 *
 * 返回 `dropFrom`（保留头之后第一个被丢的下标，system 头永不丢弃所以至少为 1）
 * 与 `dropUntil`（第一个保留单元的起始下标）；没有可精简的空间时返回 null。
 * 调用方先用 `[dropFrom, dropUntil)` 区间生成摘要，再执行 [`pruneConversationForEmergency`]。
 */
export function planConversationPrune(
  messages: ChatMessage[],
  keepBudgetTokens: number,
): { dropFrom: number; dropUntil: number } | null {
  if (messages.length === 0) return null;
  const tokens = messages.map(estimateChatMessageTokens);
  const unitStart = splitConversationUnits(messages);

  // system 头永不丢弃：它通常是第一个单元，折叠起点至少从其后开始
  const firstFoldableUnit = messages[0].role === "system" ? 1 : 0;
  if (firstFoldableUnit >= unitStart.length) return null;

  // suffixPerUnit[u] = 第 u 个单元到末尾的总 token
  const unitTokens: number[] = unitStart.map((start, index) => {
    const end = index + 1 < unitStart.length ? unitStart[index + 1] : messages.length;
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += tokens[i];
    return sum;
  });
  const suffixPerUnit: number[] = new Array(unitStart.length + 1).fill(0);
  for (let u = unitStart.length - 1; u >= 0; u -= 1) suffixPerUnit[u] = suffixPerUnit[u + 1] + unitTokens[u];

  // 从最少的折叠开始找第一个满足预算的单元；全不满足时保底只留最后一个单元
  let foldUnit = -1;
  for (let u = firstFoldableUnit; u < unitStart.length; u += 1) {
    if (suffixPerUnit[u] <= keepBudgetTokens) {
      foldUnit = u;
      break;
    }
  }
  if (foldUnit < 0) foldUnit = unitStart.length - 1;
  if (foldUnit <= firstFoldableUnit) return null;

  return { dropFrom: unitStart[firstFoldableUnit], dropUntil: unitStart[foldUnit] };
}

/**
 * 就地精简对话（开发者 Jan）。
 *
 * 与滚动摘要不同：这发生在**运行中途**——`conversation` 里已经积累了本轮的 assistant
 * 工具调用与 tool 结果，它们还没落库，从 `history` 重建会把它们全部丢掉。因此只能原地
 * 按单元从头部丢弃（单元划分见 [`splitConversationUnits`]）。system 消息永不丢弃。
 *
 * 被丢弃的区域用一条占位 user 消息说明，保留「这里曾有上下文」的语义；调用方若在丢弃前
 * 生成了摘要（`summaryText`），摘要正文会并进占位消息，模型仍能读到先前脉络。
 * 返回丢弃的消息条数；0 表示没有可精简的空间（已经只剩保底内容）。
 */
export function pruneConversationForEmergency(
  messages: ChatMessage[],
  keepBudgetTokens: number,
  summaryText = "",
): number {
  const plan = planConversationPrune(messages, keepBudgetTokens);
  if (!plan) return 0;
  const { dropFrom, dropUntil } = plan;
  const dropped = dropUntil - dropFrom;
  if (dropped <= 0) return 0;
  const reason = summaryText.trim().length > 0 ? "上下文逼近模型窗口，较早的对话已折叠为以下摘要" : "因超出模型上下文窗口，更早的消息已被省略";
  const markerLines = [`（${reason}，共 ${dropped} 条消息。）`];
  if (summaryText.trim().length > 0) markerLines.push("", summaryText.trim());
  const marker: ChatMessage = { role: "user", content: markerLines.join("\n") };
  const head = dropFrom > 0 ? [messages[0]] : [];
  messages.splice(dropFrom > 0 ? 1 : 0, dropUntil - (dropFrom > 0 ? 1 : 0), ...head, marker);
  return dropped;
}

/**
 * 工具输出进入对话前的源头截断（对齐 Codex 的 tool_output_token_limit 思路，开发者 Jan）。
 *
 * 读大文件、大 diff 的工具结果一次性灌进上下文是撑爆窗口的主因，事后压缩远比源头截断
 * 昂贵。单条输出超过 [`TOOL_OUTPUT_TOKEN_LIMIT`] 时保留首尾（前 3/4、后 1/4，保证
 * 报错尾部与文件开头的 import 区都看得见），中间以省略标注替代，并提示模型如何取回
 * 完整内容。超限判定按字符（混合文本按 3 字符/token 取偏大值控制截断粒度），
 * 省略量用 [`estimateTextTokens`] 精确估算。
 */
export const TOOL_OUTPUT_TOKEN_LIMIT = 8000;

/** 截断后保留的头部比例：多数工具输出的关键信息（路径、开头、报错尾部）分布在这里 */
const TOOL_OUTPUT_HEAD_RATIO = 0.75;
/** token 的粗略字符换算：中文 1 字/token、其余 4 字符/token，混合文本取偏大值控制截断粒度 */
const CHARS_PER_TOKEN = 3;

export function truncateToolOutput(content: string): string {
  const maxChars = TOOL_OUTPUT_TOKEN_LIMIT * CHARS_PER_TOKEN;
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * TOOL_OUTPUT_HEAD_RATIO);
  const tailChars = maxChars - headChars;
  const omitted = content.slice(headChars, content.length - tailChars);
  return [
    content.slice(0, headChars),
    "",
    `[……中间省略约 ${estimateTextTokens(omitted)} token（${omitted.length} 字符）。输出过长已截断以保护上下文窗口；如需完整内容，请用更小范围的方式重新获取（例如分段读取文件或缩小查询条件）。]`,
    "",
    content.slice(content.length - tailChars),
  ].join("\n");
}

/** 摘要请求的系统提示：明确保留什么、丢什么、什么格式 */
const SUMMARY_SYSTEM = [
  "你是会话上下文压缩助手。请把「已有摘要」与「本次待压缩的会话内容」合并成一段新的摘要。",
  "要求：",
  "- 必须保留：用户的目标与意图、用户明确提出的约束、关键决策及其原因、涉及的文件路径 / 函数名 / 命令、已完成的事项与尚未完成的事项；",
  "- 丢弃：寒暄、重复的工具输出、与结论无关的过程细节；",
  "- 用中文条目化输出，总字数不超过 500 字；",
  "- 只输出摘要正文，不要任何解释或开场语。",
].join("\n");

/** 摘要请求的超时：非流式、输入可达数万 token，给足但不无限 */
const SUMMARY_TIMEOUT_MS = 90_000;
/** 序列化时工具结果的截断长度：结果往往是上下文大头，摘要只需要它「做了什么」的线索 */
const TOOL_RESULT_MAX_CHARS = 2_000;
/** 序列化时普通正文的截断长度 */
const TEXT_MAX_CHARS = 4_000;

/** 超长文本截断，保留头部并标注 */
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断）`;
}

/** 把被折叠的 ChatMessage 序列化成摘要模型可读的纯文本 */
function serializeForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const result = typeof message.content === "string" ? message.content : "";
      if (result.trim().length > 0) lines.push(`【工具结果】${truncate(result, TOOL_RESULT_MAX_CHARS)}`);
      continue;
    }
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (part.type === "text" ? part.text : "[图片]"))
        .join("\n");
    }
    const calls = (message.tool_calls ?? [])
      .map((call) => `${call.function.name}(${truncate(call.function.arguments, 500)})`)
      .join("; ");
    const body = [
      text.trim().length > 0 ? truncate(text, TEXT_MAX_CHARS) : "",
      calls.length > 0 ? `【调用工具】${calls}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
    if (body.length === 0) continue;
    lines.push(`${message.role === "user" ? "用户" : "助手"}：${body}`);
  }
  return lines.join("\n\n");
}

/** 一次摘要生成的请求参数 */
export interface ContextSummaryOptions {
  /** 模型服务基础地址 */
  url: string;
  /** 访问密钥 */
  key: string;
  /** 用于生成摘要的模型 id（沿用会话当前模型） */
  model: string;
  /** 上一次的滚动摘要，空串表示首次压缩 */
  previousSummary: string;
  /** 本次被折叠的消息展开出的 ChatMessage（按时间顺序） */
  folded: ChatMessage[];
  /** 中断信号：用户点停止时摘要请求一并中止 */
  signal?: AbortSignal;
}

/**
 * 生成新的滚动摘要（非流式）。
 *
 * 摘要是旁路调用：不进主对话流、不渲染增量，只要最终文本。返回空串按「无有效输出」处理，
 * 由调用方决定跳过压缩还是报错。
 */
export function requestContextSummary(options: ContextSummaryOptions): Promise<string> {
  const conversation = serializeForSummary(options.folded);
  const userContent = [
    options.previousSummary.trim().length > 0
      ? `已有摘要（合并进新摘要，不要丢失其中的关键信息）：\n${options.previousSummary}`
      : "",
    `本次待压缩的会话内容：\n${conversation}`,
    "请输出更新后的摘要。",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

  return requestChatCompletion({
    url: options.url,
    key: options.key,
    model: options.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: userContent },
    ],
    signal: options.signal,
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });
}
