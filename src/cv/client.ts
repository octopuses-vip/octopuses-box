/**
 * 本地 CV 客户端（开发者 Jan）：OCR 与目标检测的执行入口。
 *
 * 三条约束决定了这里的写法：
 *   1. **运行期零联网**：所有 WASM、语言包、模型都从 `public/cv/` 按根相对地址取；
 *   2. **不套自定义 worker**：`tesseract.js` 的 `createWorker` 与 onnxruntime 的
 *      `env.wasm.proxy` 各自内部已带 worker，再包一层在 macOS WKWebView 上不可靠；
 *   3. **资产缺失要说人话**：`public/cv/` 不进版本库，全新克隆必须先跑 `pnpm cv:assets`，
 *      因此这里做前置检查并给出可操作提示，而不是把库内部的报错原样抛给用户。
 *
 * 重库（tesseract.js / onnxruntime-web）一律动态 import，不进主包，首次使用才加载。
 */

import {
  COCO_LABELS,
  CV_ASSET_BASE_URL,
  DETECTION_DEFAULT_THRESHOLD,
  DETECTION_INPUT_SIZE,
  DETECTION_MAX_RESULTS,
  DETECTION_MODEL_FILE,
  DETECTION_NMS_IOU,
  DETECTION_STRIDES,
  OCR_DEFAULT_LANGUAGES,
  OCR_LANGUAGES,
  OCR_LANGUAGE_JOINER,
  TESSERACT_ASSETS,
  UNKNOWN_LABEL,
  cvAssetUrl,
  type OcrLanguageId,
} from "./registry";
import type { CvImageInput, DetectResult, Detection, OcrResult, OcrWord } from "./types";

/** 资产缺失时抛出的错误：提示里带上修复命令，用户照着跑一次即可 */
export class CvAssetMissingError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `本地 CV 资产缺失（${missing.join("、")}）。请在项目根目录执行 \`pnpm cv:assets\` 生成 public/cv 后重试。`,
    );
    this.name = "CvAssetMissingError";
  }
}

/**
 * 探测一个资产是否可获取（开发者 Jan）。
 *
 * 用 HEAD 只取响应头，避免把十几兆的 WASM 白下一遍。探测本身失败（协议不支持 HEAD 等）
 * 时不判定为缺失——宁可让真正的加载流程报错，也不要因为探测手段不成立就误拦功能。
 */
async function isAssetMissing(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return !response.ok;
  } catch {
    return false;
  }
}

/** 逐个探测资产，全部就绪时返回，缺失时抛出带修复提示的错误 */
async function assertAssets(fileNames: readonly string[]): Promise<void> {
  const checks = await Promise.all(
    fileNames.map(async (fileName) => ({ fileName, missing: await isAssetMissing(cvAssetUrl(fileName)) })),
  );
  const missing = checks.filter((item) => item.missing).map((item) => item.fileName);
  if (missing.length > 0) throw new CvAssetMissingError(missing);
}

/**
 * 解析模型传入的语言参数（开发者 Jan）。
 *
 * 模型可能给 `zh`、`中文`、`chi_sim+eng`、空串等任意写法，这里按注册表的语言表归一：
 * 支持 `+` 分隔的多语言，识别不了的一律忽略；全部无效时回落到默认中英混识。
 */
export function normalizeOcrLanguages(raw: unknown): OcrLanguageId[] {
  if (typeof raw !== "string") return [...OCR_DEFAULT_LANGUAGES];
  const known = new Map<string, OcrLanguageId>();
  for (const language of OCR_LANGUAGES) {
    known.set(language.id.toLowerCase(), language.id);
    known.set(language.label.toLowerCase(), language.id);
  }
  const parsed = raw
    .split(OCR_LANGUAGE_JOINER)
    .map((item) => item.trim().toLowerCase())
    .map((item) => known.get(item))
    .filter((item): item is OcrLanguageId => item !== undefined);
  // 去重后按注册表顺序返回，保证同一个语言集合产生同一条缓存键
  const unique = new Set(parsed);
  const ordered = OCR_LANGUAGES.map((language) => language.id).filter((id) => unique.has(id));
  return ordered.length > 0 ? ordered : [...OCR_DEFAULT_LANGUAGES];
}

/**
 * 把页面结构里嵌套的 word 拍平成一维数组（开发者 Jan）。
 *
 * Tesseract 只暴露 `blocks → paragraphs → lines → words` 这棵结构树，
 * 而工具结果只需要「一串词及其位置」，因此在这里拍平；任一层为空都不应报错。
 */
function flattenWords(page: {
  blocks?: Array<{
    paragraphs?: Array<{ lines?: Array<{ words?: OcrWord[] }> }>;
  }> | null;
}): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          words.push({
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox,
          });
        }
      }
    }
  }
  return words;
}

/**
 * 对一张图片做离线 OCR（开发者 Jan）。
 *
 * @param input 图片字节与 MIME
 * @param languages 语言参数，任意写法都行，由 `normalizeOcrLanguages` 归一
 */
export async function runOcr(
  input: CvImageInput,
  languages?: unknown,
): Promise<OcrResult> {
  const langs = normalizeOcrLanguages(languages);
  await assertAssets([
    TESSERACT_ASSETS.worker,
    TESSERACT_ASSETS.core,
    ...langs.map((lang) => `${lang}.traineddata.gz`),
  ]);

  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker(langs.join(OCR_LANGUAGE_JOINER), OEM.LSTM_ONLY, {
    workerPath: cvAssetUrl(TESSERACT_ASSETS.worker),
    corePath: cvAssetUrl(TESSERACT_ASSETS.core),
    // langPath 给「目录」：tesseract 会自行拼上 `<lang>.traineddata.gz`
    langPath: CV_ASSET_BASE_URL,
    gzip: true,
  });
  try {
    const image = new Blob([input.bytes as BlobPart], { type: input.mime });
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    return {
      text: data.text.trim(),
      confidence: data.confidence,
      words: flattenWords(data),
    };
  } finally {
    // 无论成功失败都要回收 worker：它常驻一个 WASM 实例，泄漏一次就多占几十兆
    await worker.terminate();
  }
}

/**
 * 解码后的候选框（开发者 Jan）：只有类别下标与分数，标签要等映射 COCO 表时才补。
 *
 * 与 `Detection` 的唯一差别就是缺 `label`，故直接由它派生，避免两处类型各写一遍导致漂移。
 */
type DecodedBox = Omit<Detection, "label">;

/** 把 YOLOX 的网络输出解码成候选框（开发者 Jan） */
function decodeYolox(output: Float32Array, classCount: number): DecodedBox[] {
  const candidates: DecodedBox[] = [];
  let offset = 0;
  for (const stride of DETECTION_STRIDES) {
    const gridSize = DETECTION_INPUT_SIZE / stride;
    for (let row = 0; row < gridSize; row += 1) {
      for (let column = 0; column < gridSize; column += 1) {
        const base = offset;
        offset += 4 + 1 + classCount;
        // 导出的 ONNX 未做解码：前两个数是相对网格左上角的偏移，后两个是宽高的对数值
        const centerX = (output[base] + column) * stride;
        const centerY = (output[base + 1] + row) * stride;
        const width = Math.exp(output[base + 2]) * stride;
        const height = Math.exp(output[base + 3]) * stride;

        let bestScore = 0;
        let bestClass = -1;
        for (let index = 0; index < classCount; index += 1) {
          const score = output[base + 5 + index];
          if (score > bestScore) {
            bestScore = score;
            bestClass = index;
          }
        }
        if (bestClass < 0) continue;
        // 最终分数 = 类别概率 × 目标置信度（objectness 在导出时已过 sigmoid）
        const confidence = bestScore * output[base + 4];
        if (confidence <= 0) continue;
        candidates.push({
          classId: bestClass,
          score: confidence,
          box: {
            x: centerX - width / 2,
            y: centerY - height / 2,
            width,
            height,
          },
        });
      }
    }
  }
  return candidates;
}

/** 计算两个框的交并比，供 NMS 使用 */
function intersectionOverUnion(a: Detection["box"], b: Detection["box"]): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(right - left, 0) * Math.max(bottom - top, 0);
  if (overlap <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/**
 * 按类别做非极大值抑制（开发者 Jan）。
 *
 * 同一类只保留得分最高且与已保留框重叠不超过阈值的那些；不同类别互不抑制，
 * 因为「人骑马」这类场景里不同类别的框本就该重叠。
 */
function nonMaxSuppression(items: Detection[], iouThreshold: number, limit: number): Detection[] {
  const kept: Detection[] = [];
  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const overlapped = kept.some(
      (other) => other.classId === item.classId && intersectionOverUnion(other.box, item.box) > iouThreshold,
    );
    if (overlapped) continue;
    kept.push(item);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** 把检测框裁剪到图片范围内，避免画框时越界 */
function clipToImage(box: Detection["box"], width: number, height: number): Detection["box"] {
  const x = Math.min(Math.max(box.x, 0), width);
  const y = Math.min(Math.max(box.y, 0), height);
  return {
    x,
    y,
    width: Math.max(Math.min(box.width, width - x), 0),
    height: Math.max(Math.min(box.height, height - y), 0),
  };
}

/**
 * 把检测框从「letterbox 后的方形输入空间」还原到原图像素坐标（开发者 Jan）。
 *
 * 预处理做过「等比缩放 + 居中留边」，逆运算就是先减掉留边、再除以缩放比；
 * 缩回原图后可能超出边界（模型偶尔预测到画布外），故最后统一裁剪。
 */
function toImageSpace(
  box: Detection["box"],
  transform: { scale: number; padX: number; padY: number; width: number; height: number },
): Detection["box"] {
  return clipToImage(
    {
      x: (box.x - transform.padX) / transform.scale,
      y: (box.y - transform.padY) / transform.scale,
      width: box.width / transform.scale,
      height: box.height / transform.scale,
    },
    transform.width,
    transform.height,
  );
}

/**
 * 对一张图片做离线目标检测（开发者 Jan）。
 *
 * 走 onnxruntime-web 的 WASM 后端：`numThreads = 1` 是因为多线程需要 SharedArrayBuffer，
 * 而它要求 COOP/COEP 响应头，Tauri 下不好配，单线程对 416×416 的 nano 模型足够快。
 */
export async function runDetection(
  input: CvImageInput,
  options: { threshold?: number; maxResults?: number } = {},
): Promise<DetectResult> {
  await assertAssets([DETECTION_MODEL_FILE]);
  const threshold = options.threshold ?? DETECTION_DEFAULT_THRESHOLD;
  const maxResults = Math.max(1, options.maxResults ?? DETECTION_MAX_RESULTS);

  const ort = await import("onnxruntime-web");
  // 让运行时从本地目录取 WASM；proxy 把推理放进库自带 worker，避免阻塞界面
  ort.env.wasm.wasmPaths = CV_ASSET_BASE_URL;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = true;

  const bitmap = await createImageBitmap(new Blob([input.bytes as BlobPart], { type: input.mime }));
  try {
    // 等比缩放后居中贴到正方形输入上（letterbox），保证几何比例不被拉伸
    const scale = Math.min(DETECTION_INPUT_SIZE / bitmap.width, DETECTION_INPUT_SIZE / bitmap.height);
    const drawWidth = Math.round(bitmap.width * scale);
    const drawHeight = Math.round(bitmap.height * scale);
    const padX = Math.floor((DETECTION_INPUT_SIZE - drawWidth) / 2);
    const padY = Math.floor((DETECTION_INPUT_SIZE - drawHeight) / 2);

    const canvas = new OffscreenCanvas(DETECTION_INPUT_SIZE, DETECTION_INPUT_SIZE);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建离屏画布，当前环境不支持目标检测。");
    context.fillStyle = "#000000";
    context.fillRect(0, 0, DETECTION_INPUT_SIZE, DETECTION_INPUT_SIZE);
    context.drawImage(bitmap, padX, padY, drawWidth, drawHeight);

    const pixels = context.getImageData(0, 0, DETECTION_INPUT_SIZE, DETECTION_INPUT_SIZE).data;
    const tensorData = new Float32Array(DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE * 3);
    for (let index = 0; index < DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE; index += 1) {
      tensorData[index] = pixels[index * 4] / 255;
      tensorData[index + DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE] = pixels[index * 4 + 1] / 255;
      tensorData[index + DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE * 2] = pixels[index * 4 + 2] / 255;
    }

    const session = await ort.InferenceSession.create(cvAssetUrl(DETECTION_MODEL_FILE), {
      executionProviders: ["wasm"],
    });
    try {
      const inputName = session.inputNames[0];
      const tensor = new ort.Tensor("float32", tensorData, [1, 3, DETECTION_INPUT_SIZE, DETECTION_INPUT_SIZE]);
      const output = await session.run({ [inputName]: tensor });
      const raw = output[session.outputNames[0]].data as Float32Array;
      const transform = { scale, padX, padY, width: bitmap.width, height: bitmap.height };

      const candidates: Detection[] = decodeYolox(raw, COCO_LABELS.length)
        .filter((item) => item.score >= threshold)
        .map((item) => ({
          classId: item.classId,
          score: item.score,
          label: COCO_LABELS[item.classId] ?? UNKNOWN_LABEL,
          box: toImageSpace(item.box, transform),
        }));

      return {
        width: bitmap.width,
        height: bitmap.height,
        detections: nonMaxSuppression(candidates, DETECTION_NMS_IOU, maxResults),
      };
    } finally {
      await session.release();
    }
  } finally {
    bitmap.close();
  }
}
