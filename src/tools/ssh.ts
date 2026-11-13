/**
 * 远程主机（SSH）工具的模型侧定义与执行入口（开发者 Jan）。
 *
 * 与工作区工具（`workspace.ts`）同构：这里只负责「定义 → 描述 → 转调 IPC」，
 * 审批与风险评估留在 `useAgentRun` 的调度层，统一按会话权限与安全策略处理。
 *
 * 安全前提：
 * - 四个工具全部经过权限闸门，不做 SSH 只读白名单，是否人工审批由有效权限策略决定；
 * - 主机凭据只在 Rust 侧取用，前端拿到的 `SshHost` 不含任何口令；
 * - 系统提示只注入主机 id 与名称用途，不注入用户名、地址或端口。
 */

import { sshExec, sshListDir, sshReadFile, sshWriteFile } from "../app/desktop/ssh";
import type { SshExecResult, SshHost } from "../app/types";
import type { ChatTool } from "../model/client";

export const SSH_EXEC_TOOL_NAME = "ssh_exec";
export const SSH_READ_FILE_TOOL_NAME = "ssh_read_file";
export const SSH_WRITE_FILE_TOOL_NAME = "ssh_write_file";
export const SSH_LIST_DIR_TOOL_NAME = "ssh_list_dir";

/** host 参数的统一说明：取值来自系统提示中列出的主机 id */
const HOST_PROPERTY = {
  type: "string",
  description: "远程主机 id，必须取系统提示中列出的主机 id",
};

export const SSH_EXEC_TOOL: ChatTool = {
  type: "function",
  function: {
    name: SSH_EXEC_TOOL_NAME,
    description:
      "在指定的远程 Linux 主机上执行一条 shell 命令并返回 stdout、stderr 与退出码。命令会在远端真实执行，务必先确认影响。",
    parameters: {
      type: "object",
      properties: {
        host: HOST_PROPERTY,
        command: { type: "string", description: "要在远端执行的完整命令" },
        timeoutSecs: { type: "integer", minimum: 1, description: "可选超时秒数，默认 60，最大 3600" },
      },
      required: ["host", "command"],
      additionalProperties: false,
    },
  },
};

export const SSH_READ_FILE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: SSH_READ_FILE_TOOL_NAME,
    description: "读取远程主机上的文本文件内容，超过读取上限时只返回前一部分。",
    parameters: {
      type: "object",
      properties: {
        host: HOST_PROPERTY,
        path: { type: "string", description: "远端文件的绝对路径" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
};

export const SSH_WRITE_FILE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: SSH_WRITE_FILE_TOOL_NAME,
    description: "把完整内容覆盖写入远程主机上的文件（不存在则创建，存在则截断重写）。",
    parameters: {
      type: "object",
      properties: {
        host: HOST_PROPERTY,
        path: { type: "string", description: "远端文件的绝对路径" },
        content: { type: "string", description: "文件完整内容" },
      },
      required: ["host", "path", "content"],
      additionalProperties: false,
    },
  },
};

export const SSH_LIST_DIR_TOOL: ChatTool = {
  type: "function",
  function: {
    name: SSH_LIST_DIR_TOOL_NAME,
    description: "列出远程主机上某个目录的条目，包含类型与字节大小。",
    parameters: {
      type: "object",
      properties: {
        host: HOST_PROPERTY,
        path: { type: "string", description: "远端目录的绝对路径" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
};

export const SSH_TOOLS: ChatTool[] = [
  SSH_EXEC_TOOL,
  SSH_READ_FILE_TOOL,
  SSH_WRITE_FILE_TOOL,
  SSH_LIST_DIR_TOOL,
];

export const SSH_TOOL_NAMES: string[] = SSH_TOOLS.map((tool) => tool.function.name);

/** 该工具名是否属于远程主机工具 */
export function isSshTool(tool: string): boolean {
  return SSH_TOOL_NAMES.includes(tool);
}

/**
 * 远程主机工具的说明（开发者 Jan）。
 *
 * 只列出**已启用**的主机：停用主机在运行期也会被后端拦下，写进提示只会让模型误以为可用。
 * 传入的应是**当前项目作用域内**的主机（见 `selectProjectScopedSshHosts`），因此这里同时明确
 * 「只能用这些」——模型点名列表外的主机时，运行期会被硬拦截，提前说清可省掉一轮失败调用。
 * 没有任何启用主机时返回空串，避免把不存在的工具写进系统消息。
 */
export function buildSshToolsHint(hosts: SshHost[]): string {
  const enabled = hosts.filter((host) => host.enabled);
  if (enabled.length === 0) return "";
  const lines = enabled.map(
    (host) => `- ${host.id}｜${host.name}`,
  );
  return [
    "下列远程 Linux 主机可供本轮实际挂载的 SSH 工具使用（具体能力以本轮工具清单为准，host 参数填最前面的 id）：",
    ...lines,
    "只能使用上述主机，列表外的主机一律视为不可用；远程操作统一经过权限与安全策略检查，" +
      "可能自动批准、拒绝或要求人工确认，取决于当前会话的有效权限与策略。请把命令写清楚，避免破坏性操作，不要绕过拒绝。",
  ].join("\n");
}

/**
 * 单台主机「执行限制」提示词的长度上限（字符）。
 *
 * 必须与 Rust 侧 `ssh.rs::GUARD_PROMPT_LIMIT` 保持一致：前端拿它做即时字数提示，
 * 后端仍是最终判定，两边不同步就会出现「界面上没超限、保存却被拒」。
 */
export const SSH_GUARD_PROMPT_LIMIT = 4000;

/**
 * 某台主机的「执行限制」提示词（开发者 Jan）。
 *
 * 只在模型真的对这台主机发起调用时注入，不常驻系统提示：限制与具体机器绑定
 * （生产机与测试机的红线完全不同），平时挂着只是白占 token；而调用发生的那一刻
 * 正是它唯一相关的时点。注入位置是回给模型的 tool 结果（见 `useAgentRun`），
 * 因此触发注入的那条命令已经生成——这一层约束的是同一会话里后续对这台主机的操作，
 * 当次操作仍由人工审批与后端 `remote_deny_reason` 静态拒绝清单兜底。
 */
export function buildSshGuardHint(host: SshHost): string {
  const prompt = (host.guardPrompt ?? "").trim();
  if (prompt.length === 0) return "";
  return [
    `【远程主机「${host.name}」的执行限制】`,
    prompt,
    "以上限制由该主机的维护者设定，后续对这台主机的每一次操作都必须遵守；" +
      "确需执行受限操作时，先向用户说明并取得同意，不要改写命令绕过限制。",
  ].join("\n");
}

export interface SshToolResult {
  ok: boolean;
  output: string;
}

/** 一次远程调用的展示摘要，供工具卡片与审批卡片复用 */
export interface SshCallSummary {
  /** 目标主机 id；解析失败时为空串 */
  hostId: string;
  /** 卡片标题 */
  title: string;
  /** 卡片正文展示的命令或路径 */
  command: string;
}

/** 解析模型给出的参数 JSON；非法时返回 null */
function parseObject(argumentsJson: string): Record<string, unknown> | null {
  try {
    return JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 参数是否为非空字符串 */
function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/**
 * 生成一次远程调用的展示摘要（开发者 Jan）。
 *
 * 审批卡片与工具卡片都要展示「对哪台机器做了什么」，因此把这段解析集中在此，
 * 避免两处各写一份而对不齐。
 */
export function describeSshCall(tool: string, argumentsJson: string): SshCallSummary {
  const args = parseObject(argumentsJson) ?? {};
  const hostId = readString(args, "host").trim();
  const path = readString(args, "path");
  const command = readString(args, "command");
  switch (tool) {
    case SSH_EXEC_TOOL_NAME:
      return { hostId, title: "远程执行命令", command };
    case SSH_READ_FILE_TOOL_NAME:
      return { hostId, title: "读取远程文件", command: path };
    case SSH_WRITE_FILE_TOOL_NAME:
      return { hostId, title: "写入远程文件", command: path };
    case SSH_LIST_DIR_TOOL_NAME:
      return { hostId, title: "列出远程目录", command: path };
    default:
      return { hostId, title: "远程操作", command: command || path };
  }
}

/** 把命令执行结果整理成模型可读的多行文本 */
function formatExecResult(command: string, result: SshExecResult): string {
  return [
    `命令：${command}`,
    `退出码：${result.exitCode < 0 ? "未上报" : result.exitCode}${result.timedOut ? "（超时）" : ""}`,
    result.stdout.trim().length > 0 ? `--- stdout ---\n${result.stdout}` : "",
    result.stderr.trim().length > 0 ? `--- stderr ---\n${result.stderr}` : "",
    result.truncated ? "（输出超过上限，已截断）" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 执行一次远程主机工具（开发者 Jan）。
 *
 * 审批已经在上层完成，这里只做参数校验与 IPC 转调；任何异常都收敛成 `ok: false` 的文本，
 * 让模型能看到失败原因并自行调整，而不是让整个回合崩掉。
 */
export async function runSshTool(
  cachePath: string | null,
  tool: string,
  argumentsJson: string,
): Promise<SshToolResult> {
  const args = parseObject(argumentsJson);
  if (!args) return { ok: false, output: "工具参数不是合法 JSON。" };
  const hostId = readString(args, "host").trim();
  if (!hostId) return { ok: false, output: `${tool} 缺少 host（远程主机 id）。` };

  try {
    if (tool === SSH_EXEC_TOOL_NAME) {
      const command = readString(args, "command");
      if (command.trim().length === 0) return { ok: false, output: "ssh_exec 缺少非空 command。" };
      const timeoutSecs = typeof args.timeoutSecs === "number" ? args.timeoutSecs : 0;
      const result = await sshExec(cachePath, hostId, command, timeoutSecs);
      return { ok: result.ok, output: formatExecResult(command, result) };
    }
    if (tool === SSH_READ_FILE_TOOL_NAME) {
      const path = readString(args, "path");
      if (path.trim().length === 0) return { ok: false, output: "ssh_read_file 缺少非空 path。" };
      const file = await sshReadFile(cachePath, hostId, path);
      const suffix = file.truncated ? "\n（文件超过读取上限，仅返回前一部分）" : "";
      return { ok: true, output: `--- ${file.path} ---\n${file.content}${suffix}` };
    }
    if (tool === SSH_WRITE_FILE_TOOL_NAME) {
      const path = readString(args, "path");
      const content = readString(args, "content");
      if (path.trim().length === 0) return { ok: false, output: "ssh_write_file 缺少非空 path。" };
      const message = await sshWriteFile(cachePath, hostId, path, content);
      return { ok: true, output: message };
    }
    if (tool === SSH_LIST_DIR_TOOL_NAME) {
      const path = readString(args, "path");
      if (path.trim().length === 0) return { ok: false, output: "ssh_list_dir 缺少非空 path。" };
      const entries = await sshListDir(cachePath, hostId, path);
      if (entries.length === 0) return { ok: true, output: `目录为空：${path}` };
      const lines = entries.map(
        (entry) => `${entry.isDir ? "d" : "-"}  ${String(entry.size).padStart(10)}  ${entry.path}`,
      );
      return { ok: true, output: lines.join("\n") };
    }
    return { ok: false, output: `未知远程主机工具：${tool}` };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
