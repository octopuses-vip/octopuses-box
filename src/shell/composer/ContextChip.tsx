import { useCallback, useRef, useState } from "react";

import { effectiveWorkspacePath } from "../../app/state/workspace";
import { selectActiveContextEntries } from "../../app/storeSelectors";
import { useAppStore } from "../../app/state";
import { Icon, type IconName } from "../../components/Icon";
import { useClickOutside } from "../../hooks/useClickOutside";

const KIND_ICON: Record<"file" | "folder" | "url", IconName> = {
  file: "file",
  folder: "folder",
  url: "globe",
};

/**
 * 「附加上下文」：把项目内的文件 / 目录或网址读到模型上下文里。
 *
 * 附加项存在**所属会话**上（会话级，随会话落库）：切换会话看到的是目标会话自己的附加项，
 * 重启客户端后原样恢复。运行时由 `src/context/attach.ts` 读成文本注入请求；
 * 相对路径按本会话生效的工作目录解析（项目下的任务用项目目录，独立会话用自选目录），
 * 因此这里只收用户输入的原始值。
 */
export function ContextChip({ onAddAttachments }: { onAddAttachments: () => void }) {
  const entries = useAppStore(selectActiveContextEntries);
  // 解析基准取「本会话生效的工作目录」，与运行时注入用的是同一个值；
  // 若取全局 projectPath，独立会话会拿到空值、切换项目时还可能滞后一步
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const addContextEntry = useAppStore((state) => state.addContextEntry);
  const removeContextEntry = useAppStore((state) => state.removeContextEntry);

  const [panel, setPanel] = useState<"actions" | "context" | null>(null);
  const [draft, setDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setPanel(null), []);
  useClickOutside(wrapRef, panel !== null, close);

/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = () => {
    if (draft.trim().length === 0) return;
    addContextEntry(draft);
    setDraft("");
    close();
  };

  return (
    <div ref={wrapRef} className="context-menu" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    }}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn context-menu__trigger"
        aria-label="添加附件或上下文"
        title={entries.length > 0 ? `添加附件或上下文 · 已附加 ${entries.length} 项上下文` : "添加附件或上下文"}
        aria-haspopup="dialog"
        aria-expanded={panel !== null}
        onClick={() => setPanel((current) => current ? null : "actions")}
      >
        <Icon name="plus" size={16} />
        {entries.length > 0 ? <span className="context-menu__count">{entries.length}</span> : null}
      </button>
      {panel ? (
        <div className="menu context-menu__panel" role="dialog" aria-label="添加附件与上下文">
          {panel === "actions" ? (
            <>
              <button autoFocus type="button" className="menu__item" onClick={() => {
                close();
                onAddAttachments();
              }}>
                <span className="context-menu__action"><Icon name="paperclip" size={14} />添加附件</span>
                <span className="menu__item-desc">图片、PDF 或文本，随本条消息发送</span>
              </button>
              <button type="button" className="menu__item" onClick={() => setPanel("context")}>
                <span className="context-menu__action"><Icon name="folder" size={14} />附加上下文</span>
                <span className="menu__item-desc">文档、源码、目录或网址，供当前会话使用</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" className="menu__item" onClick={() => setPanel("actions")}>
                <span className="context-menu__action"><Icon name="undo" size={13} />返回添加菜单</span>
              </button>
              <form className="menu__form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
                <input
                  className="menu__input"
                  autoFocus
                  aria-label="文件路径、目录或网址"
                  value={draft}
                  placeholder="项目内路径或 https:// 网址"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim()}>附加</button>
              </form>
              <div className="menu__hint">相对路径按本会话工作目录解析：{workspacePath ?? "尚未选择工作目录"}</div>
              <div className="menu__hint">支持 PDF、DOCX、XLSX、PPTX 及文本、源码、配置文件；单个文件最大 10 MB。</div>
            </>
          )}
          {entries.length > 0 ? (
            <div className="context-menu__entries">
              <div className="menu__hint">会话上下文 · {entries.length} 项</div>
              {entries.map((entry) => (
                <div className="context-menu__entry" key={entry.id}>
                  <Icon name={KIND_ICON[entry.kind]} size={12} />
                  <span className="context-menu__label" title={entry.label}>{entry.label}</span>
                  <button type="button" className="icon-btn" aria-label={`移除 ${entry.label}`} onClick={() => removeContextEntry(entry.id)}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
