/** 会话上下文的本地文件解析：输出纯文本，绝不把二进制内容直接塞进模型请求。 */
export const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;

/** 函数级说明（开发者 Jan）：执行 looksBinary 的单一职责，并返回可供调用方继续处理的结果。 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8192);
  const controls = sample.match(/[\u0000-\u0008\u000b\u000e-\u001f]/g)?.length ?? 0;
  return sample.includes("\0") || controls > Math.max(2, sample.length / 100);
}

/** BOM 优先；无 BOM 时严格尝试 UTF-8，再兼容 GB18030（含常见 GBK 文本）。 */
export function decodeContextText(bytes: Uint8Array): string {
  let encoding: string | null = null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes.length >= 8 && bytes.length % 2 === 0) {
    const sample = bytes.subarray(0, 1024);
    let evenZeros = 0;
    let oddZeros = 0;
    sample.forEach((byte, index) => { if (byte === 0) index % 2 ? oddZeros++ : evenZeros++; });
    if (oddZeros > sample.length / 4 && evenZeros === 0) encoding = "utf-16le";
    else if (evenZeros > sample.length / 4 && oddZeros === 0) encoding = "utf-16be";
  }
  let text: string;
  try {
    text = new TextDecoder(encoding ?? "utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (encoding) throw new Error("文本编码不完整，请转换为 UTF-8 后重试");
    try {
      text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("无法识别文本编码，请转换为 UTF-8 后重试");
    }
  }
  if (looksBinary(text)) throw new Error("文件包含二进制数据，无法作为文本上下文读取");
  return text;
}

/** 函数级说明（开发者 Jan）：执行 readContextFile 的单一职责，并返回可供调用方继续处理的结果。 */
export async function readContextFile(name: string, bytes: Uint8Array<ArrayBuffer>, maxBytes = MAX_CONTEXT_FILE_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("文件大小上限无效");
  if (bytes.length > maxBytes) throw new Error(`文件超过 ${maxBytes / (1024 * 1024)} MB，请调整上传限制或拆分后添加`);
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (["docx", "xlsx", "pptx"].includes(extension)) {
    const { readOfficeText } = await import("./officeText");
    return readOfficeText(extension, bytes);
  }
  if (extension === "pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    const { readPdfText } = await import("../model/pdfAttachment");
    return readPdfText(new File([bytes], name, { type: "application/pdf" }));
  }
  if (["doc", "xls", "ppt", "rtf"].includes(extension)) {
    throw new Error("此格式暂不支持，请转换为 DOCX、XLSX、PPTX、PDF 或纯文本后添加");
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tif", "tiff", "avif"].includes(extension)) {
    throw new Error("图片请通过「添加附件」发送，扫描文档可先 OCR 再附加文字");
  }
  if ((bytes[0] === 0x50 && bytes[1] === 0x4b) ||
      (bytes[0] === 0xd0 && bytes[1] === 0xcf) ||
      ["zip", "7z", "rar", "gz", "exe", "dll", "wasm", "mp3", "mp4", "sqlite", "db"].includes(extension)) {
    throw new Error("压缩包或二进制文件无法直接读取，请先解压或导出为支持的文档格式");
  }
  return decodeContextText(bytes);
}
