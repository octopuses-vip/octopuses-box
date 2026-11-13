/**
 * 把本地 CV 资产同步到 `public/cv/`（开发者 Jan）。
 *
 * 背景：本项目要求「运行期零联网」，因此 OCR 与目标检测要用到的 WASM、语言包、模型
 * 必须在构建期就落到前端静态目录里，再由界面按 `/cv/xxx` 的根相对路径取用。
 * 这条命令需要在全新克隆后先跑一次，否则 CV 工具会提示「资产缺失」。
 *
 * 做法：从 `node_modules` 里**按模式匹配**复制（不写死具体文件名，适应包内布局变化），
 * 只有 ONNX 模型需要联网下载一次；目标文件已存在时跳过，可用 `--force` 强制重下。
 *
 * 下载地址可用环境变量 `CV_MODEL_MIRROR` 覆盖前缀（例如镜像站），
 * 项目配置里不写死任何镜像地址，避免影响其它网络环境的开发者。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录：脚本位于 `<root>/scripts/` 下 */
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES_DIR = join(PROJECT_ROOT, "node_modules");
/** 生成物目录：与前端 `public/` 约定一致，不进版本库 */
const OUT_DIR = join(PROJECT_ROOT, "public", "cv");
const FORCE = process.argv.includes("--force");

/** OCR 需要打包的语言包（与 src/cv/registry.ts 中的语言表保持一致） */
const OCR_LANGUAGES = ["chi_sim", "eng"];

/**
 * 从 `node_modules` 复制资产的规则。
 *
 * `include` 用正则匹配文件名而不是写死全名：包升级后可能改名（如 multi-thread 变体），
 * 按模式复制能自动跟上，不必每次改脚本。
 */
const COPY_RULES = [
  {
    // Tesseract 的 worker 脚本：默认走 CDN，必须换成本地文件才能真正离线
    from: ["tesseract.js", "dist"],
    include: /^worker(\.min)?\.js$/,
    target: "worker.min.js",
  },
  {
    // tesseract 的核心：只保留 simd + lstm 变体，正好对上下面 registry 里指定的 OEM.LSTM_ONLY。
    // 其余变体（含非 simd、含全量识别）在任何现代 WebView 上都不会被选中，留着白占体积。
    from: ["tesseract.js-core"],
    include: /^tesseract-core-simd-lstm\.wasm(\.js)?$/,
  },
  {
    // onnxruntime-web 的运行时：加载器（.mjs）与 WASM 二进制必须同目录才能在本地加载。
    // 只取默认的 simd / simd-threaded 变体，排除 asyncify、jsep(WebGPU)、jspi 等平台特化大文件。
    from: ["onnxruntime-web", "dist"],
    include: /^ort-wasm-(simd-threaded|simd)\.(wasm|mjs)$/,
  },
];

/** 需要联网下载的模型；`CV_MODEL_MIRROR` 可覆盖前缀 */
const MODEL_SOURCE =
  "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx";
const MODEL_TARGET = "yolox_nano.onnx";

/**
 * 递归列出目录下的文件（开发者 Jan）。
 *
 * 目录不存在时返回空数组：包内布局变化后由调用方给出可读报错，而不是抛栈。
 */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 按规则把 node_modules 里的资产复制到 `public/cv/`，返回已落地的文件名 */
function copyFromModules() {
  const copied = [];
  for (const rule of COPY_RULES) {
    const sourceDir = join(MODULES_DIR, ...rule.from);
    const matched = listFiles(sourceDir).filter((file) => rule.include.test(file.split(/[\\/]/).pop()));
    if (matched.length === 0) {
      throw new Error(`未在 ${rule.from.join("/")} 下找到匹配 ${rule.include} 的资产`);
    }
    for (const file of matched) {
      const fileName = rule.target ?? file.split(/[\\/]/).pop();
      copyFileSync(file, join(OUT_DIR, fileName));
      // 部分桌面 WebView 将 .mjs 静态资源按 HTML 回退，保留一个 .js 别名供 ONNX Runtime 动态 import。
      if (fileName === "ort-wasm-simd-threaded.mjs") copyFileSync(file, join(OUT_DIR, "ort-wasm-simd-threaded.js"));
      copied.push(fileName);
    }
  }
  return copied;
}

/**
 * 复制 OCR 语言包（开发者 Jan）。
 *
 * 语言包在包内按版本目录分层（如 `4.0.0/`、`4.0.0_best_int/`）：
 * `4.0.0_best_int` 是「最佳精度 + 整数量化」，体积反而比 `4.0.0` 小一个数量级，
 * 因此优先选它；包内布局变化导致找不到时，退回路径最短的一份，保证脚本不脆。
 */
function copyLanguageData() {
  const copied = [];
  for (const lang of OCR_LANGUAGES) {
    const dir = join(MODULES_DIR, "@tesseract.js-data", lang);
    const candidates = listFiles(dir).filter((file) => file.endsWith(`${lang}.traineddata.gz`));
    if (candidates.length === 0) {
      throw new Error(`未找到语言包 ${lang}，请确认已安装 @tesseract.js-data/${lang}`);
    }
    const best = candidates.find((file) => file.includes("best_int")) ?? [...candidates].sort(
      (a, b) => a.length - b.length,
    )[0];
    const fileName = `${lang}.traineddata.gz`;
    copyFileSync(best, join(OUT_DIR, fileName));
    copied.push(fileName);
  }
  return copied;
}

/** 下载 ONNX 模型（已存在且未指定 `--force` 时跳过），返回是否发生了下载 */
async function downloadModel() {
  const target = join(OUT_DIR, MODEL_TARGET);
  if (existsSync(target) && !FORCE) {
    console.log(`- ${MODEL_TARGET} 已存在，跳过下载（如需重下加 --force）`);
    return false;
  }
  const mirror = (process.env.CV_MODEL_MIRROR ?? "").trim();
  const url = mirror.length > 0 ? `${mirror.replace(/\/+$/, "")}/${MODEL_SOURCE}` : MODEL_SOURCE;
  console.log(`- 正在下载 ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `模型下载失败：HTTP ${response.status}。国内网络可设置 CV_MODEL_MIRROR 指向镜像前缀后重试。`,
    );
  }
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return true;
}

/** 打印目录体积，便于确认资产是否齐全 */
function reportSize() {
  const files = listFiles(OUT_DIR);
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  console.log(`\npublic/cv 共 ${files.length} 个文件，合计 ${(bytes / 1024 / 1024).toFixed(1)} MB：`);
  for (const file of files.sort()) {
    console.log(`  ${relative(OUT_DIR, file)}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("同步本地 CV 资产 →", OUT_DIR);
  const files = [...copyFromModules(), ...copyLanguageData()];
  console.log(`- 已复制 ${files.length} 个文件：${files.join("、")}`);
  await downloadModel();
  reportSize();
}

main().catch((error) => {
  console.error(`\n资产同步失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
