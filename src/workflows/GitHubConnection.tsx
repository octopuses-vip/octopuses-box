import { useState } from "react";
import { copyText, openExternal } from "../app/desktop/system";
import { checkGitHubConnection, type GitHubConnectionStatus } from "../app/desktop/workflows";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";

export function GitHubConnection() {
  const [status, setStatus] = useState<GitHubConnectionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setChecking(true);
    setError("");
    try {
      setStatus(await checkGitHubConnection());
    } catch (error) {
      setStatus(null);
      setError(String(error));
    } finally {
      setChecking(false);
    }
  }

  async function copyLogin(command: string) {
    const copied = await copyText(command);
    if (!copied) {
      setError("无法复制命令，可以从上方选中并复制。");
      return;
    }
    setError("");
    useAppStore.getState().showNotice("已复制 GitHub 登录命令");
  }

  return (
    <details className="disclosure inspector-account">
      <summary>GitHub 连接<Icon name="chevron-down" size={11} /></summary>
      <p className="inspector-caption">客户端复用 GitHub CLI 的登录状态。可先检查账号，再选择 GitHub 仓库查看 PR。</p>
      <div className="action-row">
        <button type="button" className="btn btn--sm" disabled={checking} onClick={() => void check()}>
          {checking ? "正在检查…" : "检查连接"}
        </button>
        {status?.state === "missing" && (
          <button type="button" className="quiet-action" onClick={() => void openExternal("https://cli.github.com/").catch((err) => setError(String(err)))}>
            安装 GitHub CLI<Icon name="external" size={12} />
          </button>
        )}
      </div>
      {status && <p className="inspector-caption" role="status">{status.text}</p>}
      {status?.loginCommand && (
        <div className="inspector-stack">
          <p className="inspector-caption">在终端运行此命令并完成浏览器授权，回来后重新检查连接。</p>
          <pre className="workflow-output">{status.loginCommand}</pre>
          <div className="action-row">
            <button type="button" className="btn btn--sm" onClick={() => void copyLogin(status.loginCommand!)}>复制登录命令</button>
            <button type="button" className="quiet-action" onClick={() => useAppStore.setState({ terminalOpen: true })}>打开终端</button>
          </div>
        </div>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </details>
  );
}
