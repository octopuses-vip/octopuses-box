import { Icon } from "../../components/Icon";
import { Markdown, MarkdownLinkScope } from "../Markdown";
import { useAppStore } from "../../app/state";
import { memo } from "react";

interface AnswerTextProps {
  text: string;
  streaming: boolean;
}

/**
 * 助手正文块（开发者 Jan）：左侧是固定的图标栏，右侧渲染 Markdown。
 *
 * `streaming` 为真时套一层 `caret` 类显示闪烁光标——只在最后一段正在生成的文本上传 true，
 * 避免历史段落也一直闪。
 */
export const AnswerText = memo(function AnswerText({ text, streaming }: AnswerTextProps) {
  const openMarkdownLink = useAppStore((state) => state.openMarkdownLink);
  return (
    <div className="assistant__row">
      <div className="assistant__gutter">
        <Icon name="sparkles" size={14} style={{ color: "var(--text-2)" }} />
      </div>
      <div className="assistant__content">
        <div className={streaming ? "caret" : undefined}>
          <MarkdownLinkScope onLink={openMarkdownLink}>
            <Markdown text={text} />
          </MarkdownLinkScope>
        </div>
      </div>
    </div>
  );
});
