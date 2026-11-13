/**
 * 本地 CV 工具（开发者 Jan）：把离线 OCR 与目标检测接进工具链。
 *
 * 两个任务都在本机用 WASM 跑，不联网、不调用云端接口，因此**不需要审批**：
 * - `ocr_image`：识别右栏一张图片产物里的文字，把文本回填给模型；
 * - `detect_objects`：识别图片中的物体，除文本外还把画框的图存成产物并回灌给模型。
 *
 * 工具只负责「取图 → 调 CV → 组织结果文本」这条流程，具体识别算法在 `cv/client.ts`，
 * 资产与默认参数在 `cv/registry.ts`，画框在 `cv/overlay.ts`。
 */

import { DETECTION_DEFAULT_THRESHOLD, DETECTION_MAX_RESULTS, OCR_LANGUAGES } from "../cv/registry";
import { runDetection, normalizeOcrLanguages, runOcr } from "../cv/client";
import { drawDetections } from "../cv/overlay";
import type { DetectResult, OcrResult } from "../cv/types";
import { ARTIFACT_PREFIXES, nextArtifactName } from "../model/artifactNaming";
import { listArtifacts, writeArtifactBytes } from "../app/desktop/artifacts";
import type { ChatTool } from "../model/client";
import type { ToolImage } from "../model/toolImage";
import { readImageArtifact, type ImageArtifact } from "./artifactImage";

export const OCR_IMAGE_TOOL_NAME = "ocr_image";
export const DETECT_OBJECTS_TOOL_NAME = "detect_objects";

/** 画框图产物统一用 PNG，与 overlays 的导出格式保持一致 */
const OVERLAY_EXTENSION = "png";

/** 置信度按百分比展示 */
const PERCENT_SCALE = 100;

/** 检测结果里每个框的坐标都取整展示，小数点后几位对用户没有意义 */
const COORDINATE_FRACTION_DIGITS = 0;

const OCR_LANGUAGE_HINT = OCR_LANGUAGES.map((language) => language.id).join(" / ");

export const OCR_IMAGE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: OCR_IMAGE_TOOL_NAME,
    description:
      `对右栏「图片」中的一张图片做**离线**文字识别（OCR），在本机运行，不需要联网。name 传产物文件名（如 ai-20261004-153012.png）。只读本地文件，不需要用户审批。`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "右栏产物文件名，含扩展名" },
        lang: {
          type: "string",
          description: `可选识别语言，取值 ${OCR_LANGUAGE_HINT}，多个语言用 + 连接；缺省为中英混识。`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

export const DETECT_OBJECTS_TOOL: ChatTool = {
  type: "function",
  function: {
    name: DETECT_OBJECTS_TOOL_NAME,
    description:
      `对右栏「图片」中的一张图片做**离线**目标检测（YOLOX-nano，COCO 80 类），在本机运行，不需要联网。name 传产物文件名。返回各类目标的位置与置信度，并额外把画好框的图存为产物、连同画面一起交给你查看。只读本地文件，不需要用户审批。`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "右栏产物文件名，含扩展名" },
        threshold: {
          type: "number",
          description: `可选置信度阈值（0-1），低于它的框不返回；缺省 ${DETECTION_DEFAULT_THRESHOLD}。`,
        },
        maxResults: {
          type: "integer",
          description: `可选返回框数上限；缺省 ${DETECTION_MAX_RESULTS}。`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

export const CV_TOOLS: ChatTool[] = [OCR_IMAGE_TOOL, DETECT_OBJECTS_TOOL];

/**
 * 本地 CV 工具的使用说明（开发者 Jan）。
 *
 * 与其它工具一致：只描述真的挂出去了的工具，避免把不存在的工具写进系统消息。
 */
export function buildCvToolsHint(): string {
  return "需要读取图片里的文字时用 ocr_image，需要找出图中有哪些物体及其位置时用 detect_objects。两者都在本机离线运行、不消耗云端额度，图片产物名可以先从右栏列表获得。";
}

/** 一次本地 CV 工具调用的结果；`images` 由运行期转成 image_url 回灌 */
export interface CvToolResult {
  ok: boolean;
  output: string;
  images?: ToolImage[];
}

/**
 * 解析工具参数（开发者 Jan）。
 *
 * 模型给的参数可能有缺项、类型不对甚至不是合法 JSON，统一在这里收敛成对象或 null，
 * 由调用方按需校验必填项，避免每个分支各写一遍 try/catch。
 */
function parseArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 取一个有限数字参数；缺失或非法时返回 undefined，交由各任务自己的默认值兜底 */
function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 把 OCR 结果组织成给模型看的文本 */
function formatOcrOutput(languages: readonly string[], result: OcrResult): string {
  const header = `已用 ${languages.join("+")} 识别，得到 ${result.words.length} 个词，整体置信度 ${Math.round(result.confidence)}%。`;
  if (result.text.length === 0) {
    return `${header}\n未识别到任何文字：图片可能是纯图形，或文字过小、过于模糊。`;
  }
  return `${header}\n识别文本：\n${result.text}`;
}

/** 把检测结果组织成给模型看的文本（含每个框的像素位置） */
function formatDetectionOutput(result: DetectResult, artifactName: string): string {
  const size = `原图 ${result.width}×${result.height}`;
  if (result.detections.length === 0) {
    return `${size}，未检测到任何目标（可能是阈值偏高，或图中没有 COCO 80 类中的物体）。`;
  }
  const lines = result.detections.map((detection) => {
    const { x, y, width, height } = detection.box;
    const round = (value: number) => value.toFixed(COORDINATE_FRACTION_DIGITS);
    const percent = Math.round(detection.score * PERCENT_SCALE);
    return `- ${detection.label} ${percent}%：左上 (${round(x)}, ${round(y)})，尺寸 ${round(width)}×${round(height)}`;
  });
  return [
    `${size}，检测到 ${result.detections.length} 个目标：`,
    ...lines,
    `画好框的结果已另存为产物 ${artifactName}。`,
  ].join("\n");
}

/**
 * 执行一次本地 CV 工具调用（开发者 Jan）。
 *
 * 所有失败（未确定产物目录、参数非法、产物不是图片、资产缺失、跑挂）都返回可读文本，
 * 让模型据此改道或向用户说明，而不是抛出异常中断整轮运行。
 */
export async function runCvTool(
  artifactDir: string | null,
  tool: string,
  argumentsJson: string,
): Promise<CvToolResult> {
  if (!artifactDir) {
    return { ok: false, output: "尚未确定产物目录，无法读取本地图片做离线识别。" };
  }
  if (tool !== OCR_IMAGE_TOOL_NAME && tool !== DETECT_OBJECTS_TOOL_NAME) {
    return { ok: false, output: `未知本地 CV 工具：${tool}` };
  }

  const args = parseArguments(argumentsJson);
  if (!args) return { ok: false, output: `${tool} 的参数不是合法 JSON。` };
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (name.length === 0) return { ok: false, output: `${tool} 缺少非空 name。` };

  const loaded = await readImageArtifact(artifactDir, name);
  if (!loaded.ok) return loaded;

  try {
    return tool === OCR_IMAGE_TOOL_NAME
      ? await runOcrTask(loaded.image, args)
      : await runDetectionTask(artifactDir, loaded.image, args);
  } catch (error) {
    return {
      ok: false,
      output: `${tool} 执行失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** OCR 任务：识别文字并只回填文本（文字已在结果里，无需再回灌画面） */
async function runOcrTask(
  image: ImageArtifact,
  args: Record<string, unknown>,
): Promise<CvToolResult> {
  const languages = normalizeOcrLanguages(args.lang);
  const result = await runOcr({ name: image.name, mime: image.mime, bytes: image.bytes }, languages);
  return { ok: true, output: formatOcrOutput(languages, result) };
}

/**
 * 目标检测任务：识别目标、把画框图存成产物并回灌画面（开发者 Jan）。
 *
 * 回灌画面是刻意的：文本只能给出坐标数字，模型看到画框图后才能回答「左边那个人在做什么」
 * 这类需要空间关系的问题。
 */
async function runDetectionTask(
  artifactDir: string,
  image: ImageArtifact,
  args: Record<string, unknown>,
): Promise<CvToolResult> {
  const input = { name: image.name, mime: image.mime, bytes: image.bytes };
  const result = await runDetection(input, {
    threshold: readNumber(args, "threshold"),
    maxResults: readNumber(args, "maxResults"),
  });

  const overlay = await drawDetections(input, result);
  const existing = (await listArtifacts(artifactDir)).map((item) => item.name);
  const artifactName = nextArtifactName(ARTIFACT_PREFIXES.objectDetection, OVERLAY_EXTENSION, existing);
  await writeArtifactBytes(artifactDir, artifactName, overlay.base64);

  return {
    ok: true,
    output: formatDetectionOutput(result, artifactName),
    images: [{ ...overlay, name: artifactName }],
  };
}
