import { useState } from "react";

import { copyText } from "../../app/desktop/system";
import { useAppStore } from "../../app/state";
import type { Thread } from "../../app/types";
import { Icon } from "../../components/Icon";
import { threadTranscript } from "../../conversation/transcript";
import { stopThreadRun } from "../../hooks/useAgentRun";
import { sessionMessages } from "../../cache/conversationSnapshot";

interface ThreadListProps {
  threads: Thread[];
  activeThreadId: string;
  onSelect: (id: string) => void;
  /** 列表为空时的占位文案：项目下是「暂无任务」，会话记录里是「暂无会话」 */
  emptyText?: string;
}

/** 会话列表（开发者 Jan）：按项目分组展示，支持切换、重命名、复制与删除 */
export function ThreadList({
  threads,
  activeThreadId,
  onSelect,
  emptyText = "暂无任务",
}: ThreadListProps) {
  const renameThread = useAppStore((state) => state.renameThread);
  const deleteThread = useAppStore((state) => state.deleteThread);
  const threadRunStates = useAppStore((state) => state.threadRunStates);
  /** 刚复制完成的会话 id：用于把按钮临时换成对勾，给出「已复制」反馈 */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 正在重命名的会话 id 与草稿标题 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  /** 已点过一次删除、等待二次确认的会话 id */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

/** 函数级说明（开发者 Jan）：执行 handleCopy 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleCopy = async (thread: Thread) => {
    setCopyError(null);
    const state = useAppStore.getState();
    let messages;
    try { messages = state.cachePath ? await sessionMessages(state.cachePath, thread.id, state.messages[thread.id]) : state.messages[thread.id] ?? []; }
    catch (error) { setCopyError(`复制失败：${String(error)}`); return; }
    const ok = await copyText(threadTranscript(thread, messages));
    if (!ok) return;
    setCopiedId(thread.id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === thread.id ? null : current));
    }, 1600);
  };

/** 函数级说明（开发者 Jan）：执行 startRename 的单一职责，并返回可供调用方继续处理的结果。 */
  const startRename = (thread: Thread) => {
    setRenamingId(thread.id);
    setDraftTitle(thread.title);
    setConfirmDeleteId(null);
  };

/** 函数级说明（开发者 Jan）：执行 commitRename 的单一职责，并返回可供调用方继续处理的结果。 */
  const commitRename = (id: string) => {
    renameThread(id, draftTitle);
    setRenamingId(null);
  };

  if (threads.length === 0) {
    return <div className="sidebar__empty">{emptyText}</div>;
  }

  return (
    <div className="thread-list">
      {copyError ? <p role="alert">{copyError}</p> : null}
      {threads.map((thread) => {
        const copied = thread.id === copiedId;
        const renaming = thread.id === renamingId;
        const confirming = thread.id === confirmDeleteId;
        // 该任务此刻是否正在跑：跑着就要在行上常驻一个停止入口，切走会话也能终止
        const isRunning = threadRunStates[thread.id]?.status === "running";
        return (
          <div
            key={thread.id}
            className={[
              "thread-item",
              thread.id === activeThreadId ? "thread-item--active" : "",
              isRunning ? "thread-item--running" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {renaming ? (
              <input
                className="thread-item__rename"
                value={draftTitle}
                autoFocus
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(thread.id);
                  if (event.key === "Escape") setRenamingId(null);
                }}
                onBlur={() => commitRename(thread.id)}
              />
            ) : (
              <button
                type="button"
                className="thread-item__open"
                aria-current={thread.id === activeThreadId ? "true" : undefined}
                title={thread.title}
                onClick={() => onSelect(thread.id)}
              >
                {/* 会话行的记号：与项目的文件夹图标同处一列，但仍能一眼区分是「任务」还是「项目」 */}
                <span className="thread-item__icon">
                  <Icon name="message" size={13} />
                </span>
                <span className="thread-item__body">
                  <span className="thread-item__title">{thread.title}</span>
                  <span className="thread-item__meta">
                    <span>{thread.updatedAtLabel}</span>
                  </span>
                </span>
              </button>
            )}
            {isRunning ? (
              /*
                停止入口（开发者 Jan）：常驻在行末，不靠悬停出现。
                运行状态是按会话记录的，切到别的任务后输入区的停止按钮就没了，
                没有这个入口，后台跑着的任务就只能等它自己结束。
              */
              <button
                type="button"
                className="thread-item__stop"
                aria-label={`停止任务 ${thread.title}`}
                title="停止运行"
                onClick={() => stopThreadRun(thread.id)}
              >
                <Icon name="stop" size={13} />
              </button>
            ) : null}
            {renaming ? null : (
              <div className="thread-item__actions">
                <button
                  type="button"
                  className="thread-item__copy"
                  aria-label="复制对话内容"
                  title={copied ? "已复制到剪贴板" : "复制对话内容"}
                  onClick={() => void handleCopy(thread)}
                >
                  <Icon name={copied ? "clipboard-check" : "copy"} size={13} />
                </button>
                <button
                  type="button"
                  className="thread-item__copy"
                  aria-label="重命名对话"
                  title="重命名"
                  onClick={() => startRename(thread)}
                >
                  <Icon name="pencil" size={13} />
                </button>
                <button
                  type="button"
                  className={confirming ? "thread-item__danger" : "thread-item__copy"}
                  aria-label="删除对话"
                  title={confirming ? "再点一次确认删除" : "删除"}
                  onClick={() => {
                    if (confirming) {
                      deleteThread(thread.id);
                      setConfirmDeleteId(null);
                      return;
                    }
                    setConfirmDeleteId(thread.id);
                  }}
                  onBlur={() =>
                    setConfirmDeleteId((current) => (current === thread.id ? null : current))
                  }
                >
                  {confirming ? (
                    <span className="thread-item__danger-text">删除?</span>
                  ) : (
                    <Icon name="trash" size={13} />
                  )}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
