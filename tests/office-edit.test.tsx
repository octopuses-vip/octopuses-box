import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import { editOffice } from "../src/office/edit";
Object.assign(globalThis, { DOMParser, XMLSerializer });
test("DOCX 跨格式 run 替换文本，保留样式与其他 ZIP 内容", () => {
  const original = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="urn:w"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r><w:r><w:t>world and world</w:t></w:r></w:p></w:document>'), "word/styles.xml": strToU8("unchanged"), "word/media/image.png": new Uint8Array([1, 2, 3]) });
  const changed = unzipSync(editOffice(original, "docx", { kind: "replace", find: "Hello world", replacement: "你好" }));
  const doc = strFromU8(changed["word/document.xml"]); assert.match(doc, /你好/); assert.match(doc, / and world/); assert.match(doc, /w:b/);
  assert.equal(strFromU8(changed["word/styles.xml"]), "unchanged"); assert.deepEqual(changed["word/media/image.png"], new Uint8Array([1, 2, 3]));
  assert.throws(() => editOffice(original, "docx", { kind: "replace", find: "missing", replacement: "x" }), /未改变/);
});
test("XLSX 新增稀疏单元格、保留样式，写公式时强制重新计算", () => {
  const original = zipSync(Object.fromEntries(Object.entries({
    "xl/workbook.xml": '<workbook xmlns="urn:x" xmlns:r="urn:r"><sheets><sheet name="销售" r:id="r1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="urn:x"><sheetData><row r="1"><c r="A1" s="2"><v>3</v></c></row></sheetData></worksheet>',
  }).map(([p, v]) => [p, strToU8(v)])));
  const changed = unzipSync(editOffice(original, "xlsx", { kind: "cell", sheet: "销售", address: "B2", value: "=SUM(A1:A3)" }));
  assert.match(strFromU8(changed["xl/worksheets/sheet1.xml"]), /<f>SUM\(A1:A3\)<\/f>/); assert.match(strFromU8(changed["xl/worksheets/sheet1.xml"]), /s="2"/);
  assert.match(strFromU8(changed["xl/workbook.xml"]), /fullCalcOnLoad="1"/);
  assert.throws(() => editOffice(original, "xlsx", { kind: "cell", sheet: "销售", address: "ZZZ1", value: "1" }), /范围/);
});
