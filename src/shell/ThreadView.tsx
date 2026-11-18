import { setGoal, taskKey, useTaskStore } from "../tasks/store";
import { useCallback, useEffect, useState } from "react";

import { useAppStore } from "../app/state";
import type { Message, MessageAttachment } from "../app/types";
import { ConversationStream } from "../conversation/ConversationStream";
import { messagePlainText, messageQuote } from "../conversation/transcript";
import { cancelQueuedRequest, useAgentRun, type AgentSubmitMode } from "../hooks/useAgentRun";
import { Composer } from "./composer/Composer";
import { TaskPanel } from "../tasks/TaskPanel";
import { SessionHeader } from "./SessionHeader";
import { useKnowledgeStore } from "../knowledge/store";
import { draftKey, setDraftText, useConversationDrafts } from "../model/conversationDrafts";

/** 中间栏：会话头部 + 消息流 + 输入区（集成终端由骨架层 AppShell 统一承载） */
export function ThreadView() {
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  const messages = useAppStore((s) => s.messages[activeThreadId]);
  const loadError = useAppStore((s) => s.sessionLoadErrors[activeThreadId]);
  const notice = useAppStore((s) => s.sessionNotices[activeThreadId]);
  const ensureLoaded = useAppStore((s) => s.ensureThreadLoaded);
  useEffect(() => { void ensureLoaded(activeThreadId).catch(() => {}); }, [activeThreadId, ensureLoaded]);
  const jumpTarget = useKnowledgeStore((state) => state.jumpTarget);
  useEffect(() => {
    if (!jumpTarget || messages === undefined) return;
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTarget.messageId)}"]`);
      if (target && useAppStore.getState().activeThreadId === jumpTarget.threadId) {
        target.scrollIntoView({ block: "center" });
        target.animate([{ backgroundColor: "var(--bg-active)" }, { backgroundColor: "transparent" }], { duration: 2400 });
      }
      useKnowledgeStore.setState({ jumpTarget: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpTarget, messages]);
  const scope = useAppStore((state) => state.cachePath);
  const key = draftKey(scope, activeThreadId);
  const prompt = useConversationDrafts((s) => s.text[key] ?? "");
  const setPrompt = useCallback((value: string | ((current: string) => string)) => {
    setDraftText(key, typeof value === "function" ? value(useConversationDrafts.getState().text[key] ?? "") : value);
  }, [key]);
  /**
   * 「追问」请求聚焦输入框的信号，每次追问自增。
   *
   * 输入框的焦点属于命令式状态，值一变就重新聚焦一次，因此用计数而非布尔量。
   */
  const [focusSignal, setFocusSignal] = useState(0);
  const threadRunState = useAppStore((state) => state.threadRunStates[activeThreadId]);
  const { run, stop } = useAgentRun();
  const isRunning = threadRunState?.status === "running";

  /*
   * 三个回调都用 useCallback 固定引用（开发者 Jan）：输入框每次按键都会改写本组件的 `prompt`，
   * 若回调每次重建，下方的 `ConversationStream`（已 memo）就会被判定为「入参变了」而重渲染，
   * 消息流随之整段重算、Markdown 被替换，客户端 WebKit 会因此调整滚动位置把会话拽偏。
   * 依赖里只放真正会变的闭包变量，保证按键时不产生新引用。
   */
  const handleSubmit = useCallback(
    (
      value: string,
      attachments: MessageAttachment[],
      mode: AgentSubmitMode = "run",
    ) => {
      setPrompt("");
      const key = taskKey(useAppStore.getState().cachePath, activeThreadId);
      if (/^\/goal\s+/.test(value)) { setGoal(key, value.replace(/^\/goal\s+/, "")); return; }
      if (/^\/plan(?:\s|$)/.test(value)) { useTaskStore.getState().patch(key, { mode: "plan" }); value = value.replace(/^\/plan\s*/, "") || "请调查当前项目并制定实施计划。"; }
      run(activeThreadId, value, attachments, { mode });
    },
    [run, activeThreadId, setPrompt],
  );

  /**
   * 追问：把该条消息包成引用填进输入框，并把光标落过去。
   *
   * 输入框里已有的内容保留在引用之后、不被覆盖——用户可能已经写了一半，
   * 引用只是补充上下文，不该把他写的东西冲掉。
   */
  const handleFollowUp = useCallback((message: Message) => {
    setPrompt((current) => {
      const quote = messageQuote(message);
      return current.trim().length > 0 ? `${quote}${current}` : quote;
    });
    setFocusSignal((value) => value + 1);
  }, [setPrompt]);

  /** Regeneration replaces the selected turn atomically and stores previous answers as alternatives. */
  const handleRegenerate = useCallback(
    (userMessage: Message) => {
      const text = messagePlainText(userMessage);
      const attachments = userMessage.attachments ?? [];
      void run(activeThreadId, text, attachments, { mode: "run", regenerateFrom: userMessage.id });
    },
    [activeThreadId, run],
  );

  return (
    <div className="main-body">
      <SessionHeader />
      {notice ? <div className="session-status" role="status">{notice}<button className="btn btn--ghost btn--sm" onClick={() => useAppStore.setState((s) => ({ sessionNotices: { ...s.sessionNotices, [activeThreadId]: undefined } }))}>关闭</button></div> : null}
      {messages === undefined ? <div className="panel-empty" role={loadError ? "alert" : "status"}>{loadError ? <>读取会话失败：{loadError}<button className="btn btn--sm" onClick={() => void ensureLoaded(activeThreadId).catch(() => {})}>重试读取</button></> : "正在读取会话正文…"}</div> : <>
      <ConversationStream
        key={`stream:${activeThreadId}`}
        onPromptChange={setPrompt}
        onSubmit={handleSubmit}
        onFollowUp={handleFollowUp}
        onRegenerate={handleRegenerate}
      />
      <TaskPanel />
      <Composer
        key={`composer:${activeThreadId}`}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSubmit={handleSubmit}
        onStop={stop}
        isRunning={isRunning}
        queuedCount={threadRunState?.queuedCount ?? 0}
        queuedItems={threadRunState?.queuedItems ?? []}
        onCancelQueued={(requestId) => cancelQueuedRequest(activeThreadId, requestId)}
        focusSignal={focusSignal}
      />
      </>}
    </div>
  );
}
