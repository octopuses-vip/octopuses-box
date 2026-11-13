/**
 * 审批闸门（开发者 Jan）：所有「需要用户确认的本机操作」的唯一入口。
 *
 * 决策顺序（从严，每一步都能短路）：
 *   1. 静态策略 deny → 直接拒绝，不弹卡片（硬边界，任何档位都绕不过）；
 *   2. 静态策略 allow（只读白名单命中）→ 直接放行，不弹卡片；
 *   3. 命令模式已在撤销名单里 → 转人工。放在档位判断之前，「全部自动」档下点「撤销」才有作用；
 *   4. 会话的权限档位（`Thread.permissionMode`）：
 *        auto-all       → 直接放行（仍渲染卡片标注自动允许，可撤销）；
 *        ask / auto-readonly → 转人工审批卡片，等待用户点选。
 */

import { nextId } from "../app/ids";
import { selectAgentById } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import type { PermissionMode, StreamItem } from "../app/types";
import { DEFAULT_PERMISSION_MODE, restrictPermissionMode } from "./permission";

/** 静态策略结论；与后端 `CommandDecision` 对齐 */
export type ApprovalDecision = "allow" | "ask" | "deny";

export interface ApprovalInput {
  /** 待审批的命令或工具调用原文 */
  command: string;
  /** 展示给用户的原因 */
  reason: string;
  /** 静态策略结论；缺省按 ask 处理 */
  decision?: ApprovalDecision;
  /** 命令的稳定模式：同类命令共享同一取值，用于写入 / 命中撤销名单 */
  pattern: string;
}

/** 闸门向运行期要的回调：卡片渲染与等待由调用方提供 */
export interface ApprovalHost {
  threadId: string;
  /** 把一条卡片推进当前助手消息 */
  push: (item: StreamItem) => void;
  /** 更新已推送卡片的字段 */
  patch: (itemId: string, updater: (item: StreamItem) => StreamItem) => void;
  /**
   * 子代理会话的镜像落点（开发者 Jan）：子会话不出现在任务列表里、也没有入口能切过去，
   * 卡片只推进子会话就没人能点，子代理会永远挂在等待上。因此人工审批卡片在最外层可见会话里
   * 也放一份，两边共用同一个 itemId，点一次两边一起收尾。
   */
  mirror?: {
    push: (item: StreamItem) => void;
    patch: (itemId: string, updater: (item: StreamItem) => StreamItem) => void;
  };
  /** 等待用户点选；运行被中断时 reject。返回 `"expired"` 表示无人值守等超时，未由人给出结论 */
  wait: (itemId: string) => Promise<boolean | "expired">;
}

export interface ApprovalOutcome {
  /** 是否允许执行 */
  approved: boolean;
  /** 是否在「全部自动」档下放行（false 表示静态白名单或人工点选/拒绝） */
  auto: boolean;
  /** 无人值守等超时导致失效：不是用户拒绝，调用方应给出不同提示 */
  expired?: boolean;
}

/**
 * 读取某会话当前的**有效**权限档位（开发者 Jan）；会话已被删除时按默认档位处理，避免读到 undefined 后放行。
 *
 * 绑定了 Agent 时按「只收窄不提升」取 min(会话档位, Agent 上限)：权限档位仍是会话级临时授权，
 * 但无人值守的任务可以被 Agent 显式压到更严的档位，而不会因为绑定 Agent 就放开权限。
 */
export function permissionModeOf(threadId: string): PermissionMode {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return DEFAULT_PERMISSION_MODE;
  const agent = selectAgentById(state, thread.agentId);
  return restrictPermissionMode(thread.permissionMode, agent?.permissionMode ?? null);
}

/** 把审批卡片写进所有落点（开发者 Jan）：子会话留完整过程，最外层可见会话提供可点选入口 */
function pushApprovalCard(host: ApprovalHost, item: StreamItem): void {
  host.push(item);
  host.mirror?.push(item);
}

/** 同步更新所有落点上的同一张卡片（开发者 Jan）：点选后两边状态必须一致 */
function patchApprovalCard(
  host: ApprovalHost,
  itemId: string,
  updater: (item: StreamItem) => StreamItem,
): void {
  host.patch(itemId, updater);
  host.mirror?.patch(itemId, updater);
}

/** 弹人工审批卡片并等待用户点选（开发者 Jan）；用户点选前一直挂起 */
async function waitForHuman(
  input: ApprovalInput,
  host: ApprovalHost,
): Promise<ApprovalOutcome> {
  const itemId = nextId("item");
  pushApprovalCard(host, {
    id: itemId,
    type: "approval",
    command: input.command,
    reason: input.reason,
    pattern: input.pattern,
    status: "pending",
    auto: false,
  });
  // 无人值守等超时的卡片要落成「已失效」而不是「已拒绝」：没有人给过结论，写「拒绝」会误导用户
  const outcome = await host.wait(itemId);
  const approved = outcome === true;
  patchApprovalCard(host, itemId, (item) =>
    item.type === "approval"
      ? { ...item, status: outcome === "expired" ? "expired" : approved ? "approved" : "denied" }
      : item,
  );
  return { approved, auto: false, ...(outcome === "expired" ? { expired: true } : {}) };
}

/**
 * 推一张「已自动允许」的卡片并立即返回放行（开发者 Jan）。
 *
 * 自动放行也要留痕：卡片是用户事后发现「刚发生了什么」并点「撤销并改为手动」的唯一入口，
 * 「全部自动」档仍保留卡片与撤销入口。
 */
function approveAutomatically(
  input: ApprovalInput,
  reason: string,
  host: ApprovalHost,
): ApprovalOutcome {
  host.push({
    id: nextId("item"),
    type: "approval",
    command: input.command,
    reason,
    pattern: input.pattern,
    status: "approved",
    auto: true,
  });
  return { approved: true, auto: true };
}

/**
 * 请求一次审批（开发者 Jan）。
 *
 * 调用方只负责给出「命令原文 + 展示原因 + 稳定 pattern」，其余判定全部收敛在这里，
 * 保证任何入口（工程命令、MCP、浏览器 / 电脑自动化）走的是同一套边界。
 */
export async function requestApproval(
  input: ApprovalInput,
  host: ApprovalHost,
): Promise<ApprovalOutcome> {
  const state = useAppStore.getState();
  const decision: ApprovalDecision = input.decision ?? "ask";

  // 1. 硬边界：静态策略拒绝的操作不弹卡片，且不受权限档位影响
  if (decision === "deny") return { approved: false, auto: false };
  // 2. 只读白名单命中：直接放行
  if (decision === "allow") return { approved: true, auto: false };
  // 3. 该命令模式被用户撤销过：所有档位下都转人工，否则「全部自动」档里的撤销按钮形同虚设
  if (state.autoApprovalDenylist.includes(input.pattern)) {
    return waitForHuman(input, host);
  }

  const mode = permissionModeOf(host.threadId);

  // 4. 「全部自动」：除上面三道边界外一律放行
  if (mode === "auto-all") {
    return approveAutomatically(
      input,
      "已在「全部自动」档下直接执行；如需逐条确认，可在输入框的权限选择器里改回其他档位。",
      host,
    );
  }
  // 5. 其余一律转人工，不再发起额外的模型请求。
  return waitForHuman(input, host);
}

/** 从命令原文里取一个稳定模式（开发者 Jan）：首个命令行段的前两个词，用于撤销名单匹配 */
export function commandPattern(command: string): string {
  // 只取第一个非空命令行段：管道 / && / ; 之后的部分风险更高，但同属一条命令
  const head = command.split(/[|;&\n]/)[0]?.trim() ?? "";
  const words = head.split(/\s+/).filter((word) => word.length > 0);
  return words.slice(0, 2).join(" ") || head || command.trim();
}
