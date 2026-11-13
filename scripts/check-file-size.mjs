#!/usr/bin/env node
/** 检查源码文件长度，避免单文件重新膨胀（开发者 Jan）。 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const roots = ["src", "src-tauri/src", "ots-cli/crates"];
const extensions = new Set([".ts", ".tsx", ".rs", ".css"]);
const ignored = new Set(["node_modules", "target", "dist", ".git"]);
const limit = 1000;

function walk(directory, files = []) {
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const file = join(directory, name);
    if (statSync(file).isDirectory()) walk(file, files);
    else if (extensions.has(extname(name))) files.push(file);
  }
  return files;
}

const oversized = roots
  .flatMap((root) => walk(root))
  .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
  .filter(({ lines }) => lines > limit)
  .sort((a, b) => b.lines - a.lines);

if (oversized.length > 0) {
  console.error(`发现 ${oversized.length} 个源码文件超过 ${limit} 行：`);
  for (const item of oversized) console.error(`- ${relative(".", item.file)}: ${item.lines} 行`);
  process.exitCode = 1;
} else {
  console.log(`源码文件长度检查通过：全部不超过 ${limit} 行。`);
}
