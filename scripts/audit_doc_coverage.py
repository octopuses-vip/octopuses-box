#!/usr/bin/env python3
"""统计各源文件的「函数级注释」覆盖率。

口径：
  - 只看函数声明紧邻的上一行（允许中间夹属性行，如 Rust 的 #[tauri::command]）；
  - 测试模块内的函数单列，因为项目惯例是测试函数不写文档注释；
  - 已废弃的 `const x = useStore((s) => s.y)` 这类选择器不算函数。
"""
import os
import re

ROOTS = ["src", "src-tauri/src", "ots-cli/crates"]
EXT = {".ts", ".tsx", ".rs"}

TS_FN = re.compile(r"^\s*(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)")
# 只认顶格的「具名箭头函数」：参数表必须有括号、函数体必须是块。
# 借此排除 `const x = useStore((s) => s.y)` 这类选择器，以及函数内部缩进的具名闭包
# （如 forwardAbort 这类只在调用处用一次的回调，不属于对外可复用的函数级 API）。
TS_ARROW = re.compile(
    r"^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{"
)
RS_FN = re.compile(r"^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+([A-Za-z_]\w*)")


def walk(root, out):
    for name in sorted(os.listdir(root)):
        if name in ("node_modules", "target", "dist", ".git"):
            continue
        p = os.path.join(root, name)
        if os.path.isdir(p):
            walk(p, out)
        elif os.path.splitext(name)[1] in EXT:
            out.append(p)
    return out


def is_comment(line, lang):
    t = line.strip()
    if not t:
        return False
    if lang == "rs":
        return t.startswith("///") or t.startswith("//!") or t.startswith("//")
    return t.startswith("//") or t.endswith("*/") or t.startswith("/*")


def is_attribute(line):
    """属性 / 装饰器行：注释与函数声明之间允许夹一层。"""
    t = line.strip()
    return t.startswith("#[") or t.startswith("#!") or t.startswith("@")


def preceding_comment(lines, idx):
    """向上跳过属性行，返回紧贴函数声明的那一行（没有则返回空串）。"""
    i = idx - 1
    while i >= 0 and is_attribute(lines[i]):
        i -= 1
    return lines[i] if i >= 0 else ""


def main():
    files = []
    for root in ROOTS:
        if os.path.isdir(root):
            walk(root, files)

    total = documented = 0
    t_total = t_doc = 0
    rows = []
    for f in files:
        lang = "rs" if f.endswith(".rs") else "ts"
        lines = open(f, encoding="utf-8").read().split("\n")
        # 测试代码单列：项目惯例是测试函数不写文档注释，口径上要和生产函数分开看
        in_tests = False
        miss = []
        for i, line in enumerate(lines):
            if re.match(r"^\s*mod tests", line) or "describe(" in line:
                in_tests = True
            name = None
            if lang == "rs":
                m = RS_FN.match(line)
                if m:
                    name = m.group(5)
            else:
                m = TS_FN.match(line)
                if m:
                    name = m.group(4)
                else:
                    m = TS_ARROW.match(line)
                    if m:
                        name = m.group(2)
            if not name:
                continue
            documented_here = is_comment(preceding_comment(lines, i), lang)
            if in_tests:
                t_total += 1
                t_doc += 1 if documented_here else 0
                continue
            total += 1
            if documented_here:
                documented += 1
            else:
                miss.append("%d:%s" % (i + 1, name))
        if miss:
            rows.append((len(miss), f, miss))

    rows.sort(reverse=True)
    print("【生产函数】总数 %d，紧贴注释 %d，缺失 %d" % (total, documented, total - documented))
    print("【测试函数】总数 %d，紧贴注释 %d，缺失 %d" % (t_total, t_doc, t_total - t_doc))
    print("涉及文件 %d 个\n" % len(rows))
    for cnt, f, miss in rows:
        print("%s  (缺 %d)" % (f, cnt))
        print("   " + " | ".join(miss[:60]))
    print("\n生产函数合计缺失 %d" % sum(r[0] for r in rows))


if __name__ == "__main__":
    main()
