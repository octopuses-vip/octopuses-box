#!/usr/bin/env node
/** 状态与桌面适配层的依赖约束；运行时循环检查忽略类型导入。 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const absolute = (path) => resolve(root, path);
const label = (path) => relative(root, path).replaceAll("\\", "/");
const stateDir = absolute("src/app/state");
const desktopDir = absolute("src/app/desktop");
const stateEntry = join(stateDir, "index.ts");
const issues = [];
const within = (file, directory) => file.startsWith(directory + sep);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const files = [...walk(stateDir), ...walk(desktopDir),
  absolute("src/app/storeTypes.ts"), absolute("src/app/storeSelectors.ts")];
const sources = new Map(files.map((file) => [file,
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)]));
const graph = new Map(files.map((file) => [file, new Set()]));
const owners = new Map();

function resolveModule(file, specifier) {
  if (!specifier.startsWith(".")) return null;
  const path = resolve(dirname(file), specifier);
  return [path + ".ts", path + ".tsx", join(path, "index.ts")].find(existsSync) ?? null;
}

function runtimeImport(node) {
  if (node.importClause?.isTypeOnly || node.isTypeOnly) return false;
  const bindings = node.importClause?.namedBindings ?? node.exportClause;
  if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
    return Boolean(node.importClause?.name) || bindings.elements.some((item) => !item.isTypeOnly);
  }
  return true;
}

for (const [file, source] of sources) {
  if (/^\s*\/\/\s*@ts-nocheck\b/m.test(source.text)) issues.push(`${label(file)} 禁止关闭类型检查`);
  for (const node of source.statements) {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier) continue;
    const target = resolveModule(file, node.moduleSpecifier.text);
    if (!target) continue;
    if (within(file, stateDir) && file !== stateEntry && target === stateEntry) {
      issues.push(`${label(file)} 不得反向依赖全局 Store 入口`);
    }
    if (within(file, desktopDir) && within(target, stateDir)) {
      issues.push(`${label(file)} 不得依赖应用状态`);
    }
    if (runtimeImport(node) && sources.has(target)) graph.get(file).add(target);
  }
  // spread 会静默覆盖同名字段，要求每个字段恰好归属一个切片。
  if (within(file, join(stateDir, "slices"))) {
    for (const node of source.statements) {
      if (!ts.isVariableStatement(node)) continue;
      for (const declaration of node.declarationList.declarations) {
        const type = declaration.type;
        if (!type || !ts.isTypeReferenceNode(type) || type.typeName.getText(source) !== "StoreSlice") continue;
        const argument = type.typeArguments?.[0];
        const keys = argument && ts.isUnionTypeNode(argument) ? argument.types : [argument];
        for (const key of keys) {
          if (!key || !ts.isLiteralTypeNode(key) || !ts.isStringLiteral(key.literal)) continue;
          const name = key.literal.text;
          if (owners.has(name)) issues.push(`字段 ${name} 重复声明：${label(owners.get(name))}、${label(file)}`);
          owners.set(name, file);
        }
      }
    }
  }
}

const contract = sources.get(absolute("src/app/storeTypes.ts")).statements
  .find((node) => ts.isInterfaceDeclaration(node) && node.name.text === "AppStore");
for (const member of contract.members) {
  const name = member.name.getText();
  if (!owners.has(name)) issues.push(`AppStore 字段 ${name} 没有归属切片`);
}

const visited = new Set();
const active = [];
function visit(file) {
  const index = active.indexOf(file);
  if (index !== -1) {
    issues.push(`运行时循环依赖：${[...active.slice(index), file].map(label).join(" → ")}`);
    return;
  }
  if (visited.has(file)) return;
  active.push(file);
  for (const target of graph.get(file)) visit(target);
  active.pop();
  visited.add(file);
}
for (const file of files) visit(file);

if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`架构检查通过：${files.length} 个模块，${owners.size} 个状态字段归属明确，无运行时循环依赖。`);
}
