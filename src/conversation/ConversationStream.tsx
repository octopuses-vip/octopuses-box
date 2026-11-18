import { PlanCard } from "../tasks/PlanCard";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { rollbackWorkspaceCheckpoint } from "../app/desktop/workspace";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { selectActiveMessages } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import { APP_NAME } from "../app/meta";
import type { Message, MessageAttachment, QuestionAnswers, StreamItem } from "../app/types";
import { Icon } from "../components/Icon";
import { resolveCommandApproval } from "../hooks/useAgentRun";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { AnswerText } from "./blocks/AnswerText";
import { ApprovalCard } from "./blocks/ApprovalCard";
import { CheckpointCard } from "./blocks/CheckpointCard";
import { DiffCard } from "./blocks/DiffCard";
import { ExecutionDetailsCard } from "./blocks/ExecutionDetailsCard";
import { MessageActions } from "./blocks/MessageActions";
import { NoticeCard } from "./blocks/NoticeCard";
import { QuestionCard } from "./blocks/QuestionCard";
import { ReasoningBlock } from "./blocks/ReasoningBlock";
import { SourcesCard } from "./blocks/SourcesCard";
import { VideoJobCard } from "../video/VideoJobCard";
import { ToolCallCard } from "./blocks/ToolCallCard";
import { UsageCard } from "./blocks/UsageCard";
import { UserMessage } from "./blocks/UserMessage";
import { WorkingIndicator } from "./blocks/WorkingIndicator";
import { messageMarkdown, messagePlainText } from "./transcript";
import { selectAnswerVersion } from "./answerVersions";
import { messageWindowRange } from "./messageWindow";
import { useKnowledgeStore } from "../knowledge/store";

// 历史消息不随流式分片变化，避免每个分片都重新生成全部复制与分享文本。
const ConversationActions = memo(function ConversationActions({
  message,
  threadTitle,
  disabled,
  turnUser,
  onFollowUp,
  onRegenerate,
  className,
}: {
  message: Message;
  threadTitle: string;
  disabled: boolean;
  turnUser?: Message;
  onFollowUp: (message: Message) => void;
  onRegenerate: (message: Message) => void;
  className?: string;
}) {
  return (
    <MessageActions
      text={messagePlainText(message)}
      markdown={`> 来自 ${APP_NAME} 的对话：${threadTitle}\n\n${messageMarkdown(message)}`}
      disabled={disabled}
      onFollowUp={() => onFollowUp(message)}
      onRegenerate={turnUser ? () => onRegenerate(turnUser) : undefined}
      className={className}
    />
  );
});

/** 提交需求确认卡片：一次把所有问题的答案发回模型 */
type AnswerHandler = (itemId: string, answers: QuestionAnswers) => void;
type ApprovalHandler = (itemId: string, approved: boolean) => void;
type ApprovalRevokeHandler = (itemId: string, pattern: string) => void;
type RollbackHandler = (itemId: string, checkpointId: string) => void;

/**
 * 按类型渲染消息流中的一个内容块（开发者 Jan）：正文、思考、工具调用、确认卡片、差异、来源、提示与用量。
 *
 * 收敛成一处分发的原因：消息流里各块的顺序与归属由数据决定，
 * 渲染必须与之一一对应，散落在各组件里会出现「某类块忘了处理」的漏渲染。
 */
function renderItem(
  item: StreamItem,
  running: boolean,
  onAnswer: AnswerHandler,
  onApproval: ApprovalHandler,
  onApprovalRevoke: ApprovalRevokeHandler,
  onRollback: RollbackHandler,
) {
  switch (item.type) {
    case "execution_details":
      return <ExecutionDetailsCard key={item.id} details={item.details} />;
    case "reasoning":
      return <ReasoningBlock key={item.id} text={item.text} done={item.done} />;
    case "tool_call":
      if (item.kind === "plan" && item.plan?.length) return <PlanCard key={item.id} steps={item.plan} />;
      if (item.kind === "video_gen") return <VideoJobCard key={item.id} item={item} />;
      return (
        <ToolCallCard
          key={item.id}
          kind={item.kind}
          title={item.title}
          command={item.command}
          status={item.status}
          output={item.output}
          durationMs={item.durationMs}
        />
      );
    case "question":
      return (
        <QuestionCard
          key={item.id}
          questions={item.questions}
          answers={item.answers}
          disabled={running}
          onSubmit={(answers) => onAnswer(item.id, answers)}
        />
      );
    case "approval":
      return (
        <ApprovalCard
          key={item.id}
          command={item.command}
          reason={item.reason}
          status={item.status}
          auto={item.auto ?? false}
          revoked={item.revoked}
          source={item.source}
          onDecision={(approved) => onApproval(item.id, approved)}
          onRevoke={() => onApprovalRevoke(item.id, item.pattern)}
        />
      );
    case "checkpoint":
      return (
        <CheckpointCard
          key={item.id}
          status={item.status}
          detail={item.detail}
          onRollback={() => onRollback(item.id, item.checkpointId)}
        />
      );
    case "diff":
      return <DiffCard key={item.id} files={item.files} />;
    case "sources":
      return <SourcesCard key={item.id} items={item.items} />;
    case "text":
      return <AnswerText key={item.id} text={item.text} streaming={item.streaming} />;
    case "notice":
      return <NoticeCard key={item.id} tone={item.tone} text={item.text} />;
    case "usage":
      return <UsageCard key={item.id} model={item.model} usage={item.usage} rounds={item.rounds} />;
    default:
      return null;
  }
}

interface ConversationStreamProps {
  onSubmit: (prompt: string, attachments: MessageAttachment[]) => void;
  /** 「追问」：把某条消息作为引用交给输入框（由 `ThreadView` 填进去并聚焦） */
  onFollowUp: (message: Message) => void;
  /** 「重新生成」：从某条提问重跑这一轮（由 `ThreadView` 裁剪会话后重新运行） */
  onRegenerate: (userMessage: Message) => void;
}

/**
 * 消息流视图（开发者 Jan）：把当前会话的消息逐条渲染成内容块，并承载回答 / 追问 / 确认等交互。
 *
 * 只负责「怎么展示」与把用户动作向上抛（onSubmit / onFollowUp），
 * 真正的运行与落盘都交给上层，因此这里不直接触碰 store 的写入动作。
 */
export function ConversationStreamBase({
  onSubmit,
  onFollowUp,
  onRegenerate,
}: ConversationStreamProps) {
  const messages = useAppStore(selectActiveMessages);
  const jumpTarget = useKnowledgeStore((s) => s.jumpTarget);
  const [visibleCount, setVisibleCount] = useState(100);
  const [historyEnd, setHistoryEnd] = useState<number | null>(null);
  const historyAnchor = useRef<{ top: number; height: number } | null>(null);
  const running = useAppStore((state) => state.threadRunStates[state.activeThreadId]?.status === "running");
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  const patchItem = useAppStore((state) => state.patchItem);
  const runStartedAt = useAppStore(
    (state) => state.threadRunStates[state.activeThreadId]?.startedAt ?? null,
  );
  const cachePath = useAppStore((state) => state.cachePath);
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const loadGitDiff = useAppStore((state) => state.loadGitDiff);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const [emptyStartedAt] = useState(() => Date.now());
  const threadTitle = useAppStore(
    (state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.title ?? "",
  );

  /**
   * 本轮提问的 id：会话里最后一条用户消息。
   *
   * 「重新生成」只对最后一轮开放：更早的轮次一旦重跑，后面的对话就都悬空了，
   * 那属于分支对话该处理的事，不在这一版的范围内。
   */
  let lastTurnUserIndex = messages.length - 1;
  while (lastTurnUserIndex >= 0 && messages[lastTurnUserIndex].role !== "user") {
    lastTurnUserIndex -= 1;
  }
  const lastTurnUser = messages[lastTurnUserIndex];

  /**
   * 给一条消息装配操作栏。
   *
   * 文本口径统一交给 `transcript`：复制取纯文本、分享取 Markdown 片段、追问把整条消息交给上层做引用。
   * 「重新生成」只挂在最后一轮的提问及其回答上，其余消息不渲染该按钮。
   */
  const actionsFor = (message: Message, index: number, extraClass?: string) => {
    // 正在流式输出的那条助手消息不显示操作栏：正文还没写完，此时复制会拿到半截内容
    if (running && index === messages.length - 1) return null;
    return (
      <>
      <ConversationActions
        message={message}
        threadTitle={threadTitle}
        disabled={running}
        turnUser={index >= lastTurnUserIndex ? lastTurnUser : undefined}
        onFollowUp={onFollowUp}
        onRegenerate={onRegenerate}
        className={extraClass}
      />
      {message.id === lastTurnUser?.id && message.answerVersions?.length ? <label className="answer-versions">回答版本<select className="form__select" aria-label="回答版本" value="current" disabled={running} onChange={(event) => {
        const versionId = event.target.value;
        useAppStore.setState((state) => ({ messages: { ...state.messages, [activeThreadId]: selectAnswerVersion(state.messages[activeThreadId] ?? [], message.id, versionId) }, threads: state.threads.map((t) => t.id === activeThreadId ? { ...t, contextSummary: "", contextCoveredCount: 0 } : t) }));
      }}><option value="current">当前回答</option>{message.answerVersions.map((v, i) => <option value={v.id} key={v.id}>历史回答 {i + 1}</option>)}</select></label> : null}
      </>
    );
  };

  /** 提交追问答案：卡片保留结构化选择，同时把可读摘要作为下一条用户消息继续运行 */
  const handleAnswer = (messageId: string, itemId: string, answers: QuestionAnswers) => {
    if (running) return;
    const message = messages.find((item) => item.id === messageId);
    const questionItem = message?.items.find((item) => item.id === itemId);
    if (!questionItem || questionItem.type !== "question") return;

    patchItem(activeThreadId, messageId, itemId, (item) =>
      item.type === "question" ? { ...item, answers } : item,
    );
    const summary = questionItem.questions
      .map((question) => {
        const value = answers[question.id] ?? [];
        const answer = value[0] === "user_note" ? value.slice(1).join("\n") : value.join("、");
        return `${question.header}：${answer}`;
      })
      .join("\n");
    onSubmit(summary, []);
  };

/** 函数级说明（开发者 Jan）：执行 handleApproval 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleApproval = (messageId: string, itemId: string, approved: boolean) => {
    if (!resolveCommandApproval(itemId, approved)) {
      patchItem(activeThreadId, messageId, itemId, (item) =>
        item.type === "approval" ? { ...item, status: "expired" } : item,
      );
    }
  };

  /** 撤销一次自动批准：把命令模式加入不再自动通过的名单，并就地更新卡片 */
  const handleApprovalRevoke = (messageId: string, itemId: string, pattern: string) => {
    useAppStore.getState().addAutoApprovalDenylist(pattern);
    patchItem(activeThreadId, messageId, itemId, (item) =>
      item.type === "approval" ? { ...item, revoked: true } : item,
    );
  };

/** 函数级说明（开发者 Jan）：执行 handleRollback 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleRollback = async (messageId: string, itemId: string, checkpointId: string) => {
    const checkpoint = messages.find((m) => m.id === messageId)?.items.find((i) => i.id === itemId);
    const checkpointRoot = checkpoint?.type === "checkpoint" ? checkpoint.workspacePath ?? workspacePath : workspacePath;
    if (!cachePath || !checkpointRoot) {
      patchItem(activeThreadId, messageId, itemId, (item) =>
        item.type === "checkpoint"
          ? { ...item, status: "error", detail: "缓存目录或项目目录不可用，无法回滚。" }
          : item,
      );
      return;
    }
    patchItem(activeThreadId, messageId, itemId, (item) =>
      item.type === "checkpoint" ? { ...item, status: "rollingBack", detail: "正在恢复文件…" } : item,
    );
    try {
      const result = await rollbackWorkspaceCheckpoint(cachePath, checkpointRoot, checkpointId);
      patchItem(activeThreadId, messageId, itemId, (item) =>
        item.type === "checkpoint"
          ? { ...item, status: "rolledBack", detail: `已恢复 ${result.files.length} 个文件。` }
          : item,
      );
      await loadGitDiff();
      setRightTab("diff");
    } catch (error) {
      patchItem(activeThreadId, messageId, itemId, (item) =>
        item.type === "checkpoint"
          ? {
              ...item,
              status: "error",
              detail: `回滚失败：${error instanceof Error ? error.message : String(error)}`,
            }
          : item,
      );
    }
  };

  const lastItemCount = messages.at(-1)?.items.length ?? 0;
  const { ref, onScroll, pinned, scrollToBottom, pauseFollowing } = useAutoScroll<HTMLDivElement>(
    `${messages.length}-${lastItemCount}`,
  );
  const historyWindow = messageWindowRange(messages.map((m) => m.id), visibleCount, jumpTarget?.threadId === activeThreadId ? jumpTarget.messageId : undefined, historyEnd);
  const historyStart = historyWindow.start;
  useEffect(() => {
    if (!jumpTarget || jumpTarget.threadId !== activeThreadId) return;
    const index = messages.findIndex((m) => m.id === jumpTarget.messageId);
    if (index >= 0) { pauseFollowing(); setHistoryEnd(Math.min(messages.length, index + 50)); setVisibleCount(100); }
  }, [jumpTarget, activeThreadId, messages, pauseFollowing]);
  useLayoutEffect(() => {
    const node = ref.current, anchor = historyAnchor.current;
    if (node && anchor) { node.scrollTop = anchor.top + node.scrollHeight - anchor.height; historyAnchor.current = null; }
  }, [visibleCount, ref]);

  useEffect(() => {
    if (running) { setHistoryEnd(null); scrollToBottom(); }
  }, [running, scrollToBottom]);

  return (
    <div className="conversation-stream">
      <div className="chat-scroll" ref={ref} onScroll={onScroll}>
        <div className="chat-inner">
          {historyStart > 0 ? <button className="btn btn--ghost btn--sm history-load-more" type="button" onClick={() => {
            pauseFollowing();
            if (ref.current) historyAnchor.current = { top: ref.current.scrollTop, height: ref.current.scrollHeight };
            setVisibleCount((n) => n + 100);
          }}>加载更早的消息（还有 {historyStart} 条）</button> : null}
          {messages.slice(historyStart, historyWindow.end).map((message, offset) => {
            const index = historyStart + offset;
            return (
            message.role === "user" ? (
              <UserMessage
                key={message.id}
                messageId={message.id}
                text={message.items.map((item) => (item.type === "text" ? item.text : "")).join("")}
                attachments={message.attachments ?? []}
                actions={actionsFor(message, index)}
              />
            ) : (
              <div className="msg" key={message.id} data-message-id={message.id}>
                <div className="assistant">
                  {message.items.filter((item, itemIndex) => item.type !== "tool_call" || item.kind !== "plan" || !item.plan?.length || !message.items.slice(itemIndex + 1).some((later) => later.type === "tool_call" && later.kind === "plan" && later.plan?.length)).map((item) =>
                    renderItem(
                      item,
                      running,
                      (itemId, answers) => handleAnswer(message.id, itemId, answers),
                      (itemId, approved) => handleApproval(message.id, itemId, approved),
                      (itemId, pattern) => handleApprovalRevoke(message.id, itemId, pattern),
                      (itemId, checkpointId) => void handleRollback(message.id, itemId, checkpointId),
                    ),
                  )}
                  {actionsFor(message, index, "msg__actions--assistant")}
                </div>
              </div>
            ));
          })}
          {historyWindow.end < messages.length ? <button className="btn btn--ghost btn--sm history-load-more" onClick={() => { setHistoryEnd((n) => Math.min(messages.length, (n ?? messages.length) + 100)); setVisibleCount((n) => n + 100); }}>加载更新的消息（还有 {messages.length - historyWindow.end} 条）</button> : null}
          {running ? <WorkingIndicator startedAt={runStartedAt ?? emptyStartedAt} /> : null}
        </div>
      </div>
      {!pinned ? (
        <div className="chat-latest-bar">
          <button type="button" className="btn btn--sm" onClick={() => { setHistoryEnd(null); setVisibleCount(100); requestAnimationFrame(scrollToBottom); }}>
            <Icon name="arrow-up" size={12} />
            回到最新
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 消息流视图对外出口（开发者 Jan）：用 `memo` 包一层，切断「输入框按键 → 整段会话重渲染」。
 *
 * 输入内容由上层 `ThreadView` 持有，每次按键都会让它重渲染；若不拦截，消息流会跟着重算，
 * 消息块里的 Markdown 会被整段替换（一次按键上百次 DOM 变更），WebKit 借此调整滚动位置，
 * 把原本贴底的会话拽到中间——浏览器端滚动策略不同，所以只在客户端复现。
 * 上层通过 `useCallback` 固定传入的回调引用。
 */
export const ConversationStream = memo(ConversationStreamBase);
