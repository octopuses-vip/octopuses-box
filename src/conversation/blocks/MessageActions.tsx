import { useEffect, useRef, useState } from "react";

import { copyText } from "../../app/desktop/system";
import { Icon, type IconName } from "../../components/Icon";

/**
 * 消息操作栏：贴在一条消息下方的一排动作（复制 / 分享 / 追问 / 重新生成）。
 *
 * 助手消息与用户消息共用同一个组件，差别只在外面套的修饰类与是否传 `onRegenerate`。
 * 组件自身不关心「这条消息是哪一轮」，那属于消息流（`ConversationStream`）的判断；
 * 这里只负责把四个动作画出来、把文本写进剪贴板、给出「已复制」的即时反馈。
 */

/** 「已复制」反馈的停留时长（毫秒）：与侧栏会话列表行的反馈节奏保持一致 */
const ACTION_FEEDBACK_MS = 1600;

interface MessageActionsProps {
  /** 该条消息的纯文本，用于「复制」 */
  text: string;
  /** 该条消息的 Markdown 片段，用于「分享」 */
  markdown: string;
  /** 运行中禁用全部动作：一次只推进一轮，避免与正在进行的运行打架 */
  disabled: boolean;
  /** 「追问」：把该条消息作为引用填进输入框 */
  onFollowUp: () => void;
  /** 「重新生成」；不传则不渲染该按钮（不是最后一轮时就是这种情况） */
  onRegenerate?: () => void;
  /** 额外的修饰类；助手消息用它把操作栏对齐到正文缩进 */
  className?: string;
}

/**
 * 一条消息的操作栏（开发者 Jan）：复制、分享、追问、重新生成。
 *
 * 复制与分享都用上层算好的文本 / Markdown，不在组件里自行拼装，
 * 保证与「复制对话」的口径一致；disabled 用于生成中禁止重新生成。
 */
export function MessageActions({
  text,
  markdown,
  disabled,
  onFollowUp,
  onRegenerate,
  className,
}: MessageActionsProps) {
  /** 刚刚完成复制类动作的按钮：用于把图标临时换成对勾，给出「确实复制了」的反馈 */
  const [copied, setCopied] = useState<"copy" | "share" | null>(null);
  const timer = useRef<number | null>(null);

  // 消息可能因为重新生成或切换会话整条消失，卸载时清掉计时器，
  // 避免回调打在已卸载的组件上
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  /** 复制类动作：写成功才给反馈，失败保持原样（与侧栏会话列表行的处理一致） */
  const copy = async (which: "copy" | "share", value: string) => {
    if (!(await copyText(value))) return;
    setCopied(which);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), ACTION_FEEDBACK_MS);
  };

  return (
    <div className={className ? `msg__actions ${className}` : "msg__actions"}>
      <ActionButton
        icon={copied === "copy" ? "clipboard-check" : "copy"}
        label={copied === "copy" ? "已复制到剪贴板" : "复制这条消息"}
        disabled={disabled}
        onClick={() => void copy("copy", text)}
      />
      <ActionButton
        icon={copied === "share" ? "clipboard-check" : "share"}
        label={copied === "share" ? "已复制分享内容" : "分享（复制为 Markdown）"}
        disabled={disabled}
        onClick={() => void copy("share", markdown)}
      />
      <ActionButton
        icon="message"
        label="追问（引用这条消息继续提问）"
        disabled={disabled}
        onClick={onFollowUp}
      />
      {onRegenerate ? (
        <ActionButton
          icon="refresh"
          label="重新生成这一轮"
          disabled={disabled}
          onClick={onRegenerate}
        />
      ) : null}
    </div>
  );
}

interface ActionButtonProps {
  icon: IconName;
  /** 同时作为悬停提示与无障碍名称：这一排全是图标，没有可见文字 */
  label: string;
  disabled: boolean;
  onClick: () => void;
}

/** 操作栏里的单个图标按钮 */
function ActionButton({ icon, label, disabled, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      className="msg__action"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
