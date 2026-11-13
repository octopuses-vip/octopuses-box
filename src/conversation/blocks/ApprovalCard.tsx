import { Icon } from "../../components/Icon";

interface ApprovalCardProps {
  command: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  /** 是否在「全部自动」档下放行 */
  auto: boolean;
  /** 用户是否已撤销该次自动批准 */
  revoked?: boolean;
  /** 卡片来自子代理时标注其标题：镜像到当前会话时，用于区分是哪个子代理在等审批 */
  source?: string;
  onDecision: (approved: boolean) => void;
  /** 撤销自动批准：把该命令模式加入不再自动通过的名单 */
  onRevoke: () => void;
}

const STATUS_TEXT: Record<ApprovalCardProps["status"], string> = {
  pending: "等待审批",
  approved: "已允许",
  denied: "已拒绝",
  expired: "已失效",
};

/** 独立于模型追问的系统命令审批卡片。 */
export function ApprovalCard({
  command,
  reason,
  status,
  auto,
  revoked,
  source,
  onDecision,
  onRevoke,
}: ApprovalCardProps) {
  const autoApproved = auto && !revoked && status === "approved";
  const title = autoApproved ? "已自动允许执行" : "命令执行审批";
  const statusText = autoApproved ? "已自动允许" : STATUS_TEXT[status];

  return (
    <div className="approval-card">
      <div className="approval-card__head">
        <span className="approval-card__icon">
          <Icon name={source ? "cube" : "terminal"} size={14} />
        </span>
        <span className="approval-card__title">{title}</span>
        <span className="spacer" />
        <span className="approval-card__meta">{statusText}</span>
      </div>
      <pre className="approval-card__command">$ {command}</pre>
      {source ? (
        <div className="approval-card__reason">来自子代理「{source}」：点选后该子代理继续执行。</div>
      ) : null}
      <div className="approval-card__reason">{reason}</div>
      {status === "pending" ? (
        <div className="approval-card__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDecision(false)}>
            拒绝
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => onDecision(true)}>
            允许并执行
          </button>
        </div>
      ) : null}
      {autoApproved ? (
        <div className="approval-card__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRevoke}>
            撤销并改为手动
          </button>
        </div>
      ) : null}
      {revoked ? (
        <div className="approval-card__reason">已撤销自动批准，同类命令后续一律转人工确认。</div>
      ) : null}
      {status === "expired" ? (
        <div className="approval-card__reason">应用已刷新，原运行无法续接，请重新发起任务。</div>
      ) : null}
    </div>
  );
}
