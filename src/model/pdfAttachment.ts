/** PDF 只在添加时加载解析器；提取文字后复用文本附件的发送与持久化通道。 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_PDF_TEXT_CHARS = 200_000;

/** 函数级说明（开发者 Jan）：执行 readPdfText 的单一职责，并返回可供调用方继续处理的结果。 */
export async function readPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    const { default: workerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
    stopAtErrors: true,
    disableFontFace: true,
  });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`超过 ${MAX_PDF_PAGES} 页，请拆分后添加`);
    }
    const pages: string[] = [];
    let length = 0;
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) =>
          "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
        ).join("").trim();
        length += text.length;
        if (length > MAX_PDF_TEXT_CHARS) throw new Error("文字内容过长，请拆分 PDF 后添加");
        if (text.length > 0) pages.push(`第 ${index} 页\n${text}`);
      } finally {
        page.cleanup();
      }
    }
    if (pages.length === 0) throw new Error("没有可提取的文字，扫描版 PDF 请先进行 OCR 或改发图片");
    return pages.join("\n\n");
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") {
      throw new Error("PDF 受密码保护，请解锁后重新添加");
    }
    throw error;
  } finally {
    await task.destroy();
  }
}
