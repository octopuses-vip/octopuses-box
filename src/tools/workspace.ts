import { applyWorkspacePatch, readWorkspaceFile, runWorkspaceTests, searchWorkspaceCode, writeWorkspaceFile } from "../app/desktop/workspace";
import type { ChatTool } from "../model/client";
import type { ToolImage } from "../model/toolImage";

export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";
export const APPLY_PATCH_TOOL_NAME = "apply_patch";
export const SEARCH_CODE_TOOL_NAME = "search_code";
export const TEST_RUNNER_TOOL_NAME = "test_runner";

export const READ_FILE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: READ_FILE_TOOL_NAME,
    description: "分页读取当前项目工作区内的文本文件。offset 从 1 开始，limit 默认 2000。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目内相对路径，也可传工作区内绝对路径" },
        offset: { type: "integer", minimum: 1, description: "起始行号，从 1 开始" },
        limit: { type: "integer", minimum: 1, description: "最多读取行数，默认 2000" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export const PROJECT_WRITE_FILE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: WRITE_FILE_TOOL_NAME,
    description: "把完整内容覆盖写入当前项目工作区内的文件，父目录不存在时自动创建。小修改优先使用 apply_patch。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目内相对路径，也可传工作区内绝对路径" },
        content: { type: "string", description: "文件完整内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

export const APPLY_PATCH_TOOL: ChatTool = {
  type: "function",
  function: {
    name: APPLY_PATCH_TOOL_NAME,
    description: "将 unified diff 补丁应用到当前项目，支持新增、修改和删除文件。",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "包含 ---/+++ 文件头和 @@ hunk 的统一 diff 文本" },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
};

export const SEARCH_CODE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: SEARCH_CODE_TOOL_NAME,
    description: "在当前项目内搜索文本，自动忽略 .git、node_modules、target、dist 等目录。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查找的文本" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "最大结果数量，默认 100" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const TEST_RUNNER_TOOL: ChatTool = {
  type: "function",
  function: {
    name: TEST_RUNNER_TOOL_NAME,
    description: "在当前项目根目录执行测试或构建命令，并返回 stdout、stderr、退出码和超时状态。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的完整命令" },
        timeoutSecs: { type: "integer", minimum: 1, description: "可选超时秒数，默认 120" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export const WORKSPACE_TOOLS: ChatTool[] = [
  READ_FILE_TOOL,
  PROJECT_WRITE_FILE_TOOL,
  APPLY_PATCH_TOOL,
  SEARCH_CODE_TOOL,
  TEST_RUNNER_TOOL,
];

/**
 * 工作区工程工具的说明（开发者 Jan）。
 *
 * 只在真的挂出了工作区工具时才返回说明：没有项目目录时这五个工具根本不在本轮工具表里，
 * 再去叮嘱模型「不要调用 read_file、write_file…」就是把不存在的工具写进系统消息，
 * 常驻内容凭空变长，对模型没有任何可执行的信息。
 *
 * 说明里刻意把「先检索、后回答」写成硬要求，而不是「可以先看看代码」这类弱建议：
 * 模型不会主动怀疑自己对项目的印象是编的，凭目录名、文件名和通用惯例就能生成一段
 * 看起来合理的实现描述。这里明确「没读过的文件不得引用其内容」，把猜测与事实分开，
 * 才让检索成为回答项目相关问题的前置动作。
 */
export function buildWorkspaceToolsHint(enabled: boolean): string {
  if (!enabled) return "";
  return [
    "处理当前项目源码时，先 search_code 定位、再 read_file 读到你实际要谈论的那部分内容，然后才回答或修改。",
    "没有读过的文件不得引用其内容，也不要凭文件名、目录名或通用惯例推断它的实现——那样给出的是猜测，不是这个项目的事实。",
    "小范围修改用 apply_patch，完整新建或整体覆盖才用 write_file；修改后用 test_runner 验证。所有路径均限制在当前项目工作区内。",
  ].join("");
}

export interface WorkspaceToolResult {
  ok: boolean;
  output: string;
  changed: boolean;
  checkpointId?: string;
  /** 工具额外产出的图片（如后续的 CV 工具画框图）；由运行期统一回灌给模型 */
  images?: ToolImage[];
}

export interface WorkspaceToolContext {
  cachePath: string | null;
  projectPath: string | null;
  threadId: string;
  runId: string;
  trustReadOnlyCommands: boolean;
  approved?: boolean;
  /** 是否对命令启用 macOS 内核级写隔离 */
  sandboxEnabled: boolean;
  /** 内核沙箱下是否允许命令访问网络 */
  sandboxAllowNetwork: boolean;
}

/**
 * 解析工具参数 JSON（开发者 Jan），失败返回 null。
 *
 * 空字符串按空对象处理：模型有时不传参数（如无参工具），
 * 直接 JSON.parse("") 会抛错，这里统一折成 {} 让调用方只需判 null 一种失败。
 */
function parseObject(argumentsJson: string): Record<string, unknown> | null {
  try {
    return JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 把异常折成统一的失败结果（开发者 Jan）。
 *
 * 工具失败不抛异常而是回一个 ok=false 的结果，因为这条链路要把失败原因交回模型，
 * 让它自行调整；抛出异常会中断整轮运行，反而丢掉了自我纠正的机会。
 */
function errorOutput(error: unknown): WorkspaceToolResult {
  return { ok: false, output: error instanceof Error ? error.message : String(error), changed: false };
}

/**
 * 执行一次工程工具调用（开发者 Jan）：把模型给出的工具名与参数 JSON 派发到对应后端命令。
 *
 * 所有工程工具都收敛到这一个入口，好处是「没有选项目」「参数不是合法 JSON」这类
 * 前置校验只写一次；changed 标记本次调用是否改动了工作区，
 * 上层据此决定要不要刷新 Git 差异。
 */
export async function runWorkspaceTool(
  context: WorkspaceToolContext,
  tool: string,
  argumentsJson: string,
): Promise<WorkspaceToolResult> {
  const {
    cachePath,
    projectPath,
    threadId,
    runId,
    trustReadOnlyCommands,
    approved = false,
    sandboxEnabled,
    sandboxAllowNetwork,
  } = context;
  if (!projectPath) {
    return { ok: false, output: "尚未选择项目目录，无法执行工程工具。", changed: false };
  }
  const args = parseObject(argumentsJson);
  if (!args) {
    return { ok: false, output: "工具参数不是合法 JSON。", changed: false };
  }

  try {
    if (tool === READ_FILE_TOOL_NAME) {
      if (typeof args.path !== "string" || args.path.trim().length === 0) {
        return { ok: false, output: "read_file 缺少非空 path。", changed: false };
      }
      const output = await readWorkspaceFile(
        projectPath,
        args.path,
        typeof args.offset === "number" ? args.offset : undefined,
        typeof args.limit === "number" ? args.limit : undefined,
      );
      return { ok: true, output, changed: false };
    }
    if (tool === WRITE_FILE_TOOL_NAME) {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        return { ok: false, output: "write_file 需要 path 与 content。", changed: false };
      }
      if (!cachePath) {
        return { ok: false, output: "尚未配置缓存目录，无法创建写入检查点。", changed: false };
      }
      const result = await writeWorkspaceFile(cachePath, projectPath, threadId, runId, args.path, args.content);
      return {
        ok: true,
        output: `已写入 ${result.path}（${result.bytes} 字节）。`,
        changed: true,
        checkpointId: result.checkpointId,
      };
    }
    if (tool === APPLY_PATCH_TOOL_NAME) {
      if (typeof args.patch !== "string" || args.patch.trim().length === 0) {
        return { ok: false, output: "apply_patch 缺少非空 patch。", changed: false };
      }
      if (!cachePath) {
        return { ok: false, output: "尚未配置缓存目录，无法创建补丁检查点。", changed: false };
      }
      const result = await applyWorkspacePatch(cachePath, projectPath, threadId, runId, args.patch);
      return {
        ok: true,
        output: `已应用补丁：\n${result.files.join("\n")}`,
        changed: true,
        checkpointId: result.checkpointId,
      };
    }
    if (tool === SEARCH_CODE_TOOL_NAME) {
      if (typeof args.query !== "string" || args.query.trim().length === 0) {
        return { ok: false, output: "search_code 缺少非空 query。", changed: false };
      }
      const matches = await searchWorkspaceCode(
        projectPath,
        args.query,
        typeof args.limit === "number" ? args.limit : undefined,
      );
      const output = matches.length === 0
        ? "未找到匹配内容。"
        : matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
      return { ok: true, output, changed: false };
    }
    if (tool === TEST_RUNNER_TOOL_NAME) {
      if (typeof args.command !== "string" || args.command.trim().length === 0) {
        return { ok: false, output: "test_runner 缺少非空 command。", changed: false };
      }
      const result = await runWorkspaceTests(
        projectPath,
        args.command,
        typeof args.timeoutSecs === "number" ? args.timeoutSecs : undefined,
        trustReadOnlyCommands,
        approved,
        { enabled: sandboxEnabled, allowNetwork: sandboxAllowNetwork },
      );
      const output = [
        `命令：${args.command}`,
        `退出码：${result.exitCode ?? "无"}${result.timedOut ? "（超时）" : ""}`,
        result.stdout.trim().length > 0 ? `--- stdout ---\n${result.stdout}` : "",
        result.stderr.trim().length > 0 ? `--- stderr ---\n${result.stderr}` : "",
      ].filter(Boolean).join("\n");
      return { ok: result.exitCode === 0 && !result.timedOut, output, changed: false };
    }
    return { ok: false, output: `未知工程工具：${tool}`, changed: false };
  } catch (error) {
    return errorOutput(error);
  }
}
