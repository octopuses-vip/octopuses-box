import { useState } from "react";

import { APP_NAME } from "../app/meta";
import { selectActiveThread } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import type { DiffFile, DiffLine } from "../app/types";
import { Icon } from "./Icon";

interface DiffViewProps {
  files: DiffFile[];
  /** 是否显示「暂存 / 撤销」操作行 */
  showActions?: boolean;
  /** 是否允许在 diff 上添加行内评论 */
  allowComments?: boolean;
}

/**
 * 计算差异行的稳定身份（开发者 Jan）：行号 + 所属侧。
 *
 * 评论要挂在具体某一行上，因此需要一行一个稳定 key；新增行用新侧行号、
 * 删除行用旧侧行号，上下文行两侧行号都存在时优先取新侧，保证同一行在多次渲染间不会换身份。
 */
function lineIdentity(line: DiffLine, index: number) {
  const side = line.kind === "add" ? "new" : line.kind === "del" ? "old" : "context";
  return {
    line: line.newNo ?? line.oldNo ?? index + 1,
    side,
  } as const;
}

/**
 * 渲染单个文件的差异块（开发者 Jan），并承载该文件上的行级评论交互。
 *
 * 评论随会话持久化，因此这里把「新增 / 解决 / 删除」三个动作都接到 store；
 * allowComments 为 false 时只读展示（如回答附近的改动摘要不需要评论入口）。
 */
function DiffFileBlock({ file, allowComments }: { file: DiffFile; allowComments: boolean }) {
  const thread = useAppStore(selectActiveThread);
  const addReviewComment = useAppStore((state) => state.addReviewComment);
  const resolveReviewComment = useAppStore((state) => state.resolveReviewComment);
  const deleteReviewComment = useAppStore((state) => state.deleteReviewComment);
  const [draftTarget, setDraftTarget] = useState<{ line: number; side: "old" | "new" | "context"; context: string } | null>(null);
  const [draft, setDraft] = useState("");
  const comments = thread?.reviewComments.filter((comment) => comment.path === file.path) ?? [];

/** 函数级说明（开发者 Jan）：执行 submitComment 的单一职责，并返回可供调用方继续处理的结果。 */
  const submitComment = () => {
    if (!draftTarget || draft.trim().length === 0) return;
    addReviewComment({
      path: file.path,
      line: draftTarget.line,
      side: draftTarget.side,
      context: draftTarget.context,
      text: draft.trim(),
    });
    setDraft("");
    setDraftTarget(null);
  };

  return (
    <div>
      <div className="diff-file__head">
        <Icon name="file" size={13} />
        <span>{file.path}</span>
        <span className="diff-file__stat">
          <span className="stat-add">+{file.additions}</span>
          <span className="stat-del">-{file.deletions}</span>
        </span>
      </div>
      <div>
        {file.lines.map((line, index) => {
          const identity = lineIdentity(line, index);
          const lineComments = comments.filter(
            (comment) => comment.line === identity.line && comment.side === identity.side,
          );
          const drafting =
            draftTarget?.line === identity.line && draftTarget.side === identity.side;
          return (
            <div key={`${file.path}-${index}`}>
              <div
                className={`diff-line diff-line--${line.kind}`}
                onDoubleClick={() => {
                  if (!allowComments) return;
                  setDraftTarget({ ...identity, context: line.text });
                }}
                title={allowComments ? "双击添加行评论" : undefined}
              >
                <span className="diff-line__no">{line.oldNo ?? ""}</span>
                <span className="diff-line__no">{line.newNo ?? ""}</span>
                <span className="diff-line__sign">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                <span className="diff-line__text">{line.text}</span>
              </div>
              {allowComments && drafting ? (
                <div className="diff-comment">
                  <input
                    className="diff-comment__input"
                    autoFocus
                    value={draft}
                    placeholder={`对该行留评论，${APP_NAME} 会在下一轮处理`}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitComment();
                      if (event.key === "Escape") setDraftTarget(null);
                    }}
                  />
                  <button type="button" className="btn btn--sm" onClick={submitComment}>
                    添加
                  </button>
                </div>
              ) : null}
              {lineComments.map((comment) => (
                <div className="diff-comment" key={comment.id}>
                  <span className="avatar avatar--sm">J</span>
                  <span style={{ textDecoration: comment.resolved ? "line-through" : undefined }}>
                    {comment.text}
                  </span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => resolveReviewComment(comment.id, !comment.resolved)}
                  >
                    {comment.resolved ? "恢复" : "解决"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => deleteReviewComment(comment.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {allowComments ? (
        <div style={{ padding: "6px 12px 10px" }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              const index = file.lines.findIndex((line) => line.kind !== "ctx");
              const targetIndex = index >= 0 ? index : 0;
              const line = file.lines[targetIndex];
              if (!line) return;
              setDraftTarget({ ...lineIdentity(line, targetIndex), context: line.text });
            }}
          >
            在改动处添加评论
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 差异总视图（开发者 Jan）：顶部汇总增删行数，下面逐文件渲染差异块。
 *
 * 无改动时直接给出「当前没有待查看的改动」空态，避免渲染一个空容器。
 */
export function DiffView({ files, showActions = false, allowComments = false }: DiffViewProps) {
  if (files.length === 0) {
    return <div className="panel-empty">当前没有待查看的改动</div>;
  }

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div>
      {showActions ? (
        <div className="panel-actions">
          <Icon name="branch" size={13} />
          <span className="muted">{files.length} 个文件</span>
          <span className="stat-add">+{additions}</span>
          <span className="stat-del">-{deletions}</span>
        </div>
      ) : null}
      {files.map((file) => (
        <DiffFileBlock key={file.path} file={file} allowComments={allowComments} />
      ))}
    </div>
  );
}
