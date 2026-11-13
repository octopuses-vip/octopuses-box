/**
 * 视觉工具（开发者 Jan）：让模型看到「自己产出的东西」。
 *
 * 两个工具都只读本地已有的东西，没有任何本机副作用，因此**不需要审批**：
 * - `read_image`：读右栏某张图片产物，把像素回灌给模型；
 * - `render_3d_view`：抓取当前 3D 视图的一帧，把画面回灌给模型。
 *
 * 二者都不把 base64 写进文本结果（会撑爆上下文），而是通过 `images` 字段交给运行期，
 * 由运行期统一转成 `image_url` 附到下一条用户消息上。
 */

import { ARTIFACT_PREFIXES } from "../model/artifactNaming";
import { captureActiveDrawing } from "../model/drawingCapture";
import { base64FromBytes, type ToolImage } from "../model/toolImage";
import type { ChatTool } from "../model/client";
import { readImageArtifact } from "./artifactImage";

export const READ_IMAGE_TOOL_NAME = "read_image";
export const RENDER_3D_VIEW_TOOL_NAME = "render_3d_view";

/** 回灌时给 3D 抓帧图的建议名，与用户截图按钮共用同一前缀 */
const RENDER_3D_VIEW_FILE_NAME = `${ARTIFACT_PREFIXES.drawingView}.png`;

export const READ_IMAGE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: READ_IMAGE_TOOL_NAME,
    description:
      "读取右栏「图片」中的一个图片产物，并把画面直接交给你查看。name 传产物文件名（如 ai-20261004-153012.png）。只读本地文件，不需要用户审批。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "右栏产物文件名，含扩展名" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

export const RENDER_3D_VIEW_TOOL: ChatTool = {
  type: "function",
  function: {
    name: RENDER_3D_VIEW_TOOL_NAME,
    description:
      "抓取用户在右栏「3D」中当前看到的模型视图，并把画面直接交给你查看。无需参数；用户还没打开任何 3D 图纸时会被明确告知。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const VISION_TOOLS: ChatTool[] = [READ_IMAGE_TOOL, RENDER_3D_VIEW_TOOL];

/**
 * 视觉工具的使用说明（开发者 Jan）。
 *
 * 与工作区工具一致：只有真的挂出了这两个工具才返回说明，避免把不存在的工具写进系统消息。
 */
export function buildVisionToolsHint(enabled: boolean): string {
  if (!enabled) return "";
  return "需要查看右栏已有的图片产物时用 read_image（也可以先用其它工具列出产物名）；需要看你无法直接获取的 3D 模型外观时用 render_3d_view 抓取用户当前视角。两者都会把画面直接回灌给你，直接描述你看到的内容即可。";
}

/** 一次视觉工具调用的结果；`images` 由运行期转成 image_url 回灌 */
export interface VisionToolResult {
  ok: boolean;
  output: string;
  images?: ToolImage[];
}

/**
 * 把一段 base64 的本地图片交给模型（开发者 Jan）。
 *
 * 路径只有两条（读产物 / 抓 3D 视图），但都需要「判空 → 读字节 → 转 base64 → 组装结果」，
 * 收敛到一处，新增来源时只改这里。
 */
function imageResult(output: string, image: ToolImage): VisionToolResult {
  return { ok: true, output, images: [image] };
}

/**
 * 执行一次视觉工具调用。
 *
 * 所有失败（参数缺失、产物不存在、类型不对、没有可抓帧的视图）都返回可读文本，
 * 让模型据此改道或向用户说明，而不是抛出异常中断整轮运行。
 */
export async function runVisionTool(
  artifactDir: string | null,
  tool: string,
  argumentsJson: string,
): Promise<VisionToolResult> {
  if (!artifactDir) {
    return { ok: false, output: "尚未确定产物目录，无法读取本地产物或抓取画面。" };
  }

  if (tool === READ_IMAGE_TOOL_NAME) {
    let name = "";
    try {
      const args = JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
      name = typeof args.name === "string" ? args.name.trim() : "";
    } catch {
      return { ok: false, output: "read_image 的参数不是合法 JSON。" };
    }
    if (name.length === 0) {
      return { ok: false, output: "read_image 缺少非空 name。" };
    }

    // 按名取图的校验与失败文案统一由 artifactImage 负责，这里只关心拿到之后怎么交给模型
    const loaded = await readImageArtifact(artifactDir, name);
    if (!loaded.ok) return loaded;
    const { bytes } = loaded.image;
    return imageResult(`已读取图片产物 ${name}（${bytes.length} 字节）。`, {
      name,
      mime: loaded.image.mime,
      base64: base64FromBytes(bytes),
    });
  }

  if (tool === RENDER_3D_VIEW_TOOL_NAME) {
    const shot = await captureActiveDrawing();
    if (!shot) {
      return {
        ok: false,
        output:
          "当前没有可抓取的 3D 视图：请让用户先在右栏「3D」里打开一个 STEP / IGES 图纸，再重试。",
      };
    }
    return imageResult(`已抓取当前 3D 视图（${shot.width}×${shot.height} 像素）。`, {
      name: RENDER_3D_VIEW_FILE_NAME,
      mime: "image/png",
      base64: shot.base64,
      width: shot.width,
      height: shot.height,
    });
  }

  return { ok: false, output: `未知视觉工具：${tool}` };
}
