import { Icon } from "../components/Icon";
export interface PullDetail {
  number: number; title: string; body?: string; headRefName?: string; baseRefName?: string;
  files?: { path: string; additions: number; deletions: number }[];
  comments?: { author?: { login?: string }; body: string }[];
  reviews?: { author?: { login?: string }; body: string; state?: string }[];
  statusCheckRollup?: { name?: string; context?: string; conclusion?: string; state?: string }[];
}
const RESULTS: Record<string, string> = { SUCCESS: "通过", FAILURE: "失败", ERROR: "错误", CANCELLED: "已取消", SKIPPED: "已跳过", PENDING: "等待中", IN_PROGRESS: "运行中", COMPLETED: "已完成", NEUTRAL: "中立" };
/** Human-readable check results, changed files and review discussion. */
export function PullDetails({ value }: { value: PullDetail }) {
  return <section className="pull-detail">
    <span className="pull-detail__number">#{value.number}</span><h3>{value.title}</h3>
    {value.headRefName && <div className="pull-branches"><Icon name="branch" size={13} /><code>{value.headRefName}</code><span>→</span><code>{value.baseRefName}</code></div>}
    {value.body && <p className="pull-detail__body">{value.body}</p>}
    {Boolean(value.statusCheckRollup?.length) && <section className="check-list"><h4>检查</h4>{value.statusCheckRollup?.map((check, i) => { const status = check.conclusion || check.state || "PENDING"; const ok = status === "SUCCESS"; const fail = ["FAILURE", "ERROR", "TIMED_OUT"].includes(status); return <div className={`check-result ${ok ? "check-result--success" : fail ? "check-result--error" : ""}`} key={i}><Icon name={ok ? "check" : fail ? "close" : "clock"} size={14} /><span>{check.name || check.context || "检查"}</span><small>{RESULTS[status] || status}</small></div>; })}</section>}
    {Boolean(value.files?.length) && <details className="disclosure" open><summary>修改文件 <span>{value.files?.length}</span><Icon name="chevron-down" size={11} /></summary>{value.files?.map((file) => <div className="changed-file" key={file.path}><Icon name="file" size={13} /><span title={file.path}>{file.path}</span><small className="diff-line--add">+{file.additions}</small><small className="diff-line--del">−{file.deletions}</small></div>)}</details>}
    {[...(value.comments ?? []), ...(value.reviews ?? [])].map((comment, i) => <article className="review-comment" key={i}><strong>{comment.author?.login || "GitHub"}</strong><p>{comment.body}</p></article>)}
  </section>;
}
