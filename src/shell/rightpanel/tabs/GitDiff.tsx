import { useEffect, useState } from "react";

import { copyText } from "../../../app/desktop/system";
import { effectiveWorkspacePath } from "../../../app/state/workspace";
import { useAppStore } from "../../../app/state";
import { DiffView } from "../../../components/DiffView";
import { Icon } from "../../../components/Icon";

/** 差异 tab（开发者 Jan）：展示当前工作区的改动，并提供暂存 / 取消暂存 / 提交 / 推送入口 */
export function GitDiff() {
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const diffFiles = useAppStore((state) => state.diffFiles);
  const status = useAppStore((state) => state.gitDiffStatus);
  const error = useAppStore((state) => state.gitDiffError);
  const gitInfo = useAppStore((state) => state.gitInfo);
  const gitStatus = useAppStore((state) => state.gitStatus);
  const result = useAppStore((state) => state.gitActionResult);
  const actionError = useAppStore((state) => state.gitActionError);
  const loadGitDiff = useAppStore((state) => state.loadGitDiff);
  const refreshGit = useAppStore((state) => state.refreshGit);
  const stageChanges = useAppStore((state) => state.stageChanges);
  const unstageChanges = useAppStore((state) => state.unstageChanges);
  const commitChanges = useAppStore((state) => state.commitChanges);
  const pushChanges = useAppStore((state) => state.pushChanges);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

/** 函数级说明（开发者 Jan）：执行 refresh 的单一职责，并返回可供调用方继续处理的结果。 */
  const refresh = async () => {
    await Promise.all([refreshGit(), loadGitDiff()]);
  };

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      // store 统一展示错误
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!workspacePath) return;
    void Promise.all([refreshGit(), loadGitDiff()]);
  }, [workspacePath, refreshGit, loadGitDiff]);

  const protectedBranch = gitInfo?.branch === "main" || gitInfo?.branch === "master";

  return (
    <div>
      <div className="panel-actions">
        <Icon name="branch" size={13} />
        <span className="muted">
          {gitInfo?.branch ?? "未识别分支"} · {gitInfo?.clean ? "干净" : `${gitInfo?.status.length ?? 0} 项改动`}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm"
          disabled={status === "loading" || gitStatus === "loading" || busy}
          onClick={() => void refresh()}
        >
          {status === "loading" || gitStatus === "loading" ? "读取中…" : "刷新"}
        </button>
      </div>

      {gitInfo?.status.length ? (
        <div style={{ padding: "8px 12px", display: "grid", gap: 6 }}>
          {gitInfo.status.map((entry) => {
            const displayPath = entry.slice(3).trim();
            const renameSeparator = displayPath.lastIndexOf(" -> ");
            const path = renameSeparator >= 0
              ? displayPath.slice(renameSeparator + 4)
              : displayPath;
            const indexStatus = entry[0];
            const worktreeStatus = entry[1];
            const hasStaged = indexStatus !== " " && indexStatus !== "?";
            const hasUnstaged = worktreeStatus !== " " || indexStatus === "?";
            return (
              <div key={entry} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code>{entry.slice(0, 2)}</code>
                {/*
                  改动路径可能是很深的绝对路径，压成单行省略号；
                  注意 `textOverflow` 必须与 `whiteSpace: nowrap` 同时出现才会生效，
                  否则文字会折行、`overflow: hidden` 只是把后续行裁掉，看不到省略号。
                */}
                <span
                  style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                >
                  {displayPath}
                </span>
                <span className="spacer" />
                {hasStaged ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => void perform(() => unstageChanges(path))}
                  >
                    取消暂存
                  </button>
                ) : null}
                {hasUnstaged ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => void perform(() => stageChanges(path))}
                  >
                    暂存
                  </button>
                ) : null}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void perform(() => unstageChanges())}>
              全部取消暂存
            </button>
            <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void perform(() => stageChanges())}>
              全部暂存
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ padding: "8px 12px", display: "grid", gap: 8 }}>
        <input
          className="diff-comment__input"
          value={message}
          placeholder="输入提交信息后显式提交"
          onChange={(event) => setMessage(event.target.value)}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy || message.trim().length === 0}
            onClick={() => void perform(async () => {
              await commitChanges(message);
              setMessage("");
            })}
          >
            提交
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || protectedBranch || !gitInfo?.branch}
            title={protectedBranch ? "禁止直接推送 main/master" : "推送当前分支"}
            onClick={() => void perform(pushChanges)}
          >
            推送
          </button>
          {gitInfo?.compareUrl ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void copyText(gitInfo.compareUrl ?? "").then(setCopied)}
            >
              {copied ? "已复制" : "复制 Compare URL"}
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? <div className="panel-empty">Git 操作失败：{actionError}</div> : null}
      {result ? (
        <div style={{ padding: "8px 12px" }}>
          <code>{result.command}</code>
          {result.stdout.trim() ? <pre>{result.stdout}</pre> : null}
          {result.stderr.trim() ? <pre>{result.stderr}</pre> : null}
          <div className="muted">退出码：{result.exitCode}</div>
        </div>
      ) : null}
      {error ? <div className="panel-empty">读取项目差异失败：{error}</div> : null}
      {!error && diffFiles.length === 0 && status === "ready" ? (
        <div className="panel-empty">当前工作区没有未提交的改动</div>
      ) : null}
      {diffFiles.length > 0 ? <DiffView files={diffFiles} allowComments /> : null}
    </div>
  );
}
