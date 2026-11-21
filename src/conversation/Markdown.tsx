import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { copyText, openExternal } from "../app/desktop/system";
import { useAppStore } from "../app/state";
import { LOCAL_FILE_LINK } from "../app/state/artifacts";
import { Icon } from "../components/Icon";

/** 会话正文和文件预览可以接管本地文件链接。 */
const MarkdownLinkHandler = createContext<((href: string) => boolean) | null>(null);

interface MarkdownProps {
  text: string;
  className?: string;
  allowImages?: boolean;
}

/** 代码块复制按钮「已复制」反馈的停留时长（毫秒）：与消息操作栏的节奏保持一致 */
const CODE_COPY_FEEDBACK_MS = 1600;

/**
 * 一个代码块（开发者 Jan）：右上角悬停浮出「复制」按钮，点一下把整段代码写进剪贴板。
 *
 * 代码从已渲染的 `<pre>` 上按 `innerText` 取回——直接复用浏览器的排版结果，不必再解析
 * markdown 节点；元素不可见时 `innerText` 会退回 `textContent`，仍能取到全文。
 * 首尾空行剥掉、行内缩进原样保留：SQL / 代码的缩进是内容的一部分，整段 `trim` 会切掉首行缩进。
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  // 会话切换 / 重新生成会让代码块整块消失，卸载时清掉计时器，避免回调打在已卸载的组件上
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  /** 写成功才给反馈，失败保持原样（与消息操作栏、侧栏会话列表行一致） */
  const copy = async () => {
    const el = preRef.current;
    const value = (el?.innerText ?? el?.textContent ?? "").replace(/^\n+|\n+$/g, "");
    if (value.length === 0) return;
    if (!(await copyText(value))) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), CODE_COPY_FEEDBACK_MS);
  };

  const label = copied ? "已复制代码" : "复制代码";

  return (
    <div className="md-code">
      <button
        type="button"
        className="md-code__copy"
        aria-label={label}
        title={label}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "clipboard-check" : "copy"} size={13} />
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

/** 仅拦截 http(s) 链接；锚点、相对路径等交给浏览器默认行为（本应用内无路由可跳） */
const EXTERNAL_LINK_PROTOCOL = /^https?:\/\//i;
const INTERNAL_PATH = /^[a-z]:[\\/]/i;

/**
 * 固定渲染组件类型，流式分片只更新内容，不卸载代码块或重置浏览器滚动状态（开发者 Jan）。
 *
 * `<a>` 必须拦下默认行为走 `openExternal`：Tauri 的 WKWebView 没有「新窗口请求」通道，
 * 原生 `target="_blank"` 点击会被静默丢弃——链接有样式没反应。vite 浏览器端
 * `openExternal` 内部就是 `window.open`，与默认行为等价，两端走同一条路径。
 */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const handleLink = useContext(MarkdownLinkHandler);
    const localPath = Boolean(href && (LOCAL_FILE_LINK.test(href) || INTERNAL_PATH.test(href)));
    return (
      <a
        href={localPath ? "#" : href}
        target={localPath ? undefined : "_blank"}
        rel="noreferrer"
        onClick={(event) => {
          if (!href) return;
          // 面板内接管优先：返回 true 表示已消费（相对链接落回应用内预览）
          if (handleLink?.(href)) {
            event.preventDefault();
            return;
          }
          if (localPath) {
            event.preventDefault();
            return;
          }
          if (!EXTERNAL_LINK_PROTOCOL.test(href)) return;
          event.preventDefault();
          void openExternal(href).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            useAppStore.getState().showNotice(`无法打开链接：${reason}`);
          });
        }}
      >
        {children}
      </a>
    );
  },
  pre: CodeBlock,
};

/**
 * Markdown 渲染（开发者 Jan）：全应用统一的正文渲染出口，对话正文与 Markdown 产物预览共用。
 *
 * 接入 GFM（remark-gfm）：模型返回的表格、删除线、任务列表、URL 自动链接都属 GFM 扩展，
 * 基础 CommonMark 不认这些语法——缺了它，表格会被当成普通段落原样显示成一串竖线。
 *
 * 覆写两处：`<pre>` 包一层带复制按钮的容器（长 SQL / 代码总要被整段拿走）；
 * `<a>` 统一在新标签页打开并加 `rel="noreferrer"`，防止产物里的链接把应用窗口本身导航走。
 */
export function MarkdownBase({ text, className, allowImages = true }: MarkdownProps) {
  return (
    <div className={["md", className ?? ""].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MARKDOWN_COMPONENTS}
        disallowedElements={allowImages ? undefined : ["img"]}
        urlTransform={(url, key) => key === "href" && (LOCAL_FILE_LINK.test(url) || INTERNAL_PATH.test(url))
          ? url
          : defaultUrlTransform(url)}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 正文渲染出口（开发者 Jan）：用 `memo` 包一层，避免「与正文无关的重渲染」。
 *
 * 输入框内容由 `ThreadView` 持有，每次按键都会让整棵树重渲染。若 Markdown 跟着重解析，
 * 消息流里会瞬间产生上百次 DOM 替换，WebKit 会据此调整滚动位置，把贴底的会话拽到中间
 * （Chromium 的滚动策略不同，浏览器端不复现）。props 只有 `text` / `className` 两个原始值，
 * 内容没变就没有重算的必要——memo 直接短路掉整棵 Markdown 子树。
 */
export const Markdown = memo(MarkdownBase);

/** 接管当前 Markdown 树的文件链接，HTTP(S) 仍通过系统浏览器打开。 */
export function MarkdownLinkScope({
  onLink,
  children,
}: {
  onLink: (href: string) => boolean;
  children: ReactNode;
}) {
  return <MarkdownLinkHandler.Provider value={onLink}>{children}</MarkdownLinkHandler.Provider>;
}
