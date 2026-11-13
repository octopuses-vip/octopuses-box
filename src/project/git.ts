/**
 * 项目差异：在用户选定的项目目录上执行真实 `git diff`，解析成右栏可渲染的结构。
 *
 * Git 命令由 Rust 后端使用参数数组执行，不经过 Shell；浏览器演示环境无法访问本地仓库，
 * 由调用方把失败原因展示给用户。
 */

import { readGitDiffText } from "../app/desktop/git";
import type { DiffFile, DiffLine } from "../app/types";

/** 单个文件展示的最大行数，超出后截断 */
const FILE_LINE_LIMIT = 400;

/** 去掉 git 的 a/ b/ 前缀；`/dev/null` 表示该侧文件不存在 */
function stripPrefix(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/** 解析 `@@ -1,3 +1,4 @@` 行，取出两侧起始行号 */
function parseHunkHeader(line: string): { oldNo: number; newNo: number } | null {
  const matched = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!matched) return null;
  return { oldNo: Number(matched[1]), newNo: Number(matched[2]) };
}

/**
 * 解析 git 的 unified diff 文本。
 *
 * 只依赖最常见的行结构（`diff --git` / `+++` / `@@` / ` `、`-`、`+`），不追求覆盖所有
 * 边角（重命名、二进制、模式变更等只作为普通文本行展示），保证大多数场景可用。
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let truncated = false;

/** 函数级说明（开发者 Jan）：执行 push 的单一职责，并返回可供调用方继续处理的结果。 */
  const push = (line: DiffLine) => {
    if (!current) return;
    if (current.lines.length >= FILE_LINE_LIMIT) {
      truncated = true;
      return;
    }
    current.lines.push(line);
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      current = { path: "", additions: 0, deletions: 0, lines: [] };
      files.push(current);
      truncated = false;
      continue;
    }
    if (!current) continue;
    const file = current;

    if (line.startsWith("+++ ")) {
      const next = stripPrefix(line.slice(4));
      const previous = stripPrefix(file.path);
      if (next !== null) file.path = next;
      else if (previous !== null) file.path = previous;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (file.path.length === 0) file.path = stripPrefix(line.slice(4)) ?? "";
      continue;
    }

    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldNo = hunk.oldNo;
      newNo = hunk.newNo;
      push({ kind: "ctx", text: line, oldNo: null, newNo: null });
      continue;
    }

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
      continue;
    }
    if (line.startsWith("rename ") || line.startsWith("similarity") || line.startsWith("old mode")) {
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      push({ kind: "ctx", text: line, oldNo: null, newNo: null });
      continue;
    }

    const mark = line.slice(0, 1);
    const body = line.slice(1);
    if (mark === "+") {
      file.additions += 1;
      push({ kind: "add", text: body, oldNo: null, newNo });
      newNo += 1;
    } else if (mark === "-") {
      file.deletions += 1;
      push({ kind: "del", text: body, oldNo, newNo: null });
      oldNo += 1;
    } else if (mark === " ") {
      push({ kind: "ctx", text: body, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }

  return files
    .filter((file) => file.path.length > 0)
    .map((file) =>
      truncated && file.lines.length >= FILE_LINE_LIMIT
        ? {
            ...file,
            lines: [
              ...file.lines,
              {
                kind: "ctx" as const,
                text: `…（改动过长，仅展示前 ${FILE_LINE_LIMIT} 行）`,
                oldNo: null,
                newNo: null,
              },
            ],
          }
        : file,
    );
}

/**
 * 读取工作区当前的全部改动。后端把已跟踪与未跟踪文件统一输出为 unified diff，
 * 前端只负责解析，不再拼接或执行 Git 命令。
 */
export async function readGitDiff(workspacePath: string): Promise<DiffFile[]> {
  return parseUnifiedDiff(await readGitDiffText(workspacePath));
}