/**
 * 输入附件处理：把粘贴或拖拽进来的文件转成会话可携带的附件，
 * 并在发送时转换成 OpenAI 兼容的多模态入参。
 */

import { nextId } from "../app/ids";
import type { MessageAttachment } from "../app/types";
import type { ChatContentPart } from "./client";

/** 单张图片的大小上限 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单个文本文件的大小上限 */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** 可按文本读取的扩展名（不少文本文件在系统里拿不到 text/* 的 MIME，按扩展名兜底） */
const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "json", "jsonc", "csv", "tsv", "log", "yml", "yaml",
  "xml", "html", "htm", "css", "scss", "js", "jsx", "ts", "tsx", "vue",
  "java", "kt", "py", "rs", "go", "rb", "php", "sql", "sh", "zsh",
  "toml", "ini", "conf", "env", "gradle", "properties",
  "c", "h", "cc", "cpp", "hpp", "cs", "swift", "dart", "r", "svelte", "bat", "ps1",
];

/**
 * 扩展名 → MIME 对照（开发者 Jan）：只覆盖本应用真正会处理的类型。
 *
 * 这张表的存在理由：桌面端原生拖放只给本机绝对路径，还原成 `File` 时若不显式带类型，
 * `file.type` 就是空串；而附件的分流（图片走 data URL、文本走 `<file>` 块）全看它，
 * 于是拖进来的 PNG 会被判成「未知类型」直接拒掉——它其实是被支持的。
 * 浏览器端由系统给 File 带好 MIME，两条通道必须归一到同一份判定依据上。
 */
const EXTENSION_MIME: Record<string, string> = {
  // 图片：与 createAttachment 的 `image/` 分支对应
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  // 文本：与 TEXT_EXTENSIONS 白名单保持一致，避免同一种文件在两条判定里落到不同分支
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  yml: "text/yaml",
  yaml: "text/yaml",
  xml: "text/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/x-scss",
  js: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  vue: "text/plain",
  java: "text/plain",
  kt: "text/plain",
  py: "text/x-python",
  rs: "text/plain",
  go: "text/plain",
  rb: "text/x-ruby",
  php: "text/x-php",
  sql: "text/plain",
  sh: "text/x-sh",
  zsh: "text/x-sh",
  toml: "text/plain",
  ini: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  gradle: "text/plain",
  properties: "text/plain",
  // 其余二进制：写出来只为了让拒绝提示能报出真实类型，而不是笼统的「未知类型」
  pdf: "application/pdf",
};

/**
 * 取文件名的扩展名（开发者 Jan），统一转小写、不带点。
 *
 * 无扩展名或隐藏文件（如 .gitignore）返回空串：隐藏文件不应被当成有扩展名的文件，
 * 否则扩展名判定会把 .gitignore 的「扩展名」认成 gitignore 而走错分支。
 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * 按扩展名推断 MIME（开发者 Jan）；认不出时返回空串。
 *
 * 空串不代表拒绝：`isTextFile` 仍按扩展名白名单兜底，未知类型交由 `createAttachment`
 * 给出可读的拒绝原因。路径还原成 `File` 时要用它补齐类型。
 */
export function mimeFromName(name: string): string {
  return EXTENSION_MIME[extensionOf(name)] ?? "";
}

/** 是否按文本处理：`text/*` 或扩展名在白名单内 */
export function isTextFile(file: File): boolean {
  return file.type.startsWith("text/") || TEXT_EXTENSIONS.includes(extensionOf(file.name)) ||
    /^(?:\.(?:env(?:\..+)?|gitignore|gitattributes|editorconfig|npmrc)|Dockerfile|Makefile|LICENSE)$/i.test(file.name);
}

/** 文件管理器未提供 MIME 时按扩展名兜底，图片权限判断与实际读取使用同一类型。 */
export function attachmentMime(file: File): string {
  return file.type || mimeFromName(file.name);
}

export type AttachmentResult =
  | { ok: true; attachment: MessageAttachment }
  | { ok: false; reason: string };

/** 把字节数格式化成人读的大小，用于附件条与消息气泡 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 把文件读成 data URL（开发者 Jan）：图片走这条路径，随消息以 image_url 发送 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

/** 把文件读成文本（开发者 Jan）：文本文件内联为 file 块随消息发送 */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsText(file);
  });
}

/** 剪贴板里的图片常常没有文件名，按 MIME 补一个 */
function fallbackName(file: File): string {
  if (file.name.length > 0) return file.name;
  const subtype = file.type.split("/")[1];
  return subtype ? `粘贴的图片.${subtype}` : "粘贴的图片";
}

/**
 * 读取一个文件为附件。图片存 data URL，文本文件与 PDF 存可读文字；
 * 不支持的二进制文件明确拒绝，避免发出只有文件名却没有可读内容的附件。
 */
export async function createAttachment(file: File): Promise<AttachmentResult> {
  const name = fallbackName(file);
  const mime = attachmentMime(file);

  if (mime === "application/pdf" || extensionOf(name) === "pdf") {
    const { MAX_PDF_BYTES, readPdfText } = await import("./pdfAttachment");
    if (file.size > MAX_PDF_BYTES) {
      return { ok: false, reason: `${name} 超过 ${formatBytes(MAX_PDF_BYTES)}，未添加` };
    }
    try {
      const text = await readPdfText(file);
      return {
        ok: true,
        attachment: { id: nextId("att"), name, mime: "application/pdf", size: file.size, kind: "file", dataUrl: null, text },
      };
    } catch (error) {
      return { ok: false, reason: `${name}：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (mime.startsWith("image/")) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `${name} 超过 ${formatBytes(MAX_IMAGE_BYTES)}，未添加` };
    }
    return {
      ok: true,
      attachment: {
        id: nextId("att"),
        name,
        mime,
        size: file.size,
        kind: "image",
        dataUrl: await readAsDataUrl(file.type ? file : new File([file], name, { type: mime })),
        text: null,
      },
    };
  }

  if (isTextFile(file)) {
    if (file.size > MAX_TEXT_BYTES) {
      return { ok: false, reason: `${name} 超过 ${formatBytes(MAX_TEXT_BYTES)}，未添加` };
    }
    return {
      ok: true,
      attachment: {
        id: nextId("att"),
        name,
        mime: file.type || "text/plain",
        size: file.size,
        kind: "file",
        dataUrl: null,
        text: await readAsText(file),
      },
    };
  }

  return { ok: false, reason: `${name}（${mime || "未知类型"}）暂不支持，仅支持图片、PDF 与文本文件` };
}

/**
 * 把后端回传的 base64 拼成 data URL。
 *
 * 截图 / 网页截图走的是与用户粘贴图片完全相同的 `image_url` 通路，
 * 这样「看 → 点 → 再看」的视觉闭环不需要另开一条多模态通道。
 */
export function bytesToDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** 把正文与附件拼成接口入参：文本文件内联为 `<file>` 块，图片追加为 image_url 片段 */
export function toUserContent(
  text: string,
  attachments: MessageAttachment[],
): string | ChatContentPart[] {
  if (attachments.length === 0) return text;

  const images = attachments.filter((item) => item.kind === "image" && item.dataUrl !== null);
  const files = attachments.filter((item) => item.kind === "file" && item.text !== null);

  let body = text;
  for (const file of files) {
    body += `${body.trim().length > 0 ? "\n\n" : ""}<file name="${file.name}">\n${file.text ?? ""}\n</file>`;
  }

  const parts: ChatContentPart[] = [];
  if (body.trim().length > 0) parts.push({ type: "text", text: body });
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: image.dataUrl as string } });
  }
  return parts;
}
