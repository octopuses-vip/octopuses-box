import { formatTokens } from "../../app/storeSelectors";
import type { TokenUsage } from "../../app/types";
import { Icon } from "../../components/Icon";

interface UsageCardProps {
  model: string;
  usage: TokenUsage;
  /** 本轮运行里实际发起的模型请求轮数 */
  rounds: number;
}

/**
 * 一次运行的 token 用量明细（开发者 Jan）。
 *
 * 数字全部来自模型服务回传的 `usage`，不做本地估算；因为一次运行可能因为工具调用分多轮请求，
 * 输入侧是各轮之和，`rounds` 用来说明这一点，避免用户把它当成单次上下文长度。
 *
 * 排版压成一行：用量是运行结束后的补充信息，不该在对话流里占掉一块版面。
 * 各档数字横排、字号统一到最小一档，「N 轮请求合计」与「已计入输出」这类解释退到悬停提示，
 * 正文只留数字本身。窄窗口下靠换行兜底，不做横向滚动。
 */
export function UsageCard({ model, usage, rounds }: UsageCardProps) {
  const rows: { label: string; value: number; hint?: string }[] = [
    { label: "输入", value: usage.promptTokens, hint: rounds > 1 ? `${rounds} 轮请求合计` : undefined },
    { label: "输出", value: usage.completionTokens },
    {
      label: "思考",
      value: usage.reasoningTokens,
      hint: usage.reasoningTokens > 0 ? "已计入输出" : undefined,
    },
    { label: "合计", value: usage.totalTokens },
  ];

  return (
    <div className="usage-card">
      <span className="usage-card__icon">
        <Icon name="sparkles" size={12} />
      </span>
      <span className="usage-card__title">本轮用量</span>
      {rows.map((row) => (
        <span
          className="usage-card__item"
          key={row.label}
          // 悬停给出精确 token 数与这档数字的口径说明，正文因此可以只放缩写
          title={row.hint ? `${row.hint} · ${row.value} tokens` : `${row.value} tokens`}
        >
          <span className="usage-card__label">{row.label}</span>
          <span className="usage-card__value">{formatTokens(row.value)}</span>
        </span>
      ))}
      <span className="spacer" />
      <span className="usage-card__meta">{model}</span>
    </div>
  );
}