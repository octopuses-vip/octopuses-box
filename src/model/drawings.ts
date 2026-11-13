/**
 * 图纸格式注册表（开发者 Jan）。
 *
 * 「哪些扩展名算图纸、用哪个解析器、对话框里怎么过滤」全部集中在这里定义一次：
 * 拖放路由、导入对话框的过滤器、右栏列表与 3D 预览都从这里取值，
 * 避免扩展名判断散落到各个组件里——加一种格式却漏改某处，是最容易出的错。
 */

import type { FileFilter } from "../app/desktop/system";

/** 会话工作目录下存放导入图纸的子目录（唯一来源，导入与列举共用同一个名字） */
export const DRAWINGS_DIR = "imports";

/**
 * 前端的解析方式。
 *
 * `step` / `iges` 都跑在同一个 OpenCascade WASM 上，但走的是两个不同的读取入口
 * （`ReadStepFile` / `ReadIgesFile`），因此在这里分开标注，由预览组件据此分派；
 * `null` 表示本客户端无法解析该格式。
 */
export type DrawingParser = "step" | "iges" | null;

export interface DrawingFormat {
  /** 稳定标识，预览时按它分派解析器 */
  id: string;
  /** 展示名，出现在列表与系统文件对话框里 */
  label: string;
  /** 该格式的扩展名（小写、不含点） */
  extensions: string[];
  parser: DrawingParser;
  mime: string;
  /** 无法解析时给用户的下一步引导；能解析的格式不需要 */
  hint?: string;
}

/**
 * 本客户端认识的图纸格式。
 *
 * DWG 没有可用的开源前端解析方案（浏览器里跑不动），因此明确标成不可解析、
 * 只给引导而不是假装支持——它照样能导入、能导出、能交给 AI 处理。
 */
export const DRAWING_FORMATS: DrawingFormat[] = [
  {
    id: "step",
    label: "STEP",
    extensions: ["step", "stp"],
    parser: "step",
    mime: "application/step",
  },
  {
    id: "iges",
    label: "IGES",
    extensions: ["iges", "igs"],
    parser: "iges",
    mime: "model/iges",
  },
  {
    id: "dwg",
    label: "DWG",
    extensions: ["dwg"],
    parser: null,
    mime: "image/vnd.dwg",
    hint: "本客户端无法解析 DWG。可以让 AI 用本机的 ODA File Converter 或 FreeCAD 转成 STEP，再重新导入预览。",
  },
];

/** 从文件名取小写扩展名（不含点）；没有扩展名时返回空串 */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

/**
 * 从路径里取文件名（开发者 Jan）。
 *
 * 拖放与「浏览文件」拿到的都是本机绝对路径，而格式判断只认文件名，因此在进入注册表之前
 * 统一剥掉目录部分。Windows 用反斜杠、POSIX 用正斜杠，两种分隔符都要断开，
 * 否则从 Windows 路径里取出的「文件名」会带上整条目录。
 */
export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** 按文件名找对应的图纸格式；不是图纸时返回 null */
export function drawingFormatOf(name: string): DrawingFormat | null {
  const extension = fileExtension(name);
  if (extension.length === 0) return null;
  return DRAWING_FORMATS.find((format) => format.extensions.includes(extension)) ?? null;
}

/** 是否是本客户端认识的图纸文件（拖放路由与列表筛选共用同一个判断） */
export function isDrawingFile(name: string): boolean {
  return drawingFormatOf(name) !== null;
}

/** 系统文件对话框的类型过滤器：一条「图纸文件」总览 + 每种格式各一条 */
export function drawingFileFilters(): FileFilter[] {
  return [
    { name: "图纸文件", extensions: DRAWING_FORMATS.flatMap((format) => format.extensions) },
    ...DRAWING_FORMATS.map((format) => ({ name: format.label, extensions: format.extensions })),
  ];
}
