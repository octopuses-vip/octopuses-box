/**
 * 图纸来源抽象（开发者 Jan）。
 *
 * 「3D」tab 要同时展示两类图纸：模型写出的产物（项目会话在项目 `output/`，临时会话在缓存
 * `outputs/<日期>/`）与用户导入的图纸（会话工作目录 `imports/`）。两者的元信息字段一致，但字节的读取方式完全不同，
 * 因此在这里统一成同一种可渲染条目——预览组件只认这一种，不关心它从哪来。
 * 将来若再加一种来源（例如云端转换结果），只需在这里多合并一路，视图无需改动。
 */

import { readFileBytes, type FileLocation } from "../app/desktop/files";
import type { ArtifactInfo, DirEntryInfo } from "../app/types";
import { DRAWINGS_DIR, drawingFormatOf, type DrawingFormat } from "./drawings";

/** 图纸来源的种类：模型产物 / 会话工作目录下的导入文件 */
export type DrawingOrigin = "artifact" | "import";

/** 一个可预览、可导出的图纸条目 */
export interface DrawingEntry {
  /** 列表 key 与选中标识（见 [`drawingEntryKey`]） */
  key: string;
  name: string;
  /** 字节数 */
  bytes: number;
  /** 最后写入时间（Unix 秒） */
  modifiedAt: number;
  format: DrawingFormat;
  /** 直接可喂给 `readFileBytes` / `transferFile` 的位置描述 */
  source: FileLocation;
  origin: DrawingOrigin;
}

/**
 * 生成图纸条目的 key。
 *
 * 两类来源可能撞名（模型写出的 `part.step` 与用户导入的 `part.step`），
 * 因此带上来源前缀，保证列表 key 与选中标识都唯一。
 */
export function drawingEntryKey(origin: DrawingOrigin, name: string): string {
  return `${origin}:${name}`;
}

/**
 * 把两类来源合并成一份图纸列表（开发者 Jan）。
 *
 * 只保留扩展名命中图纸注册表的文件，其余（普通产物）由各自的 tab 负责。
 * 产物排在导入之前：模型刚写出的图纸通常是用户马上要看的东西。
 * 两侧都保持后端给出的时间倒序，不在此重新排序。
 */
export function mergeDrawingEntries(
  artifacts: ArtifactInfo[],
  imports: DirEntryInfo[],
  artifactDir: string,
  projectPath: string,
): DrawingEntry[] {
  const entries: DrawingEntry[] = [];
  for (const artifact of artifacts) {
    const format = drawingFormatOf(artifact.name);
    if (!format) continue;
    entries.push({
      key: drawingEntryKey("artifact", artifact.name),
      name: artifact.name,
      bytes: artifact.bytes,
      modifiedAt: artifact.modifiedAt,
      format,
      origin: "artifact",
      source: { kind: "artifact", dir: artifactDir, name: artifact.name },
    });
  }
  for (const item of imports) {
    const format = drawingFormatOf(item.name);
    if (!format) continue;
    entries.push({
      key: drawingEntryKey("import", item.name),
      name: item.name,
      bytes: item.bytes,
      modifiedAt: item.modifiedAt,
      format,
      origin: "import",
      source: {
        kind: "workspace",
        projectPath,
        path: `${DRAWINGS_DIR}/${item.name}`,
      },
    });
  }
  return entries;
}

/** 读取一个图纸条目的原始字节，交给 WASM 解析或还原成 `File` */
export function readDrawingBytes(entry: DrawingEntry): Promise<Uint8Array<ArrayBuffer>> {
  return readFileBytes(entry.source);
}
