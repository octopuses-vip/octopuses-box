/**
 * 检测结果可视化（开发者 Jan）。
 *
 * 把检测框与类别标签画到原图上，产出一张既能给用户直接看、也能回灌给模型的 PNG。
 * 颜色按类别下标从固定色板取：同一次检测里不同类颜色可区分，同一类颜色始终一致。
 */

import { blobToBase64, type ToolImage } from "../model/toolImage";
import type { CvImageInput, DetectResult } from "./types";

/**
 * 画框用的色板。
 *
 * 按类别下标取模选取，因此色板本身不追求「每类唯一颜色」，只追求相邻类别不撞色，
 * 在视觉上足够把不同目标区分开。
 */
const BOX_PALETTE: readonly string[] = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#00c7be",
  "#30b0c7",
  "#007aff",
  "#af52de",
  "#ff2d55",
  "#8e8e93",
];

/** 边框线宽（像素） */
const BOX_LINE_WIDTH = 2;

/** 标签内文字与边缘的留白（像素） */
const LABEL_PADDING = 5;

/** 标签文字大小 */
const LABEL_FONT = "14px sans-serif";

/** 标签条高度（像素） */
const LABEL_HEIGHT = 20;

/** 标签底色不透明度：留一点透明，避免完全挡住框内的原图内容 */
const LABEL_ALPHA = 0.85;

/** 标签文字颜色 */
const LABEL_TEXT_COLOR = "#ffffff";

/** 置信度在标签里按百分比显示，保留整数位即可 */
const PERCENT_SCALE = 100;

/**
 * 在图片上绘制检测框，返回 PNG 图片（开发者 Jan）。
 *
 * @param input 原始图片字节，画框必须基于原图，因此这里重新解码一次
 * @param result 检测结果，坐标已是原图像素坐标
 */
export async function drawDetections(
  input: CvImageInput,
  result: DetectResult,
): Promise<ToolImage> {
  const bitmap = await createImageBitmap(new Blob([input.bytes as BlobPart], { type: input.mime }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建离屏画布，当前环境不支持绘制检测结果。");

    context.drawImage(bitmap, 0, 0);
    context.lineWidth = BOX_LINE_WIDTH;
    context.font = LABEL_FONT;
    context.textBaseline = "middle";

    for (const detection of result.detections) {
      const color = BOX_PALETTE[detection.classId % BOX_PALETTE.length];
      const { x, y, width, height } = detection.box;
      context.strokeStyle = color;
      context.strokeRect(x, y, width, height);

      const caption = `${detection.label} ${Math.round(detection.score * PERCENT_SCALE)}%`;
      const labelWidth = context.measureText(caption).width + LABEL_PADDING * 2;
      // 标签默认贴在框上沿外侧；顶到图片顶部时改贴框内侧，避免被裁掉
      const labelTop = y - LABEL_HEIGHT >= 0 ? y - LABEL_HEIGHT : y;

      context.globalAlpha = LABEL_ALPHA;
      context.fillStyle = color;
      context.fillRect(x, labelTop, labelWidth, LABEL_HEIGHT);
      context.globalAlpha = 1;

      context.fillStyle = LABEL_TEXT_COLOR;
      context.fillText(caption, x + LABEL_PADDING, labelTop + LABEL_HEIGHT / 2);
    }

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      mime: "image/png",
      base64: await blobToBase64(blob),
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}
