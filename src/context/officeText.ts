import { unzipSync } from "fflate";

const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = 500;
const MAX_TEXT_CHARS = 200_000;

/** 函数级说明（开发者 Jan）：执行 elements 的单一职责，并返回可供调用方继续处理的结果。 */
function elements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}

/** 函数级说明（开发者 Jan）：执行 xml 的单一职责，并返回可供调用方继续处理的结果。 */
function xml(bytes: Uint8Array | undefined): Document {
  if (!bytes) throw new Error("文档缺少必要内容，文件可能损坏或格式与扩展名不符");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("文档包含不支持的 XML 实体声明");
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (elements(document, "parsererror").length > 0) throw new Error("文档 XML 损坏，无法读取");
  return document;
}

/** 函数级说明（开发者 Jan）：执行 partPath 的单一职责，并返回可供调用方继续处理的结果。 */
function partPath(base: string, target: string): string {
  if (/^[a-z]+:/i.test(target) || target.includes("\\")) throw new Error("文档内容引用不合法");
  const parts = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("文档内容引用越界");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** 函数级说明（开发者 Jan）：执行 relationships 的单一职责，并返回可供调用方继续处理的结果。 */
function relationships(bytes: Uint8Array | undefined, base: string): Map<string, string> {
  if (!bytes) return new Map();
  return new Map(elements(xml(bytes), "Relationship")
    .filter((item) => item.getAttribute("TargetMode") !== "External")
    .map((item) => [item.getAttribute("Id") ?? "", partPath(base, item.getAttribute("Target") ?? "")]));
}

/** 函数级说明（开发者 Jan）：执行 paragraphText 的单一职责，并返回可供调用方继续处理的结果。 */
function paragraphText(document: Document, word: boolean): string {
  return elements(document, "p").map((paragraph) => {
/** 函数级说明（开发者 Jan）：执行 visit 的单一职责，并返回可供调用方继续处理的结果。 */
    const visit = (node: Node): string => {
      if (node.nodeType !== 1) return "";
      const element = node as Element;
      if (element.localName === "t") return element.textContent ?? "";
      if (word && element.localName === "tab") return "\t";
      if (["br", "cr"].includes(element.localName)) return "\n";
      return Array.from(element.childNodes).map(visit).join("");
    };
    return visit(paragraph);
  }).join("\n");
}

/** 只解压文字所需的 XML，限制单项、总大小和数量，不读取图片或执行宏、外部链接。 */
export function readOfficeText(format: string, bytes: Uint8Array): string {
  let total = 0;
  let count = 0;
  const files = unzipSync(bytes, { filter: (file) => {
    const selected = format === "docx" ? /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(file.name)
      : format === "xlsx" ? /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)
      : /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)$/.test(file.name);
    if (!selected) return false;
    total += file.originalSize;
    count += 1;
    if (file.originalSize > MAX_XML_BYTES || total > MAX_TOTAL_XML_BYTES || count > MAX_PARTS) {
      throw new Error("文档解压后过大或内容过多，请拆分后添加");
    }
    return true;
  } });
  const parts: string[] = [];
  let textLength = 0;
  let readable = false;
/** 函数级说明（开发者 Jan）：执行 append 的单一职责，并返回可供调用方继续处理的结果。 */
  const append = (text: string) => {
    textLength += text.length;
    if (textLength > MAX_TEXT_CHARS) throw new Error("文档文字过长，请拆分后添加");
    parts.push(text);
  };
  if (format === "docx") {
    const text = paragraphText(xml(files["word/document.xml"]), true);
    readable = text.trim().length > 0;
    append(text);
    for (const name of Object.keys(files).filter((name) => name !== "word/document.xml").sort()) {
      const extra = paragraphText(xml(files[name]), true);
      if (extra.trim()) {
        readable = true;
        append(`${name}\n${extra}`);
      }
    }
  } else if (format === "xlsx") {
    const workbook = xml(files["xl/workbook.xml"]);
    const links = relationships(files["xl/_rels/workbook.xml.rels"], "xl/workbook.xml");
    append("以下为原始单元格值；不应用日期、数字显示格式，不重新计算公式。");
    const strings = files["xl/sharedStrings.xml"]
      ? elements(xml(files["xl/sharedStrings.xml"]), "si").map((item) => elements(item, "t").map((text) => text.textContent ?? "").join("")) : [];
    for (const sheet of elements(workbook, "sheet")) {
      const id = sheet.getAttribute("r:id") ?? sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
      const target = links.get(id);
      if (!target || !/^xl\/worksheets\/[^/]+\.xml$/.test(target)) throw new Error("工作表引用缺失或不受支持");
      append(`工作表：${sheet.getAttribute("name") ?? target}`);
      for (const row of elements(xml(files[target]), "row")) {
        const cells = elements(row, "c").map((cell) => {
          const type = cell.getAttribute("t");
          const raw = elements(cell, "v")[0]?.textContent ?? "";
          let value = type === "s" ? (raw.trim() && /^\d+$/.test(raw) ? strings[Number(raw)] : undefined) : type === "inlineStr"
            ? elements(cell, "t").map((item) => item.textContent ?? "").join("") : raw;
          if (value === undefined) throw new Error("工作表共享文字索引无效");
          if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
          const formula = elements(cell, "f")[0]?.textContent;
          if (formula) value = `=${formula}${value ? `（缓存值：${value}）` : ""}`;
          if (value.trim()) readable = true;
          return `${cell.getAttribute("r") ?? ""}: ${value}`;
        });
        if (cells.length > 0) append(cells.join("\t"));
      }
    }
  } else if (format === "pptx") {
    const presentation = xml(files["ppt/presentation.xml"]);
    const links = relationships(files["ppt/_rels/presentation.xml.rels"], "ppt/presentation.xml");
    elements(presentation, "sldId").forEach((slide, index) => {
      const id = slide.getAttribute("r:id") ?? slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
      const target = links.get(id);
      if (!target || !/^ppt\/slides\/slide\d+\.xml$/.test(target)) throw new Error("幻灯片引用缺失或不受支持");
      const text = paragraphText(xml(files[target]), false);
      if (text.trim()) readable = true;
      append(`第 ${index + 1} 张幻灯片\n${text}`);
    });
  } else throw new Error("不支持的 Office 文档格式");
  const text = parts.join("\n\n").trim();
  if (!readable) throw new Error("文档没有可提取的文字，图片内容请先进行 OCR");
  return text;
}
