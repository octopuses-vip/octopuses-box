/**
 * `write_artifact` 工具：把模型生成的完整文件内容落到当前会话的产物目录下，
 * 右栏的「文件」与「网页」tab 随即可以预览。
 *
 * 产物目录由调用方给出：项目会话在项目根下的 `output/`，独立（临时）会话在缓存区的
 * `outputs/<会话创建日>/`。产物只允许平铺一层，文件名不得带路径；扩展名限制在文本类，
 * 避免模型往盘上写可执行或二进制文件。
 */

import { writeArtifact } from "../app/desktop/artifacts";
import type { ChatTool } from "../model/client";

/** 工具名，与模型返回的 function.name 对应 */
export const WRITE_FILE_TOOL_NAME = "write_artifact";

/** 允许写出的产物扩展名（均为可直接预览的文本类文件） */
const TEXT_EXTENSIONS = [
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "json",
  "md",
  "txt",
  "csv",
  "xml",
  "svg",
  "yml",
  "yaml",
];

/**
 * 图纸类产物扩展名（开发者 Jan）。
 *
 * STEP（ISO-10303-21）与 IGES 都是纯 ASCII 文本，走同一条文本写入通道是安全的，
 * 因此不需要为它们单开二进制接口。写进产物目录后右栏「3D」tab 会自动接住，
 * 与 `model/drawings` 的注册表按扩展名对上——两处都改才算真正支持一种新格式。
 */
const DRAWING_EXTENSIONS = ["step", "stp", "iges", "igs"];

/** 允许写出的全部产物扩展名：文本类产物 + 图纸类产物 */
const ARTIFACT_EXTENSIONS = [...TEXT_EXTENSIONS, ...DRAWING_EXTENSIONS];

/** `write_artifact` 的工具定义 */
export const WRITE_FILE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: WRITE_FILE_TOOL_NAME,
    description:
      "把生成的完整文件内容写入工作区，写好后用户可在右侧面板直接预览（HTML 会自动渲染，STEP/IGES 图纸可在「3D」tab 旋转查看）。" +
      "当用户要求生成网页、代码、文档、三维图纸等文件产物时使用；内容必须完整，不要用省略号代替。" +
      "name 只填文件名（含扩展名，如 index.html），不要带目录。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: `文件名，需带扩展名，例如 index.html、report.md、part.step。支持：${ARTIFACT_EXTENSIONS.join(" / ")}`,
        },
        content: {
          type: "string",
          description: "文件的完整内容，不要截断。",
        },
      },
      required: ["name", "content"],
    },
  },
};

/** `write_artifact` 的执行结果：成功时返回文件名，失败时 output 是可读原因 */
export interface WriteFileResult {
  ok: boolean;
  output: string;
  /** 成功写出的产物文件名 */
  name: string | null;
}

/** 触发模型在需要产出文件时使用 `write_artifact` 的系统提示 */
export function buildWriteFileHint(): string {
  return [
    "你可以使用 write_artifact 工具把生成的产物写成文件：项目会话写在项目目录的 output/ 下，",
    "临时会话写在缓存区的按天产物目录里；用户要网页、文档等可预览产物时，",
    "先给出简要说明，再调用 write_artifact 写入完整内容（name 只填文件名，如 index.html）。",
    "写好后右侧面板会展示该文件，HTML 类文件会被直接渲染预览。",
  ].join("");
}

/** 判断一个产物文件名是否是 HTML，用于决定右栏用哪个 tab 预览 */
export function isHtmlArtifact(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/**
 * 执行一次 `write_artifact`。
 *
 * 参数缺失、文件名不合法、扩展名不支持都作为可读文本返回，让模型自行纠错重试。
 *
 * @param artifactDir 当前会话的产物目录（项目 `output/` 或缓存区 `outputs/<日期>/`），未确定时无法写入
 */
export async function runWriteFileTool(
  artifactDir: string | null,
  argumentsJson: string,
): Promise<WriteFileResult> {
  let name = "";
  let content = "";
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as {
      name?: unknown;
      content?: unknown;
    };
    if (typeof parsed.name === "string") name = parsed.name.trim();
    if (typeof parsed.content === "string") content = parsed.content;
  } catch {
    return { ok: false, output: "工具参数不是合法 JSON，请按 { \"name\": \"index.html\", \"content\": \"…\" } 调用。", name: null };
  }

  if (name.length === 0) {
    return { ok: false, output: "缺少参数 name，请给出带扩展名的文件名，例如 index.html。", name: null };
  }
  if (content.length === 0) {
    return { ok: false, output: "缺少参数 content，请给出文件的完整内容。", name: null };
  }

  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!ARTIFACT_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      output: `不支持写出 .${extension || "(无扩展名)"} 文件，请改用：${ARTIFACT_EXTENSIONS.join(" / ")}。`,
      name: null,
    };
  }

  try {
    const bytes = await writeArtifact(artifactDir, name, content);
    return { ok: true, output: `已写出 ${name}（${bytes} 字节），用户可在右侧面板查看。`, name };
  } catch (error) {
    return {
      ok: false,
      output: `写出文件失败：${error instanceof Error ? error.message : String(error)}`,
      name: null,
    };
  }
}