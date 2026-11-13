/**
 * 工具产出图片的统一表示（开发者 Jan）。
 *
 * 视觉链路的「一个出口」：无论图片来自屏幕截图、3D 视图抓帧、产物读取还是 CV 画框，
 * 都以本结构交给运行期，再由运行期统一转成 `image_url` 附到下一条用户消息上。
 * 这样新增视觉工具时不必各自再造一条多模态通道。
 */

import type { ChatContentPart } from "./client";
import { bytesToDataUrl } from "./attachments";

/** 工具产出的一张图片；`base64` 不含 data URL 前缀 */
export interface ToolImage {
  /** 建议的产物文件名（含扩展名），仅落盘场景需要，用于回灌时可以省略 */
  name?: string;
  /** MIME 类型，如 `image/png` */
  mime: string;
  /** 图片内容的 base64 编码 */
  base64: string;
  width?: number;
  height?: number;
}

/** 把工具产出的图片转成 OpenAI 兼容的 `image_url` 片段 */
export function toImageContentPart(image: ToolImage): ChatContentPart {
  return {
    type: "image_url",
    image_url: { url: bytesToDataUrl(image.mime, image.base64) },
  };
}

/** 一次 `btoa` 能安全接收的参数个数上限，避免大图把调用栈撑爆 */
const BINARY_CHUNK = 0x8000;

/**
 * 把字节转成 base64（开发者 Jan）。
 *
 * 读产物得到的是字节，而多模态入参要 base64，因此需要这一层转换；
 * 按块拼接二进制串，避免一次性展开几十万参数触发 `RangeError`。
 */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK));
  }
  return btoa(binary);
}

/** 把画布导出的 Blob 读成 base64（不含 data URL 前缀） */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      // readAsDataURL 的结果形如 data:image/png;base64,xxxx，只取逗号之后的部分
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取画布截图失败"));
    reader.readAsDataURL(blob);
  });
}
