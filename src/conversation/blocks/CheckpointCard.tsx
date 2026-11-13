import { Icon } from "../../components/Icon";

interface CheckpointCardProps {
  status: "ready" | "rollingBack" | "rolledBack" | "error";
  detail: string;
  onRollback: () => void;
}

const STATUS_TEXT: Record<CheckpointCardProps["status"], string> = {
  ready: "可撤销",
  rollingBack: "正在撤销",
  rolledBack: "已撤销",
  error: "撤销失败",
};

/** 展示写入前检查点，并提供当前项目内的真实回滚入口（开发者 Jan）。 */
export function CheckpointCard({ status, detail, onRollback }: CheckpointCardProps) {
  return (
    <div className="checkpoint-card">
      <div className="checkpoint-card__head">
        <span className="checkpoint-card__icon">
          <Icon name="diff" size={14} />
        </span>
        <span className="checkpoint-card__title">本轮修改检查点</span>
        <span className="spacer" />
        <span className="checkpoint-card__meta">{STATUS_TEXT[status]}</span>
      </div>
      <div className="checkpoint-card__detail">{detail}</div>
      {status === "ready" || status === "error" ? (
        <div className="checkpoint-card__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRollback}>
            撤销本轮修改
          </button>
        </div>
      ) : null}
    </div>
  );
}
