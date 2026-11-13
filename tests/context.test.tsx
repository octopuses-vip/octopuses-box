import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser as XmlParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import { buildContextMessage, inferKind } from "../src/context/attach";
import { decodeContextText, readContextFile } from "../src/context/fileText";
import { readOfficeText } from "../src/context/officeText";
import type { ContextPathData } from "../src/app/desktop/files";
import { pdfFile } from "./fixtures/pdf";

globalThis.DOMParser = class extends XmlParser {
  constructor() { super({ onError: () => { throw new Error("文档 XML 损坏"); } }); }
} as unknown as typeof DOMParser;
const bytes = (text: string) => new TextEncoder().encode(text);
const packed = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])));
const word = (text: string) => packed({ "word/document.xml": `<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` });

test("上下文读取未知扩展名源码、UTF-8、GB18030、UTF-16 LE/BE 文本", async () => {
  assert.equal(await readContextFile("custom.abc", bytes("中文源码\nhello")), "中文源码\nhello");
  assert.equal(decodeContextText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), "中文");
  assert.equal(decodeContextText(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])), "中文");
  assert.equal(decodeContextText(new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87])), "中文");
  assert.equal(decodeContextText(new Uint8Array([65, 0, 66, 0, 67, 0, 68, 0])), "ABCD");
  assert.throws(() => decodeContextText(new Uint8Array([0, 0, 1, 0, 0, 0])), /二进制/);
});

test("DOCX 提取中文、段落、制表符和换行，不把 XML 标记发给模型", async () => {
  const doc = packed({ "word/document.xml": '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>中文 &amp; 文档</w:t><w:tab/><w:t>表格</w:t><w:br/><w:t>换行</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>' });
  assert.equal(await readContextFile("报告.DOCX", doc), "中文 & 文档\t表格\n换行\n第二段");
});

test("PDF 在会话上下文链路中提取文字，损坏 PDF 显式报错", async () => {
  const file = pdfFile("CONTEXT_PDF_SENTINEL");
  const content = new Uint8Array(await file.arrayBuffer());
  assert.match(await readContextFile(file.name, content), /CONTEXT_PDF_SENTINEL/);
  const result = await buildContextMessage([{ id: "pdf", label: "report.pdf", kind: "file" }], "/workspace", undefined,
    async () => ({ kind: "file", name: "report.pdf", bytes: content }));
  assert.match(result!, /CONTEXT_PDF_SENTINEL/);
  await assert.rejects(readContextFile("broken.pdf", bytes("not a PDF")));
});

const workbook = (sharedIndex = "0") => packed({
  "xl/workbook.xml": '<workbook xmlns:r="urn:rels"><sheets><sheet name="销售数据" r:id="r1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="r1" Target="worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><r><t>中</t></r><r><t>文</t></r></si></sst>',
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>${sharedIndex}</v></c><c r="C1" t="inlineStr"><is><t>销售额</t></is></c><c r="D1"><v>42</v></c><c r="E1"><f>SUM(D1:D2)</f><v>84</v></c><c r="F1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
});

test("XLSX 保留工作表名称、稀疏单元格位置、共享字符串与公式缓存", async () => {
  const text = await readContextFile("data.xlsx", workbook());
  for (const expected of ["销售数据", "A1: 中文", "C1: 销售额", "D1: 42", "E1: =SUM(D1:D2)（缓存值：84）", "F1: TRUE"]) assert.ok(text.includes(expected), expected);
  assert.throws(() => readOfficeText("xlsx", workbook("99")), /索引/);
});

test("PPTX 按演示文稿关系顺序读取，不能按 ZIP 内文件名排序", async () => {
  const slides = packed({
    "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": '<a:root xmlns:a="urn:a"><a:p><a:r><a:t>末页</a:t></a:r></a:p></a:root>',
    "ppt/slides/slide2.xml": '<a:root xmlns:a="urn:a"><a:p><a:r><a:t>首页</a:t></a:r></a:p></a:root>',
  });
  assert.equal(await readContextFile("deck.pptx", slides), "第 1 张幻灯片\n首页\n\n第 2 张幻灯片\n末页");
});

test("拒绝损坏包、空文档、XML 实体、旧版 Office 和图片二进制", async () => {
  await assert.rejects(readContextFile("broken.docx", bytes("not a ZIP")));
  await assert.rejects(readContextFile("empty.docx", word("")), /OCR/);
  await assert.rejects(readContextFile("broken-xml.docx", packed({ "word/document.xml": "<broken>" })), /XML/);
  const entity = packed({ "word/document.xml": '<!DOCTYPE document [<!ENTITY x "secret">]><document>&x;</document>' });
  await assert.rejects(readContextFile("entity.docx", entity), /实体/);
  await assert.rejects(readContextFile("legacy.xls", bytes("binary")), /转换/);
  await assert.rejects(readContextFile("image.png", bytes("image")), /添加附件/);
  await assert.rejects(readContextFile("unknown.bin", new Uint8Array([0x50, 0x4b, 3, 4])), /压缩包/);
  await assert.rejects(readContextFile("large.txt", new Uint8Array(10 * 1024 * 1024 + 1)), /10 MB/);
});

test("Office 解压前限制实际要读取的 XML 大小，忽略无关媒体内容", async () => {
  const oversized = packed({ "word/document.xml": "x".repeat(16 * 1024 * 1024 + 1) });
  await assert.rejects(readContextFile("huge.docx", oversized), /解压后过大/);
  const withMedia = packed({
    "word/document.xml": '<w:document xmlns:w="urn:w"><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:document>',
    "word/media/image.jpg": "x".repeat(16 * 1024 * 1024 + 1),
  });
  assert.equal(await readContextFile("media.docx", withMedia), "正文");
});

test("会话上下文按文档类型读取，坏文件不影响后续文件，目录无斜杠也可识别", async () => {
  const reader = async (path: string, base: string | null): Promise<ContextPathData> => {
    assert.equal(base, "/workspace");
    if (path === "report.docx") return { kind: "file", name: path, bytes: word("正文内容") };
    if (path === "broken.xlsx") return { kind: "file", name: path, bytes: bytes("broken") };
    if (path === "docs") return { kind: "folder", entries: ["a.txt", "sub/"], truncated: true };
    return { kind: "file", name: path, bytes: bytes("第二份资料") };
  };
  const entries = ["report.docx", "broken.xlsx", "notes.txt", "docs"].map((label, index) => ({ id: `${index}`, label, kind: "file" as const }));
  const result = await buildContextMessage(entries, "/workspace", undefined, reader);
  assert.match(result!, /正文内容/);
  assert.match(result!, /读取失败/);
  assert.match(result!, /第二份资料/);
  assert.match(result!, /已截断/);
  assert.match(result!, /a.txt/);
  assert.equal(inferKind("C:\\docs\\"), "folder");
});

test("上下文仍遵守单条与总长度限制并转义来源属性", async () => {
  const readPath = async (): Promise<ContextPathData> => ({ kind: "file", name: "long.txt", bytes: bytes("x".repeat(12_000)) });
  const entries = Array.from({ length: 6 }, (_, index) => ({ id: String(index), label: `file"${index}.txt`, kind: "file" as const }));
  const result = await buildContextMessage(entries, "/workspace", undefined, readPath);
  assert.ok(result!.length < 25_000);
  assert.match(result!, /超出总长度上限/);
  assert.match(result!, /source="file&quot;0.txt"/);
});
