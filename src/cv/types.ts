/**
 * 本地计算机视觉（CV）的类型定义（开发者 Jan）。
 *
 * 全部在浏览器 / WebView 内用 WASM 完成，运行期不联网、不调用任何云端接口；
 * 这里只放数据结构，任务清单与资产路径集中在 `registry.ts`。
 */

/** 一次 CV 任务的输入图片 */
export interface CvImageInput {
  /** 来源文件名，仅用于日志与产物命名 */
  name: string;
  /** MIME 类型，如 `image/png` */
  mime: string;
  /** 原始图片字节 */
  bytes: Uint8Array;
}

/** OCR 识别出的一个词及其位置（像素坐标，相对原图左上角） */
export interface OcrWord {
  text: string;
  /** 0-100 的置信度 */
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** 一次 OCR 的结果 */
export interface OcrResult {
  /** 识别出的完整文本，按行拼接 */
  text: string;
  /** 整体置信度 0-100 */
  confidence: number;
  words: OcrWord[];
}

/** 目标检测框（像素坐标，相对原图左上角） */
export interface DetectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一个检测到的目标 */
export interface Detection {
  /** 人类可读的类别名 */
  label: string;
  /** 模型输出的类别下标 */
  classId: number;
  /** 0-1 的置信度 */
  score: number;
  box: DetectionBox;
}

/** 一次目标检测的结果 */
export interface DetectResult {
  /** 原图像素尺寸，用于把归一化坐标还原成像素坐标 */
  width: number;
  height: number;
  detections: Detection[];
}
