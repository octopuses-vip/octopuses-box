import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
const elements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagName("*")).filter((e) => e.localName === name);
function xml(bytes: Uint8Array): Document {
  const text = strFromU8(bytes); if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("不支持含实体声明的文档");
  const doc = new DOMParser().parseFromString(text, "application/xml"); if (doc.getElementsByTagName("parsererror").length) throw new Error("Office XML 无效"); return doc;
}
export type OfficeEdit = { kind: "replace"; find: string; replacement: string } | { kind: "cell"; sheet: string; address: string; value: string };
export function editOffice(bytes: Uint8Array, format: string, edit: OfficeEdit): Uint8Array {
  let expanded = 0;
  const files = unzipSync(bytes, { filter: (file) => { expanded += file.originalSize; if (expanded > 128 * 1024 * 1024 || file.originalSize > 32 * 1024 * 1024) throw new Error("文档解压内容过大"); return true; } });
  const save = (name: string, doc: Document) => { files[name] = strToU8(new XMLSerializer().serializeToString(doc)); };
  let changes = 0;
  if (edit.kind === "replace") {
    if (!edit.find || edit.find.length > 8000 || edit.replacement.length > 32000) throw new Error("替换文本无效或过长");
    const names = Object.keys(files).filter((n) => format === "docx" ? /^word\/(document|header\d+|footer\d+)\.xml$/.test(n) : /^ppt\/slides\/slide\d+\.xml$/.test(n));
    if (!names.length) throw new Error("当前格式不支持文本替换");
    for (const name of names) {
      const doc = xml(files[name]); let dirty = false;
      for (const paragraph of elements(doc, "p")) {
        const runs = elements(paragraph, "t"); const full = runs.map((n) => n.textContent ?? "").join("");
        const matches: number[] = []; let at = 0;
        while ((at = full.indexOf(edit.find, at)) >= 0) { matches.push(at); at += edit.find.length; }
        // Apply from right to left so earlier run offsets remain valid.
        const offsets: number[] = []; let length = 0; for (const run of runs) { offsets.push(length); length += (run.textContent ?? "").length; }
        for (const start of matches.reverse()) {
          const end = start + edit.find.length; const first = runs.findIndex((n, i) => offsets[i] + (n.textContent ?? "").length > start);
          let last = first; while (last + 1 < runs.length && offsets[last + 1] < end) last++;
          const prefix = (runs[first].textContent ?? "").slice(0, start - offsets[first]); const suffix = (runs[last].textContent ?? "").slice(end - offsets[last]);
          runs[first].textContent = prefix + edit.replacement + (first === last ? suffix : "");
          if (first !== last) { for (let i = first + 1; i < last; i++) runs[i].textContent = ""; runs[last].textContent = suffix; }
          runs[first].setAttribute("xml:space", "preserve"); changes++; dirty = true;
        }
      }
      if (dirty) save(name, doc);
    }
  } else {
    if (format !== "xlsx" || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(edit.address)) throw new Error("请输入有效的 XLSX 单元格地址，例如 A1");
    const book = xml(files["xl/workbook.xml"]); const sheet = elements(book, "sheet").find((n) => n.getAttribute("name") === edit.sheet); if (!sheet) throw new Error("工作表不存在");
    const id = sheet.getAttribute("r:id"); const rels = xml(files["xl/_rels/workbook.xml.rels"]); const rel = elements(rels, "Relationship").find((n) => n.getAttribute("Id") === id);
    if (!rel || rel.getAttribute("TargetMode") === "External") throw new Error("工作表关系无效");
    const target = rel.getAttribute("Target") ?? ""; const name = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    if (name.includes("..") || !files[name]) throw new Error("工作表路径无效");
    const doc = xml(files[name]); const ns = doc.documentElement.namespaceURI; const data = elements(doc, "sheetData")[0]; if (!data) throw new Error("工作表数据无效");
    const rowNumber = Number(edit.address.match(/\d+$/)![0]); const column = edit.address.match(/^[A-Z]+/)![0];
    const columnNumber = (s: string) => [...s].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0);
    if (rowNumber > 1048576 || columnNumber(column) > 16384) throw new Error("单元格超过 Excel 工作表范围");
    let row = elements(data, "row").find((r) => r.getAttribute("r") === String(rowNumber));
    if (!row) { row = doc.createElementNS(ns, "row"); row.setAttribute("r", String(rowNumber)); data.insertBefore(row, elements(data, "row").find((r) => Number(r.getAttribute("r")) > rowNumber) ?? null); }
    let cell = elements(row, "c").find((c) => c.getAttribute("r") === edit.address);
    if (!cell) { cell = doc.createElementNS(ns, "c"); cell.setAttribute("r", edit.address); row.insertBefore(cell, elements(row, "c").find((c) => columnNumber((c.getAttribute("r") ?? "A1").replace(/\d+$/, "")) > columnNumber(column)) ?? null); }
    while (cell.firstChild) cell.removeChild(cell.firstChild); cell.removeAttribute("t");
    if (edit.value.startsWith("=")) { const formula = doc.createElementNS(ns, "f"); formula.textContent = edit.value.slice(1); cell.appendChild(formula); }
    else if (edit.value.trim() && Number.isFinite(Number(edit.value))) { const value = doc.createElementNS(ns, "v"); value.textContent = edit.value; cell.appendChild(value); }
    else { cell.setAttribute("t", "inlineStr"); const inline = doc.createElementNS(ns, "is"); const text = doc.createElementNS(ns, "t"); text.textContent = edit.value; text.setAttribute("xml:space", "preserve"); inline.appendChild(text); cell.appendChild(inline); }
    let calc = elements(book, "calcPr")[0]; if (!calc) { calc = book.createElementNS(book.documentElement.namespaceURI, "calcPr"); book.documentElement.appendChild(calc); } calc.setAttribute("fullCalcOnLoad", "1"); calc.setAttribute("forceFullCalc", "1"); calc.setAttribute("calcMode", "auto");
    save("xl/workbook.xml", book); save(name, doc); changes++;
  }
  if (!changes) throw new Error("没有找到匹配内容，原文档未改变");
  return zipSync(files);
}
