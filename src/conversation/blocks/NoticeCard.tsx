import { Icon } from "../../components/Icon";

interface NoticeCardProps {
  /** 提示语气：warn 用于「运行被上限截停」，info 用于一般说明 */
  tone: "warn" | "info";
  text: string;
}

/**
 * 系统提示卡片（开发者 Jan）。
 *
 * 用于「运行被上限截停」这类需要用户明确看到、但不属于模型回答的说明：
 * 以前这类结束被当作成功静默收尾，会话看上去就只是「莫名停下」。
 */
export function NoticeCard({ tone, text }: NoticeCardProps) {
  return (
    <div className={tone === "warn" ? "notice-card notice-card--warn" : "notice-card"}>
      <span className="notice-card__icon">
        <Icon name={tone === "warn" ? "alert" : "info"} size={14} />
      </span>
      <span className="notice-card__text">{text}</span>
    </div>
  );
}
