import type { Message, Thread } from "../app/types";

/**
 * 把一个会话的全部消息转成纯文本（开发者 Jan），供「复制对话」写入剪贴板。
 *
 * 只取用户在界面上能直接读到的内容：用户消息的正文与附件名、助手的正文、工具调用、系统提示与确认卡片。
 * 思考块（reasoning）属于过程性内容，差异 / 来源卡片是结构化数据，都不进文本；助手消息还没产出
 * 任何内容（正在生成）时整段跳过，避免出现空标题。
 *
 * 本文件同时是「一条消息怎么变成文本」的唯一出处：整段导出走 [`threadTranscript`]，
 * 消息级的复制 / 分享 / 追问分别走 [`messagePlainText`] / [`messageMarkdown`] / [`messageQuote`]，
 * 三者共用同一套片段拼装（`userText` / `assistantText`），口径不会随入口漂移。
 */
export function threadTranscript(thread: Thread, messages: Message[]): string {
  const blocks = [`# ${thread.title}`];
  for (const message of messages) {
    const block = message.role === "user" ? userBlock(message) : assistantBlock(message);
    if (block.length > 0) blocks.push(block);
  }
  return blocks.join("\n\n");
}

/** 用户消息：正文 + 附件名清单（开发者 Jan） */
function userBlock(message: Message): string {
  const parts = userText(message);
  if (parts.length === 0) return "";
  return `## 用户\n\n${parts.join("\n")}`;
}

/**
 * 用户消息的正文片段 + 附件名清单（开发者 Jan）。
 *
 * 整段导出、单条复制、追问引用三处都要用同一口径描述「用户说了什么」，
 * 因此抽在这里，避免附件名的拼法在各处漂移。
 */
function userText(message: Message): string[] {
  const parts = textOf(message);
  const names = (message.attachments ?? []).map((attachment) => attachment.name);
  if (names.length > 0) parts.push(`附件：${names.join("、")}`);
  return parts;
}

/** 助手消息：正文、工具调用与已给出的确认问题（开发者 Jan） */
function assistantBlock(message: Message): string {
  const parts = assistantText(message);
  if (parts.length === 0) return "";
  return `## 助手\n\n${parts.join("\n\n")}`;
}

/**
 * 助手消息的正文片段 + 工具调用标题 + 已给出的确认问题（开发者 Jan）。
 *
 * 与 [`userText`] 同理，供整段导出、单条复制、追问引用共用。
 */
function assistantText(message: Message): string[] {
  const parts: string[] = [];
  for (const item of message.items) {
    if (item.type === "text" && item.text.trim().length > 0) parts.push(item.text.trim());
    else if (item.type === "tool_call") parts.push(`[工具] ${item.title}`);
    else if (item.type === "notice") parts.push(`[提示] ${item.text}`);
    else if (item.type === "question") {
      for (const question of item.questions) {
        const values = item.answers?.[question.id];
        const answer = values
          ? values[0] === "user_note"
            ? values.slice(1).join("\n")
            : values.join("、")
          : null;
        parts.push(answer ? `[确认] ${question.question} → ${answer}` : `[确认] ${question.question}`);
      }
    }
  }
  return parts;
}

/** 取一条消息里的正文文本片段（开发者 Jan）；用户消息可能同时有多段 */
function textOf(message: Message): string[] {
  const parts: string[] = [];
  for (const item of message.items) {
    if (item.type === "text" && item.text.trim().length > 0) parts.push(item.text.trim());
  }
  return parts;
}

/**
 * 追问引用的截断长度。
 *
 * 引用是给模型看的上下文，不是全文存档：过长的回答会让输入框被引用占满、
 * 用户自己还没开始写就已经滚不到头，因此超出部分截断并留一个省略标记。
 */
const QUOTE_MAX_CHARS = 600;

/** 追问引用里省略标记之前的说明，避免用户以为引用是完整的 */
const QUOTE_TRUNCATED_MARK = "…（引用已截断）";

/** 追问引用的来源前缀：区分「引用的是助手的回答」与「引用的是自己的提问」 */
const QUOTE_PREFIX_ASSISTANT = "引用回答：";
const QUOTE_PREFIX_USER = "引用我的提问：";

/** 一条消息的全部可见文本（开发者 Jan）；不含小标题，供「复制」写入剪贴板 */
export function messagePlainText(message: Message): string {
  const parts = message.role === "user" ? userText(message) : assistantText(message);
  return parts.join("\n\n");
}

/**
 * 一条消息的 Markdown 片段（开发者 Jan），供「分享」写入剪贴板。
 *
 * 复用整段导出同款的小标题与拼装方式，因此分享出去的内容与「复制对话」里
 * 那一条长得完全一样，粘到文档里即可阅读。
 */
export function messageMarkdown(message: Message): string {
  return message.role === "user" ? userBlock(message) : assistantBlock(message);
}

/**
 * 把一条消息包成引用块（开发者 Jan），供「追问」填进输入框。
 *
 * 逐行加 `> ` 前缀，首行点明引用来源，末尾留一个空行让用户的光标落在引用之后直接续写；
 * 过长时按 [`QUOTE_MAX_CHARS`] 截断，避免输入框被引用占满。
 */
export function messageQuote(message: Message): string {
  const body = messagePlainText(message);
  const prefix = message.role === "user" ? QUOTE_PREFIX_USER : QUOTE_PREFIX_ASSISTANT;
  const kept =
    body.length > QUOTE_MAX_CHARS
      ? `${body.slice(0, QUOTE_MAX_CHARS)}\n${QUOTE_TRUNCATED_MARK}`
      : body;
  const quoted = `${prefix}${kept}`
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n`;
}
