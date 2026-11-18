import { taskKey, taskState, changeGoal } from "../tasks/store";

import { writeCacheFile } from "../app/desktop/cache";
import { useAppStore } from "../app/state";
import type {
  Message,
  MessageAttachment,
  RunStopReason,
  StreamItem,
} from "../app/types";
import { logCacheEvent } from "../cache/logger";
import { discardConversationDraft, draftKey, setDraftText, useConversationDrafts, attachmentDraftFor } from "../model/conversationDrafts";
import { selectAnswerVersion } from "../conversation/answerVersions";
import { toUserContent } from "../model/attachments";
import { toImageContentPart, type ToolImage } from "../model/toolImage";
import {
  type ChatContentPart,
  type ChatMessage,
  type ToolCall,
} from "../model/client";

/**
 * 一次运行里最多保留几张截图回灌给模型：截图体积大，无限累积会撑爆上下文
 */
/** Agent 运行共享状态与队列（开发者 Jan）。 */
export const MAX_PENDING_IMAGES = 3;
/** 工具结果写入会话卡片时截断的字符数，避免长技能正文撑爆界面 */
export const TOOL_OUTPUT_PREVIEW = 1600;
/** 自动化记录在拿不到具体失败原因时的兜底文案 */
export const AUTOMATION_FALLBACK_ERROR = "Agent 运行失败，请打开会话查看详情。";

/** 把时长预算写成可读文案：整分钟按分钟展示，否则退回秒 */
export function formatBudgetDuration(secs: number): string {
  return secs % 60 === 0 ? `${secs / 60} 分钟` : `${secs} 秒`;
}

/**
 * 把一次运行的结束原因写成可读文案（开发者 Jan）。
 *
 * 被上限截停与执行出错都会以一条 `notice` 片段呈现在会话里，自动化记录也复用同一句话。
 * 在此之前这类结束被当作成功静默收尾，用户只能看到会话「莫名其妙停下」而没有任何解释。
 */
export function describeStopReason(
  reason: RunStopReason,
  limits: { rounds: number; durationSecs: number; tokens: number | null },
): string {
  switch (reason) {
    case "maxRounds":
      return `已达到单次运行的轮数上限（${limits.rounds} 轮），本次运行已停止。可在设置页调高上限后重新发起。`;
    case "timeBudget":
      return `已达到单次运行的时长上限（${formatBudgetDuration(limits.durationSecs)}），本次运行已停止。可在设置页调高上限后重新发起。`;
    case "tokenBudget":
      return `已达到单次运行的 token 上限（${limits.tokens ?? 0}），本次运行已停止。可在设置页调高上限后重新发起。`;
    default:
      return "";
  }
}

/**
 * 把工具产出的图片收集到待回灌队列（开发者 Jan）。
 *
 * 控制类工具历史上用单个 `image` 字段，视觉 / 工程类工具用 `images` 数组，字段不统一；
 * 这里统一收敛成「一条通路」，新增会产出图片的工具不必再各自往队列里塞。
 * 只保留最近若干张：更早的画面已被后续操作覆盖，留着只是白占上下文。
 */
export function collectToolImages(
  result: {
    image?: { mime: string; base64: string; width?: number; height?: number };
    images?: ToolImage[];
  },
  target: ChatContentPart[],
): void {
  const produced: ToolImage[] = [
    ...(result.images ?? []),
    ...(result.image
      ? [
          {
            mime: result.image.mime,
            base64: result.image.base64,
            width: result.image.width,
            height: result.image.height,
          },
        ]
      : []),
  ];
  if (produced.length === 0) return;
  produced.forEach((image) => target.push(toImageContentPart(image)));
  if (target.length > MAX_PENDING_IMAGES) {
    target.splice(0, target.length - MAX_PENDING_IMAGES);
  }
}

/** 把一次运行的状态快照写入缓存路径的 `temp/`，便于排查运行中的中间状态 */
export function persistRunSnapshot(
  threadId: string,
  prompt: string,
  status: "running" | "done" | "aborted",
  startedAt: number,
  reason: RunStopReason | null = null,
) {
  const cachePath = useAppStore.getState().cachePath;
  if (!cachePath) return;
  const snapshot = {
    threadId,
    prompt,
    status,
    startedAt,
    /** 结束原因：运行中为 null，便于区分「正常收束」与「被上限截停 / 出错」 */
    stopReason: reason,
    finishedAt: status === "running" ? null : Date.now(),
  };
  void writeCacheFile(cachePath, `temp/run-${threadId}.json`, JSON.stringify(snapshot, null, 2)).catch(
    () => {},
  );
}

/** 该会话是否仍是当前打开的会话：右栏产物 / 差异 / 来源只推到正在看的会话上 */
export function isActiveThread(threadId: string): boolean {
  return useAppStore.getState().activeThreadId === threadId;
}

/** 把一张追问卡片还原成可发送的文本 */
export function questionSummary(item: Extract<StreamItem, { type: "question" }>): string {
  const questions = item.questions.map((question) => {
    const options = question.options.map((option) => option.label).join(" / ");
    const values = item.answers?.[question.id];
    const answer = values
      ? values[0] === "user_note"
        ? values.slice(1).join("\n")
        : values.join("、")
      : null;
    return answer
      ? `${question.header}：${question.question}（用户回答：${answer}）`
      : `${question.header}：${question.question}（建议选项：${options} / 其他）`;
  });
  return `已向用户提问：\n${questions.join("\n")}`;
}

/**
 * 一条消息里可作为纯文本发送的部分。
 *
 * 追问卡片是模型自己抛出的一轮提问，重建上下文时要还原成助手内容：否则下一轮模型看不到
 * 自己问过什么，只能靠用户回复的文字反推意图。思考块与差异 / 来源卡片不进上下文。
 */
export function messageText(items: StreamItem[]): string {
  let text = "";
  for (const item of items) {
    if (item.type === "text") {
      text += item.text;
    } else if (item.type === "question") {
      text += `${text.length > 0 ? "\n" : ""}${questionSummary(item)}`;
    }
  }
  return text;
}

/**
 * 用会话既有的文本、工具历史与附件拼出上下文。
 *
 * 工具卡片按协议还原成 `assistant(tool_calls)` + `role: "tool"` 的配对并保持原有先后顺序：
 * 否则下一轮模型看不到自己调用过什么、拿到了什么结果，只能凭空猜测，跨轮次的任务也就接不下去。
 * 旧会话的卡片缺少 `callId` / `name` 时整条跳过，绝不拼出「有 tool_calls 却没有对应 tool 结果」
 * 的畸形请求；执行中被打断、尚未落结果的卡片同样跳过。
 *
 * `coveredCount` 是滚动摘要已覆盖的消息条数（`Thread.contextCoveredCount`）：这些消息不再
 * 进入上下文，由摘要代替。返回值里的 `boundaries[k]` 标记「前 k 条未覆盖消息」展开出的
 * ChatMessage 条数，供自动压缩按消息粒度规划折叠点——切在消息边界上天然不会拆散
 * tool 配对（配对都在单条助手消息内部生成）。
 */
export function buildHistory(
  messages: Message[] | undefined,
  prompt: string,
  attachments: MessageAttachment[],
  coveredCount = 0,
  includeImages = true,
  videoResult?: (id: string) => string | undefined,
): { history: ChatMessage[]; boundaries: number[] } {
  const history: ChatMessage[] = [];
  const boundaries: number[] = [];
  const list = messages ?? [];
  const skipped = Math.min(Math.max(coveredCount, 0), list.length);
  for (let index = skipped; index < list.length; index += 1) {
    boundaries.push(history.length);
    const message = list[index];
    if (message.role === "user") {
      const text = messageText(message.items);
      const carried = message.attachments ?? [];
      if (text.trim().length === 0 && carried.length === 0) continue;
      history.push({ role: "user", content: toUserContent(text, carried, includeImages) });
      continue;
    }
    // 助手消息里可能有「正文 → 调工具 → 正文 → 再调工具」多段：每遇到一批工具调用，
    // 就把此前累积的正文与这批调用配成一条 assistant 消息，紧随其后放各自的 tool 结果
    let text = "";
    let pending: { call: ToolCall; result: string }[] = [];
/** 函数级说明（开发者 Jan）：执行 flush 的单一职责，并返回可供调用方继续处理的结果。 */
    const flush = () => {
      if (pending.length === 0) return;
      history.push({
        role: "assistant",
        content: text.trim().length > 0 ? text : null,
        tool_calls: pending.map((entry) => entry.call),
      });
      for (const entry of pending) {
        history.push({ role: "tool", tool_call_id: entry.call.id, content: entry.result });
      }
      text = "";
      pending = [];
    };
    for (const item of message.items) {
      if (item.type === "text") {
        text += item.text;
      } else if (item.type === "question") {
        text += `${text.length > 0 ? "\n" : ""}${questionSummary(item)}`;
      } else if (item.type === "tool_call" && item.callId && item.name && (item.status !== "running" || (item.videoJobId && videoResult?.(item.videoJobId)))) {
        pending.push({
          call: {
            id: item.callId,
            type: "function",
            function: { name: item.name, arguments: item.arguments ?? "{}" },
          },
          // 完整结果优先；旧会话只有被截断的展示文本时退回用它，总好过丢掉整轮工具历史
          result: (item.videoJobId ? videoResult?.(item.videoJobId) : undefined) ?? item.result ?? item.output,
        });
      }
    }
    flush();
    if (text.trim().length > 0) history.push({ role: "assistant", content: text });
  }
  boundaries.push(history.length);
  history.push({ role: "user", content: toUserContent(prompt, attachments, includeImages) });
  return { history, boundaries };
}

/** 从工具参数里取出技能名，仅用于工具卡片的标题展示 */
export function readSkillName(argumentsJson: string): string | null {
  return readArgumentString(argumentsJson, "name");
}

/** 从工具参数里取出文件名，仅用于工具卡片的标题展示 */
export function readFileName(argumentsJson: string): string | null {
  return readArgumentString(argumentsJson, "name");
}

/** 工具卡片标题里的参数摘要，过长时截断，避免图片提示词把标题撑爆 */
export function titleSummary(value: string | null, max = 24): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 从工具参数的 JSON 里取一个数值字段，取不到返回 null */
export function readArgumentNumber(argumentsJson: string, key: string): number | null {
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  } catch {
    // 参数不完整时标题回落为通用文案，不影响工具实际执行
  }
  return null;
}

/** 从工具参数的 JSON 里取一个非空字符串字段，取不到返回 null */
export function readArgumentString(argumentsJson: string, key: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
    const value = parsed[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  } catch {
    // 参数不完整时标题回落为通用文案，不影响工具实际执行
  }
  return null;
}

/** 截断过长的工具输出，仅影响卡片展示，回填给模型的仍是完整内容 */
export function preview(text: string): string {
  return text.length > TOOL_OUTPUT_PREVIEW ? `${text.slice(0, TOOL_OUTPUT_PREVIEW)}\n…（已截断）` : text;
}

/** 本会话此前是否已成功写出过产物：已开工的会话不再给模型追问的机会 */
export function hasProducedArtifact(messages: Message[] | undefined, videoDone?: (id: string) => boolean): boolean {
  return (messages ?? []).some((message) => message.items.some((item) => {
    if (item.type !== "tool_call") return false;
    if (item.kind === "video_gen") return Boolean(item.videoJobId && videoDone?.(item.videoJobId));
    return item.status === "success" && (item.kind === "write_artifact" || item.kind === "image_gen");
  }));
}

/**
 * 每个会话各自一个运行槽位：同一会话内串行（保留 Steer / Queue 语义），不同会话可并行。
 *
 * 会话界面与「自动化」调度会各自实例化本 hook，运行状态放在模块级，任意来源发起的运行
 * 都能被同一处停止；把控制器按会话拆开之后，并行跑多个会话时「停止」只中断目标会话，
 * 切走页面也不会丢掉任何正在跑的任务。
 */
export interface ThreadRun {
  done: Promise<void> | null;
  /** 该会话当前正在执行的一次请求，空闲为 null */
  active: AgentRequest | null;
  /** 该会话等待执行的请求队列，按入队顺序执行 */
  queue: AgentRequest[];
  /** 该会话本次运行的中断控制器，空闲为 null */
  abort: AbortController | null;
  /** 该会话本次运行的开始时间（毫秒），空闲为 0 */
  startedAt: number;
}

export const threadRuns = new Map<string, ThreadRun>();

/** 取（必要时创建）某个会话的运行槽位 */
export function runSlot(threadId: string): ThreadRun {
  let slot = threadRuns.get(threadId);
  if (!slot) {
    slot = { active: null, queue: [], abort: null, startedAt: 0, done: null };
    threadRuns.set(threadId, slot);
  }
  return slot;
}

/**
 * 提交模式（开发者 Jan）。取值保持英文，与队列内部逻辑、自动化配置里的 `mode` 字段一致；
 * 界面上对应中文按钮：`queue` → 「排队」，`steer` → 「立即转向」，`run` 为空闲时的发送。
 */
export type AgentSubmitMode = "run" | "queue" | "steer";

export interface AgentRequest {
  scope?: string | null;
  regenerateFrom?: string;
  id: string;
  threadId: string;
  prompt: string;
  attachments: MessageAttachment[];
  source: "user" | "automation";
  automationRunId: string | null;
  resolve: (outcome: AgentRunOutcome) => void;
}

export interface AgentRunOptions {
  regenerateFrom?: string;
  mode?: AgentSubmitMode;
  source?: AgentRequest["source"];
  automationRunId?: string | null;
}

export type AgentRunOutcome = "success" | "failed" | "aborted";

/**
 * 一次运行的结果。
 *
 * 对外只暴露成功 / 失败 / 中断，原因与可读说明留给调度处复用：自动化记录要把「被上限截停」
 * 与「执行出错」区分开写进错误信息，而不是笼统地记一句运行失败。
 */
export interface AgentExecutionResult {
  outcome: AgentRunOutcome;
  reason: RunStopReason;
  /** 非成功结果的可读说明；成功为空串 */
  message: string;
}

export type AgentExecutor = (
  threadId: string,
  prompt: string,
  attachments: MessageAttachment[],
  regenerateFrom: string | undefined,
  signal: AbortSignal,
) => Promise<AgentExecutionResult>;

/**
 * 把每个会话的运行状态同步进 store（开发者 Jan）。
 *
 * 状态源是模块级的 threadRuns（运行中的事实），store 里那份只是给界面读的快照；
 * 这里取两边的并集，既覆盖正在跑的会话，也覆盖刚结束、需要把状态改回「空闲」的会话。
 */
export function refreshThreadRunStates(): void {
  const store = useAppStore.getState();
  const threadIds = new Set([
    ...Object.keys(store.threadRunStates),
    ...threadRuns.keys(),
  ]);
  const threadRunStates = { ...store.threadRunStates };
  for (const threadId of threadIds) {
    const slot = threadRuns.get(threadId);
    const queued = slot?.queue ?? [];
    threadRunStates[threadId] = {
      status: slot?.active ? "running" : queued.length > 0 ? "queued" : "idle",
      queuedCount: queued.length,
      // 队列内容供界面展示：预览压成单行截断，事实源仍是运行槽里的请求本身
      queuedItems: queued.map((request) => ({
        id: request.id,
        preview: request.prompt.replace(/\s+/g, " ").trim().slice(0, 120),
        source: request.source,
        attachmentCount: request.attachments.length,
      })),
      startedAt: slot?.active ? slot.startedAt : null,
    };
  }
  useAppStore.setState({ threadRunStates });
}

/** 取某个会话队列里的下一个请求：用户请求优先于自动化触发的请求 */
export function nextRequest(slot: ThreadRun): AgentRequest | null {
  const userIndex = slot.queue.findIndex((request) => request.source === "user");
  const index = userIndex >= 0 ? userIndex : 0;
  return slot.queue.splice(index, 1)[0] ?? null;
}

/**
 * 消费某个会话队列里的下一条请求（开发者 Jan）：一次只跑一条，跑完再取。
 *
 * 队列空时把界面状态刷新回「空闲」；正在跑则直接返回，避免同一会话并发两条运行
 * （会话内的消息顺序与上下文是共享的，并发会互相踩踏）。
 */
async function drainThread(threadId: string, execute: AgentExecutor): Promise<void> {
  const slot = runSlot(threadId);
  if (slot.active) return;
  if (!useAppStore.getState().threads.some((t) => t.id === threadId)) { disposeThreadRun(threadId); return; }
  const request = nextRequest(slot);
  if (!request) {
    refreshThreadRunStates();
    return;
  }
  slot.active = request;
  if (request.regenerateFrom) useAppStore.setState((s) => ({ sessionNotices: { ...s.sessionNotices, [threadId]: undefined } }));
  slot.abort = new AbortController();
  let settled!: () => void;
  slot.done = new Promise<void>((resolve) => { settled = resolve; });
  slot.startedAt = Date.now();
  if (request.automationRunId) {
    useAppStore.getState().updateAutomationRun(request.automationRunId, {
      status: "running",
      error: null,
    });
  }
  refreshThreadRunStates();
  let outcome: AgentRunOutcome = "failed";
  try {
    const result = await execute(request.threadId, request.prompt, request.attachments, request.regenerateFrom, slot.abort.signal);
    outcome = result.outcome;
    if (request.automationRunId) {
      useAppStore.getState().updateAutomationRun(request.automationRunId, {
        status: outcome,
        finishedAt: Date.now(),
        // 被上限截停 / 出错时带上具体原因，而不是笼统的「运行失败」
        error: outcome === "failed" ? result.message || AUTOMATION_FALLBACK_ERROR : null,
      });
    }
  } catch (error) {
    if (slot.abort?.signal.aborted) outcome = "aborted";
    // 用户请求的异常此前在这里被静默吞掉（既不落库也不提示），界面表现为「发出去没反应」；
    // 统一留一条运行日志，避免同类问题再次无迹可查。
    logCacheEvent(
      "agent.run.error",
      `thread=${threadId} source=${request.source} ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (request.automationRunId) {
      useAppStore.getState().updateAutomationRun(request.automationRunId, {
        status: "failed",
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (request.regenerateFrom && outcome !== "success" && useAppStore.getState().cachePath === request.scope) {
      useAppStore.setState((state) => {
        const messages = state.messages[threadId];
        if (!messages) return state;
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const previous = lastUser?.answerVersions?.at(-1);
        if (!lastUser || lastUser.id === request.regenerateFrom || !previous) return state;
        return { messages: { ...state.messages, [threadId]: selectAnswerVersion(messages, lastUser.id, previous.id) }, sessionNotices: { ...state.sessionNotices, [threadId]: "重新生成未完成，已恢复上一版本；可通过回答版本切换查看。" } };
      });
    }
    request.resolve(outcome);
    slot.active = null;
    slot.startedAt = 0;
    slot.abort?.abort(); slot.abort = null;
    settled(); slot.done = null;
    refreshThreadRunStates();
    void drainThread(threadId, execute);
  }
}

/**
 * 把一个请求放进会话队列（开发者 Jan），按提交模式决定插队还是排队。
 *
 * Steer 语义：目标会话正在运行时插到队首并中断当前一轮，让模型立刻改按新指令执行；
 * 否则一律追加到队尾，保持先来先服务。
 */
export function enqueueRequest(request: AgentRequest, mode: AgentSubmitMode, execute: AgentExecutor): void {
  const state = useAppStore.getState();
  if (!state.sessionsRestored || state.sessionsRestoreError || !state.threads.some((t) => t.id === request.threadId)) { request.resolve("aborted"); return; }
  request.scope = state.cachePath;
  const slot = runSlot(request.threadId);
  // Steer 语义：目标会话正在运行时插到队首并中断当前一轮，让它立刻改按新指令执行
  if (mode === "steer" && slot.active) {
    slot.queue.unshift(request);
    slot.abort?.abort();
  } else {
    slot.queue.push(request);
  }
  refreshThreadRunStates();
  void drainThread(request.threadId, execute);
}

/**
 * 撤销队列里尚未开跑的一条请求（开发者 Jan）。
 *
 * 排队中的请求没有运行句柄，停止按钮碰不到它，只能从队列里摘掉。摘掉后必须收尾它的 Promise，
 * 否则等待结果的调用方（自动化 / 并行批次）会永远挂起；自动化来源还要把运行档案记成已中止，
 * 不然那条记录永远停在排队状态。
 */
export function cancelQueuedRequest(threadId: string, requestId: string): void {
  const slot = runSlot(threadId);
  const index = slot.queue.findIndex((request) => request.id === requestId);
  if (index < 0) return;
  const [dropped] = slot.queue.splice(index, 1);
  if (dropped?.source === "user") {
    const key = draftKey(dropped.scope ?? useAppStore.getState().cachePath, threadId);
    const current = useConversationDrafts.getState().text[key] ?? "";
    setDraftText(key, [current, dropped.prompt].filter(Boolean).join("\n\n"));
    attachmentDraftFor(key).restore(dropped.attachments);
  }
  if (dropped?.automationRunId) {
    useAppStore.getState().updateAutomationRun(dropped.automationRunId, {
      status: "aborted",
      finishedAt: Date.now(),
      error: "排队中的请求已取消。",
    });
  }
  dropped?.resolve("aborted");
  refreshThreadRunStates();
}

/**
 * 停止某个会话正在跑的那一轮（开发者 Jan）。
 *
 * 独立导出而不是只挂在 hook 上：侧栏的任务行也要能停掉不在当前界面的会话，
 * 切走会话就没有停止入口的话，「任何时候都能终止」就不成立。
 */
export function stopThreadRun(threadId: string): void {
  const key = taskKey(useAppStore.getState().cachePath, threadId);
  if (taskState(key).goal?.status === "active") changeGoal(key, "paused");
  runSlot(threadId).abort?.abort();
}

/** 函数级说明（开发者 Jan）：执行 disposeThreadRun 的单一职责，并返回可供调用方继续处理的结果。 */
export function disposeThreadRun(threadId: string): void {
  const slot = threadRuns.get(threadId);
  if (!slot) return;
  for (const request of [...slot.queue]) cancelQueuedRequest(threadId, request.id);
  slot.abort?.abort();
  if (!slot.active) threadRuns.delete(threadId);
}
/** 函数级说明（开发者 Jan）：执行 stopAllThreadRuns 的单一职责，并返回可供调用方继续处理的结果。 */
export async function stopAllThreadRuns(): Promise<void> {
  const pending = [...threadRuns.values()].flatMap((slot) => slot.done ? [slot.done] : []);
  for (const id of [...threadRuns.keys()]) disposeThreadRun(id);
  await Promise.all(pending);
}
useAppStore.subscribe((state, before) => {
  if (state.threads === before.threads && state.cachePath === before.cachePath) return;
  const current = new Set(state.threads.map((t) => t.id));
  const removed = new Set(before.threads.filter((t) => !current.has(t.id)).map((t) => t.id));
  let changed = true;
  while (changed) { changed = false; for (const thread of before.threads) if (thread.parentThreadId && removed.has(thread.parentThreadId) && !removed.has(thread.id)) { removed.add(thread.id); changed = true; } }
  for (const thread of before.threads) if (state.cachePath !== before.cachePath || removed.has(thread.id)) {
    disposeThreadRun(thread.id);
    if (state.cachePath === before.cachePath && !current.has(thread.id)) discardConversationDraft(before.cachePath, thread.id);
  }
});

export interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export const pendingApprovals = new Map<string, PendingApproval>();

/**
 * 自动化来源的审批等待上限（毫秒）。
 *
 * 自动化无人值守：卡片弹出来没人点，而 `drainThread` 要等 run 结束才释放 Rust 侧的 in-flight 标记，
 * 一旦无限期挂住，该任务此后不再触发。因此到点即按「已失效」结束本轮工具调用。
 */
export const AUTOMATION_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * 自动化来源的审批等待（开发者 Jan）：在人工等待之上加一个上限。
 *
 * 超时后先把卡片从待唤醒表里摘掉，用户之后再点这张卡片会被 `resolveCommandApproval`
 * 按「已失效」处理（返回 false），不会出现「超时之后又被放行」的错序。
 */
export function waitForAutomationApproval(
  itemId: string,
  signal: AbortSignal,
): Promise<boolean | "expired"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(itemId);
      resolve("expired");
    }, AUTOMATION_APPROVAL_TIMEOUT_MS);
    waitForCommandApproval(itemId, signal).then(
      (approved) => {
        clearTimeout(timer);
        resolve(approved);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 由独立审批卡片恢复暂停中的命令工具调用；刷新后续跑句柄不存在，卡片会显示为已失效 */
export function resolveCommandApproval(itemId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(itemId);
  if (!pending) return false;
  pendingApprovals.delete(itemId);
  pending.resolve(approved);
  return true;
}

/**
 * 挂起等待用户对一条命令给出批准或拒绝（开发者 Jan）。
 *
 * 返回值即「是否批准」：审批卡片通过 resolveCommandApproval 唤醒这个 Promise。
 * 运行被中止时以 AbortError 拒绝，让上层的工具调用链能立刻收尾，
 * 而不是永远挂在一个等不到结果的审批上。
 */
export function waitForCommandApproval(itemId: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
/** 函数级说明（开发者 Jan）：执行 abort 的单一职责，并返回可供调用方继续处理的结果。 */
    const abort = () => {
      pendingApprovals.delete(itemId);
      reject(new DOMException("命令审批已中止", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    pendingApprovals.set(itemId, {
      resolve: (approved) => {
        signal.removeEventListener("abort", abort);
        resolve(approved);
      },
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 与中断信号赛跑地等待一次工具调用（开发者 Jan）。
 *
 * 工具本身未必能取消：Rust 侧的 `run_shell`、MCP 子进程、浏览器操作都是「发出去就只能等它回来」，
 * 只有模型请求与部分 HTTP 工具接了 signal。点停止后若继续 await 这些调用，界面会一直卡在运行中，
 * 调用挂死时更是永远停不下来。这里中断一到就以 AbortError 收尾，让外层按「用户中断」结束本次运行；
 * 迟到的工具结果被丢弃（后台调用自己跑完，工具卡片照常更新，但不再回填给模型）。
 * 被丢弃的调用若稍后失败，这里吞掉异常，避免未处理的 rejection。
 */
export function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new DOMException("工具调用已中止", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
/** 函数级说明（开发者 Jan）：执行 onAbort 的单一职责，并返回可供调用方继续处理的结果。 */
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(new DOMException("工具调用已中止", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 子代理审批卡片的镜像落点（开发者 Jan）：`子会话 id -> 最外层可见会话 id`。
 *
 * 子会话不出现在任务列表里，也没有入口能切过去，人工审批卡片只推进子会话就没人能点，
 * 子代理会永远挂在等待上。委派时登记这条映射，闸门据此把卡片同时推进最外层会话；
 * 更深层的后代沿用父会话的映射，保证任意嵌套深度都落在同一个可见会话里。
 */
export const subagentApprovalMirrors = new Map<string, string>();

/** 把一条片段推进指定会话的指定助手消息（开发者 Jan）；卡片要跨会话镜像，不能只写本轮会话 */
export function pushItemInto(threadId: string, messageId: string, item: StreamItem): void {
  useAppStore.setState((state) => {
    const list = state.messages[threadId];
    if (!list) return state;
    const next = list.map((message) =>
      message.id === messageId ? { ...message, items: [...message.items, item] } : message,
    );
    return { messages: { ...state.messages, [threadId]: next } };
  });
}

/**
 * 生成「镜像到某会话最新一条助手消息」的读写口（开发者 Jan）。
 *
 * 目标消息在推卡 / 收尾时现取而不是提前记死：委派发生在哪一轮并不固定，而父会话此刻正挂起等
 * 子代理，期间不会另起新的助手消息，因此两次取到的是同一条消息。
 * 卡片上带上子代理标题，几个子代理并行时才知道是谁在等审批。
 */
export function createApprovalMirror(sourceThreadId: string, rootThreadId: string) {
/** 函数级说明（开发者 Jan）：执行 targetMessageId 的单一职责，并返回可供调用方继续处理的结果。 */
  const targetMessageId = (): string | null => {
    const list = useAppStore.getState().messages[rootThreadId] ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === "assistant") return list[i].id;
    }
    return null;
  };
  const sourceTitle = () =>
    useAppStore.getState().threads.find((item) => item.id === sourceThreadId)?.title ?? "子代理";
  return {
    push: (item: StreamItem) => {
      const messageId = targetMessageId();
      if (!messageId) return;
      pushItemInto(
        rootThreadId,
        messageId,
        item.type === "approval" ? { ...item, source: sourceTitle() } : item,
      );
    },
    patch: (itemId: string, updater: (item: StreamItem) => StreamItem) => {
      const messageId = targetMessageId();
      if (!messageId) return;
      useAppStore.getState().patchItem(rootThreadId, messageId, itemId, updater);
    },
  };
}

/** 真实 agent 运行：把消息发给模型服务，执行模型要求的工具，并把增量渲染到会话里 */
