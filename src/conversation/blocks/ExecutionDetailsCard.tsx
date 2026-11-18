import { memo } from "react";
import type { ExecutionDetails } from "../../app/types";
import { VIDEO_TOOL_NAME } from "../../video/protocol";

const statuses = { running: "执行中", success: "成功", error: "失败", skipped: "跳过", failed: "失败", aborted: "已中断" };
const reasons: Record<string, string> = {
  disabled: "已禁用", not_reached: "未到达", ask_user_priority: "优先追问", completed: "正常完成",
  maxRounds: "轮数上限", timeBudget: "时长上限", tokenBudget: "token 上限", userInterrupted: "用户中断", error: "运行出错",
};

/** 默认折叠的运行事实；只读该轮消息快照，当前选择变化不影响历史。 */
export const ExecutionDetailsCard = memo(function ExecutionDetailsCard({ details }: { details: ExecutionDetails }) {
  const reasonText = (reason?: string) => reason ? reasons[reason] ?? reason : "";
  return (
    <details style={{ fontSize: 12, opacity: 0.8, margin: "8px 0", overflowWrap: "anywhere" }}>
      <summary style={{ cursor: "pointer" }}>执行详情 · {statuses[details.outcome]}</summary>
      <div style={{ display: "grid", gap: 6, padding: "10px 0 4px 16px" }}>
        <div>实际 Agent：{details.agentName}（{details.agentId}）{details.selectedAgentId && details.selectedAgentId !== details.agentId ? `；选中：${details.selectedAgentId}` : ""}</div>
        <div>期望模型：{details.requestedModel ?? "未配置"} · 实际模型（请求）：{details.actualModel ?? "不可用"}</div>
        {details.fallbackReason ? <div>回退原因：{details.fallbackReason}</div> : null}
        {details.stopReason ? <div>结束原因：{reasonText(details.stopReason)}</div> : null}
        {details.tools.map((tool) => <div key={tool.callId}>
          工具 {tool.name}：{tool.name === VIDEO_TOOL_NAME && tool.status === "success" ? "已提交" : statuses[tool.status]}{tool.reason ? ` · ${reasonText(tool.reason)}` : ""}
        </div>)}
      </div>
    </details>
  );
});
