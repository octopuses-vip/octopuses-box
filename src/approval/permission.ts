/**
 * 命令执行权限档位（开发者 Jan）。
 *
 * 档位是执行命令时「要不要打断用户」的唯一开关，取值挂在会话上（`Thread.permissionMode`），
 * 由输入框里模型右侧的选择器修改。闸门（`./gate.ts`）按档位走三条互斥的分支：
 *
 *   ask            只读白名单之外一律转人工
 *   auto-readonly  只读白名单自动执行，其余转人工（默认；保留既有档位值以兼容历史会话）
 *   auto-all       除静态硬拒规则与已撤销的命令外一律直接执行，不弹卡片
 *
 * 三档都改不了静态 `deny`（`rm -rf /`、`sudo`、动态 shell 展开等）——那是针对模型误判的
 * 最后一道防线，任何档位下都直接拒绝。
 *
 * 本文件不依赖 store，供闸门、store、输入框与设置页共用同一份档位定义，避免文案与取值
 * 在多处各写一遍。
 */

import type { PermissionMode } from "../app/types";

/** 新会话的默认档位：比「每次询问」少打扰，又不至于无提示地放开写操作 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto-readonly";

export interface PermissionModeOption {
  id: PermissionMode;
  /** 选择器按钮上的短标签 */
  label: string;
  /** 一句话说明该档位下哪些命令会被自动执行 */
  description: string;
}

/**
 * 档位定义。
 *
 * 文案刻意写清「哪些会被自动执行」而不是只说「宽松 / 严格」——审批是安全边界，
 * 用户需要在不点开设置页的前提下就知道自己正在授权什么。
 */
const PERMISSION_MODE_TABLE: Record<PermissionMode, PermissionModeOption> = {
  ask: {
    id: "ask",
    label: "每次询问",
    description: "只读白名单之外的命令都要你确认",
  },
  "auto-readonly": {
    id: "auto-readonly",
    label: "只读自动",
    description: "仅自动执行静态白名单内的命令，其余需要确认",
  },
  "auto-all": {
    id: "auto-all",
    label: "全部自动",
    description: "除危险命令与已撤销的命令外一律执行，不再打断；可随时撤销单条",
  },
};

/**
 * 选择器与设置页的展示顺序：从最严到最松。
 *
 * 单独列出而不是用 `Object.values`：展示顺序是产品决定，不该被对象字面量的书写顺序
 * 或引擎的键顺序规则左右。表本身是 `Record<PermissionMode, …>`，漏定义某个取值会直接
 * 编译不过，因此这里不需要再做完整性兜底。
 */
export const PERMISSION_MODES: readonly PermissionModeOption[] = [
  PERMISSION_MODE_TABLE.ask,
  PERMISSION_MODE_TABLE["auto-readonly"],
  PERMISSION_MODE_TABLE["auto-all"],
];

/** 取某个档位的展示项；入参是联合类型，因此恒有定义、不需要回落分支 */
export function permissionModeOption(mode: PermissionMode): PermissionModeOption {
  return PERMISSION_MODE_TABLE[mode];
}

/** 档位的严格程度序：数值越小越严（`ask` 最严，`auto-all` 最松） */
const PERMISSION_MODE_ORDER: Record<PermissionMode, number> = {
  ask: 0,
  "auto-readonly": 1,
  "auto-all": 2,
};

/** 判断一个字符串是否为合法档位（用于容忍 Agent 声明里的未知取值） */
function isPermissionMode(value: string): value is PermissionMode {
  return value === "ask" || value === "auto-readonly" || value === "auto-all";
}

/**
 * 用 Agent 的档位收窄会话档位（开发者 Jan）。
 *
 * Agent 只做**上限**、不做提升：有效档位 = min(会话档位, Agent 档位)。这样既保住
 * 「权限档位是会话级临时授权」的既有安全意图，又让无人值守任务可以被显式收窄到更严的档位，
 * 而不会因为绑定了某个 Agent 就把权限悄悄放开。Agent 档位为空或非法时原样返回会话档位。
 */
export function restrictPermissionMode(
  sessionMode: PermissionMode,
  agentMode: string | null | undefined,
): PermissionMode {
  if (!agentMode || !isPermissionMode(agentMode)) return sessionMode;
  return PERMISSION_MODE_ORDER[agentMode] < PERMISSION_MODE_ORDER[sessionMode] ? agentMode : sessionMode;
}
