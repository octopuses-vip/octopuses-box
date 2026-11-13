import { useState } from "react";

import { Icon } from "../../components/Icon";

interface ReasoningBlockProps {
  text: string;
  done: boolean;
}

/**
 * 思考块（开发者 Jan）：默认折叠，点标题栏展开。
 *
 * `done` 只影响文案（「思考中…」/「已思考」），不自动展开——思考属于过程性内容，
 * 展开与否完全交给用户，避免生成过程中界面被大段思考撑开。
 */
export function ReasoningBlock({ text, done }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="reasoning">
      <button type="button" className="reasoning__toggle" onClick={() => setOpen((prev) => !prev)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        {done ? <span>已思考</span> : <span className="pulse">思考中…</span>}
      </button>
      {open ? <div className="reasoning__body">{text}</div> : null}
    </div>
  );
}
