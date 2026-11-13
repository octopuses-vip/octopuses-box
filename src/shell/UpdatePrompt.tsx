import { useEffect } from "react";

import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { formatBytes } from "../model/attachments";

/** 手动检查更新的结果提示停留时长（毫秒），到时自动消失，不挡住后续操作 */
const NOTICE_DURATION_MS = 3200;

/**
 * 启动时检查到新版本后弹出的更新提示（开发者 Jan）。
 *
 * 数据来自免登录的更新检查接口：展示最新版本号、当前版本、安装包大小、发布时间与更新说明，
 * 并给出更新入口。点「立即更新」后由客户端自行下载安装包（不弹浏览器），下载完成即启动
 * 独立的更新进程并退出客户端，安装与重启由该子进程完成，因此这里展示下载进度与交接提示。
 *
 * 被管理员标记为强制更新、或正在下载安装包时都不提供关闭入口：前者不允许继续使用旧版本，
 * 后者中途关闭会留下残缺的安装包，界面此时不给「稍后再说」也不响应点击遮罩。
 */
export function UpdatePrompt() {
  const info = useAppStore((state) => state.updateInfo);
  const dismissed = useAppStore((state) => state.updatePromptDismissed);
  const dismissUpdatePrompt = useAppStore((state) => state.dismissUpdatePrompt);
  const installStatus = useAppStore((state) => state.updateInstallStatus);
  const progress = useAppStore((state) => state.updateDownloadProgress);
  const installError = useAppStore((state) => state.updateInstallError);
  const installUpdate = useAppStore((state) => state.installUpdate);

  // 没有更新、或用户已经关掉这次提示时什么都不渲染
  if (!info?.hasUpdate || dismissed) return null;

  const busy = installStatus === "downloading" || installStatus === "installing";
  const close = info.forceUpdate || busy ? undefined : dismissUpdatePrompt;
  const percent = progress?.percent ?? 0;

  return (
    <div className="overlay overlay--center" onMouseDown={close}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="发现新版本"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="modal__title">发现新版本 {info.latestVersion}</span>
          {info.forceUpdate ? <span className="badge badge--warn">强制更新</span> : null}
        </div>
        <div className="modal__meta">
          <span>当前版本 {info.currentVersion}</span>
          {info.fileSize > 0 ? <span>安装包 {formatBytes(info.fileSize)}</span> : null}
          {info.publishedAt ? <span>发布于 {info.publishedAt}</span> : null}
        </div>
        <div className="modal__body">{info.description || "该版本未提供更新说明。"}</div>

        {installStatus === "downloading" ? (
          <>
            <div className="progress">
              <div className="progress__bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="modal__hint">
              正在下载安装包 {progress?.total ? `${percent}%` : formatBytes(progress?.downloaded ?? 0)}
            </div>
          </>
        ) : null}
        {installStatus === "installing" ? (
          <div className="modal__hint">安装包已就绪，正在退出客户端，由更新进程完成安装并重新启动。</div>
        ) : null}
        {installError ? <div className="modal__error">{installError}</div> : null}

        <div className="modal__foot">
          {close ? (
            <button type="button" className="btn btn--ghost" onClick={close}>
              稍后再说
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !info.downloadUrl}
            onClick={() => void installUpdate()}
          >
            {installStatus === "downloading" ? "下载中…" : installStatus === "installing" ? "安装中…" : "立即更新"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 手动「检查更新」的结果提示（开发者 Jan）。
 *
 * 托盘菜单里的「检查更新」是用户主动发起的，必须有明确反馈：查到新版本由上方的更新弹窗承担，
 * 这里负责「已是最新版本 / 检查失败」这类一次性结果。启动时的自动检查不写这条提示，
 * 因此只有用户真的点了菜单才会出现，几秒后自动消失。
 */
export function UpdateNotice() {
  const notice = useAppStore((state) => state.updateCheckNotice);
  const clearNotice = useAppStore((state) => state.clearUpdateCheckNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clearNotice, NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  if (!notice) return null;
  return (
    <div className="toast" role="status">
      <Icon name="info" size={14} />
      <span>{notice}</span>
    </div>
  );
}
