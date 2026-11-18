import type { PlanStep } from "./store";
import { Icon } from "../components/Icon";
/** A plan belongs to the assistant's turn, retaining earlier snapshots in conversation history. */
export function PlanCard({ steps }: { steps: PlanStep[] }) {
  const completed = steps.filter((s) => s.status === "completed").length;
  return <details className="plan-card" open={completed < steps.length}>
    <summary><Icon name="clipboard-check" size={15} /><span>计划</span><span className="plan-card__count">{completed} / {steps.length}</span><Icon name="chevron-down" size={12} /></summary>
    <ol>{steps.map((step, i) => <li key={i} className={`plan-step plan-step--${step.status}`}><span className="plan-step__mark">{step.status === "completed" ? <Icon name="check" size={12} /> : step.status === "in_progress" ? <span className="status-dot status-dot--active" /> : <span className="plan-step__number">{i + 1}</span>}</span><span>{step.step}</span>{step.status === "in_progress" && <span className="plan-step__label">进行中</span>}</li>)}</ol>
  </details>;
}
