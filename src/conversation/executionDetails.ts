import type { ExecutionDetails } from "../app/types";
import type { ModelTraceEvent } from "../model/client";

/** 只消费工具生命周期事件，SSE 正文、请求和诊断终态不触发消息写入。 */
export function applyExecutionEvent(details: ExecutionDetails, event: ModelTraceEvent): ExecutionDetails {
  if (event.kind !== "event") return details;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const match = /^tool_(start|success|error|skipped)$/.exec(event.name);
  if (!match) return details;
  const status: ExecutionDetails["tools"][number]["status"] = match[1] === "start" ? "running" : match[1] as "success" | "error" | "skipped";
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  const callId = String(data.toolCallId ?? "unknown");
  const tool = { callId, name: String(data.toolName ?? "unknown"), status, reason };
  return { ...details, tools: details.tools.some((item) => item.callId === callId) ? details.tools.map((item) => item.callId === callId ? tool : item) : [...details.tools, tool] };
}

/** 使用业务运行结果收尾；转储 close 的 run_closed 不属于失败。 */
export function finishExecution(details: ExecutionDetails, reason: NonNullable<ExecutionDetails["stopReason"]>): ExecutionDetails {
  return { ...details, stopReason: reason, outcome: reason === "completed" ? "success" : reason === "userInterrupted" ? "aborted" : "failed" };
}
