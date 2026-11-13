/**
 * 图片产物的统一读取入口（开发者 Jan）。
 *
 * 「按名字取一张图片产物」是视觉工具（read_image）与本地 CV 工具（ocr_image / detect_objects）
 * 共同的第一步，且失败提示要一致（未找到时列出可用产物，让模型能自我纠正）。
 * 因此把这段收敛到一处，新增依赖图片产物的工具时直接复用，不再各写一份。
 */

import { artifactKind, artifactMime, listArtifacts, readArtifactBytes } from "../app/desktop/artifacts";

/** 图片产物的类型标识，与 `desktop.ts` 中 `artifactKind` 的返回值对应 */
const IMAGE_ARTIFACT_KIND = "image";

/** 读出的一张图片产物 */
export interface ImageArtifact {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * 读取结果：成功带图，失败带可直接回填给模型的可读文本。
 *
 * 用「判别联合」而不是抛异常：调用方都想把失败原因原样交给模型，而不是中断整轮运行。
 */
export type ImageArtifactResult =
  | { ok: true; image: ImageArtifact }
  | { ok: false; output: string };

/**
 * 按文件名读取一张图片产物（开发者 Jan）。
 *
 * @param artifactDir 当前会话的产物目录（项目会话为项目根下 `output/`，独立会话为缓存区 `outputs/<日期>/`）
 * @param name 产物文件名（含扩展名）
 */
export async function readImageArtifact(
  artifactDir: string,
  name: string,
): Promise<ImageArtifactResult> {
  const items = await listArtifacts(artifactDir);
  const target = items.find((item) => item.name === name);
  if (!target) {
    // 列出可用产物名，让模型能自我纠正而不必再调一次列目录工具
    const available = items.map((item) => item.name);
    return {
      ok: false,
      output:
        available.length > 0
          ? `未找到产物 ${name}。当前可用产物：${available.join("、")}`
          : `未找到产物 ${name}，当前没有任何产物。`,
    };
  }
  const kind = target.kind ?? artifactKind(name);
  if (kind !== IMAGE_ARTIFACT_KIND) {
    return { ok: false, output: `${name} 不是图片产物（类型：${kind}），该工具只能读取图片。` };
  }

  try {
    return {
      ok: true,
      image: { name, mime: artifactMime(name), bytes: await readArtifactBytes(artifactDir, name) },
    };
  } catch (error) {
    return {
      ok: false,
      output: `读取产物失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
