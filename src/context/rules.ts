/**
 * 项目规则（开发者 Jan）：自动读取工作区内的 `AGENTS.md` 并注入模型请求。
 *
 * 与「附加上下文」的区别：这里的规则由客户端自动发现，不需要用户手动附加；
 * 读取由 Rust 侧完成，浏览器演示环境没有工作区可读，返回 null。
 */

import { loadWorkspaceRules } from "../app/desktop/workspace";

/**
 * 读取工作区内生效的项目规则并拼成一段系统说明（开发者 Jan）；没有规则文件时返回 null。
 *
 * `target` 是本轮工作涉及的工作区内相对路径，读取时会把该路径各级目录的规则一并带上，
 * 越靠近目标的规则排名越靠后、优先级越高。
 */
export async function buildProjectRulesMessage(
  workspacePath: string | null,
  target?: string | null,
): Promise<string | null> {
  if (!workspacePath) return null;
  try {
    const rules = await loadWorkspaceRules(workspacePath, target);
    return rules.content.trim().length > 0 ? rules.content : null;
  } catch {
    // 规则读取失败不影响本轮运行，交由后续工具报错暴露具体原因
    return null;
  }
}