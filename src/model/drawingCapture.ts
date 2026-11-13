/**
 * 3D 视图抓帧注册表（开发者 Jan）。
 *
 * 工具层需要「把用户当前看到的 3D 画面取下来」，但渲染色布在视图层（three.js）手里，
 * 让工具层直接 import 视图层会把依赖方向反过来，也会把 three 拉进工具所在的包。
 * 因此这里做一个模块级注册表：视图挂载时注册抓帧实现，工具层只调 `captureActiveDrawing()`。
 *
 * 同一时刻只可能有一个活动的 3D 视图，所以只保留一个槽位；新视图注册会覆盖旧实现，
 * 旧视图卸载时带守卫的注销不会误删新实现。
 */

/** 一次抓帧的结果：PNG 的 base64 与像素尺寸 */
export interface DrawingCaptureResult {
  /** PNG 内容的 base64 编码，不含 data URL 前缀 */
  base64: string;
  width: number;
  height: number;
}

/** 抓帧实现：无视图或尚未渲染完成时返回 null */
export type DrawingCapture = () => Promise<DrawingCaptureResult | null>;

let activeCapture: DrawingCapture | null = null;

/**
 * 注册当前 3D 视图的抓帧实现，返回注销函数。
 *
 * 注销时先比对引用：切图纸会「先卸载旧视图、再挂载新视图」，
 * 若旧视图在卸载时无脑清空槽位，就会把新视图刚注册的实现一并抹掉。
 */
export function registerDrawingCapture(capture: DrawingCapture): () => void {
  activeCapture = capture;
  return () => {
    if (activeCapture === capture) activeCapture = null;
  };
}

/** 当前是否有可抓帧的 3D 视图，供工具提示与界面按钮判断是否可用 */
export function hasDrawingCapture(): boolean {
  return activeCapture !== null;
}

/** 抓取当前 3D 视图；没有活动视图时返回 null，由调用方给出可读提示 */
export async function captureActiveDrawing(): Promise<DrawingCaptureResult | null> {
  return activeCapture ? activeCapture() : null;
}
