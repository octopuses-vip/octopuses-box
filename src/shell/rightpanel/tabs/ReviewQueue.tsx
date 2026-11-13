import { selectActiveThread } from "../../../app/storeSelectors";
import { useAppStore } from "../../../app/state";
import { useAgentRun } from "../../../hooks/useAgentRun";

/**
 * 把未解决的审阅意见拼成一段反馈提示词（开发者 Jan）：带上文件、行号与上下文，便于模型定位。
 */
function reviewPrompt(comments: NonNullable<ReturnType<typeof selectActiveThread>>["reviewComments"]) {
  const details = comments.map((comment) =>
    `- ${comment.path}:${comment.line} (${comment.side})\n  上下文：${comment.context}\n  审阅意见：${comment.text}`,
  );
  return `请根据以下未解决的代码审阅意见继续修复当前工作区。逐项处理，完成后说明修改和验证结果：\n\n${details.join("\n")}`;
}

/**
 * 右栏「审阅」页签（开发者 Jan）：列出当前会话未解决的代码审阅意见，可逐条标记解决 / 删除，
 * 或一键把全部意见交给 Agent 继续修复。
 *
 * 只按当前会话是否繁忙禁用按钮：别的会话在跑不影响本会话反馈意见。
 */
export function ReviewQueue() {
  const thread = useAppStore(selectActiveThread);
  const runState = useAppStore((state) =>
    state.threadRunStates[state.activeThreadId],
  );
  const resolveReviewComment = useAppStore((state) => state.resolveReviewComment);
  const deleteReviewComment = useAppStore((state) => state.deleteReviewComment);
  const { run } = useAgentRun();
  const comments = thread?.reviewComments.filter((comment) => !comment.resolved) ?? [];
  // 只按当前会话是否繁忙禁用：别的会话在跑不影响本会话反馈意见
  const running = Boolean(runState && runState.status !== "idle");

  if (!thread || comments.length === 0) {
    return <div className="panel-empty">当前会话没有未解决的审阅意见</div>;
  }

  return (
    <div>
      <div className="panel-actions">
        <span className="muted">{comments.length} 条未解决意见</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={running}
          onClick={() => void run(thread.id, reviewPrompt(comments), [])}
        >
          反馈给 Agent 修复
        </button>
      </div>
      <div style={{ display: "grid", gap: 10, padding: 12 }}>
        {comments.map((comment) => (
          <div key={comment.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 600 }}>{comment.path}:{comment.line}</div>
            <div className="muted" style={{ marginTop: 4 }}>{comment.side} · {comment.context}</div>
            <div style={{ marginTop: 8 }}>{comment.text}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn btn--sm" onClick={() => resolveReviewComment(comment.id, true)}>
                标记已解决
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => deleteReviewComment(comment.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
