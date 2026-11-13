import assert from "node:assert/strict";
import test from "node:test";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Components } from "react-markdown";
import { MarkdownBase } from "../src/conversation/Markdown";

/** 读取实际传给 Markdown 解析器的组件映射，验证流式更新时组件身份不变（开发者 Jan）。 */
function componentsFor(text: string): Components {
  const tree = MarkdownBase({ text });
  const markdown = tree.props.children as ReactElement<{ components: Components }>;
  return markdown.props.components;
}

test("连续流式分片复用代码块与链接组件，不因函数类型变化卸载子树", () => {
  const initial = componentsFor("```text\n# 角色\n");
  for (let chunk = 1; chunk <= 30; chunk++) {
    const next = componentsFor("```text\n# 角色\n" + "规划与执行\n".repeat(chunk));
    assert.equal(next, initial);
    assert.equal(next.pre, initial.pre);
    assert.equal(next.a, initial.a);
  }
});

test("未闭合代码围栏追加内容及闭合后保持渲染能力，保留复制按钮与安全链接", () => {
  for (const suffix of ["", "更多内容\n", "更多内容\n```\n\n[参考](https://example.com)"]) {
    const html = renderToStaticMarkup(<MarkdownBase text={"```text\n# 角色\n" + suffix} />);
    assert.ok(html.includes('class="md-code"'));
    assert.ok(html.includes('aria-label="复制代码"'));
    assert.ok(html.includes("# 角色"));
    if (suffix.includes("[参考]")) {
      assert.ok(html.includes('target="_blank" rel="noreferrer"'));
    }
  }
});
