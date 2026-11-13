/**
 * 本地 CV 能力注册表（开发者 Jan）——任务、资产路径、默认参数的**唯一事实来源**。
 *
 * 与 `model/drawings.ts` 同风格：路径、语言、阈值、标签表全部集中声明，
 * 其余文件只引用，杜绝魔法值散落各处。资产由 `pnpm cv:assets` 在构建期生成到 `public/cv/`，
 * 运行期按下面的根相对地址取用，全程不联网。
 */

/** 生成的 CV 资产在前端静态目录下的名字 */
export const CV_ASSET_DIR = "cv";

/** 资产目录的根相对地址；onnxruntime 需要「目录」而不是具体文件，故单独给出 */
export const CV_ASSET_BASE_URL = `/${CV_ASSET_DIR}/`;

/** 把资产文件名拼成运行期可取用的地址 */
export function cvAssetUrl(fileName: string): string {
  return `${CV_ASSET_BASE_URL}${fileName}`;
}

/**
 * Tesseract 需要的三个资产文件名。
 *
 * 与 `scripts/sync-cv-assets.mjs` 的复制规则一一对应：脚本把包内文件重命名/挑选成这几个名字，
 * 两边必须同时改，因此集中在这里声明。
 */
export const TESSERACT_ASSETS = {
  /** worker 脚本：默认走 CDN，必须换成本地文件才能真正离线 */
  worker: "worker.min.js",
  /** 核心：只保留 simd + lstm 变体，与下面使用的 OEM.LSTM_ONLY 对应 */
  core: "tesseract-core-simd-lstm.wasm.js",
} as const;

/** OCR 支持的语言；与 `scripts/sync-cv-assets.mjs` 的语言表保持一致 */
export const OCR_LANGUAGES = [
  { id: "chi_sim", label: "简体中文" },
  { id: "eng", label: "英文" },
] as const;

/** OCR 语言 id 联合类型 */
export type OcrLanguageId = (typeof OCR_LANGUAGES)[number]["id"];

/** 默认同时识别中英文：客户端用户大部分截图都中英混排 */
export const OCR_DEFAULT_LANGUAGES: readonly OcrLanguageId[] = ["chi_sim", "eng"];

/** 多语言在 Tesseract 里用 `+` 连接 */
export const OCR_LANGUAGE_JOINER = "+";

/** 目标检测模型文件名（构建期下载一次） */
export const DETECTION_MODEL_FILE = "yolox_nano.onnx";

/** YOLOX-nano 的固定输入边长（正方形） */
export const DETECTION_INPUT_SIZE = 416;

/**
 * 三个特征层的下采样倍数。
 *
 * 顺序即网络输出的候选框排列顺序：`416 / 8 = 52`、`416 / 16 = 26`、`416 / 32 = 13`，
 * 合计 52² + 26² + 13² = 3549 个候选，与模型输出维度一一对应，不可重排。
 */
export const DETECTION_STRIDES: readonly number[] = [8, 16, 32];

/** 默认置信度阈值：低于它的框不返回，避免把噪声当目标 */
export const DETECTION_DEFAULT_THRESHOLD = 0.35;

/** 非极大值抑制的 IoU 阈值：越大越容易保留重叠框 */
export const DETECTION_NMS_IOU = 0.45;

/** 单张图最多返回的框数，防止密集场景把结果刷屏 */
export const DETECTION_MAX_RESULTS = 20;

/**
 * COCO 80 类标签表（YOLOX 训练集顺序）。
 *
 * 顺序即模型输出的类别下标，不可重排；缺标签会让结果只剩数字下标，用户无法理解。
 */
export const COCO_LABELS: readonly string[] = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
  "toothbrush",
];

/** 任意未知类别下标统一显示的标签，避免出现 `undefined` */
export const UNKNOWN_LABEL = "未知物体";
