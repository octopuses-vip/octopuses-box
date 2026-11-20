import type { ReactNode } from "react";

import { Icon } from "../../components/Icon";
import type { MessageAttachment } from "../../app/types";
import { formatBytes } from "../../model/attachments";

interface UserMessageProps {
  messageId?: string;
  text: string;
  attachments: MessageAttachment[];
  /**
   * 气泡下方的操作栏。
   *
   * 由消息流（`ConversationStream`）构造后传进来：复制 / 分享 / 追问 / 重新生成都在那里决定
   * 内容与可用性，本组件只负责把气泡画好、把操作栏摆在气泡之后。
   */
  actions?: ReactNode;
}

/**
 * 用户消息气泡（开发者 Jan）：附件区在正文之上，图片附件渲染缩略图、其余渲染文件名与体积。
 *
 * 只负责气泡本身的排版；`actions`（复制 / 分享 / 追问 / 重新生成）由消息流构造后传入，
 * 本组件不参与可用性判断。
 */
export function UserMessage({ text, attachments, actions, messageId }: UserMessageProps) {
  return (
    <div className="msg msg--user" data-message-id={messageId}>
      <div className="bubble">
        {attachments.length > 0 ? (
          <div className="bubble__attachments">
            {attachments.map((item) =>
              item.kind === "image" && item.dataUrl ? (
                <img
                  className="bubble__thumb"
                  key={item.id}
                  src={item.dataUrl}
                  alt={item.name}
                />
              ) : (
                <span className="bubble__file" key={item.id} title={item.name}>
                  <Icon name={item.kind === "audio" ? "audio" : "file"} size={12} />
                  <span className="bubble__file-name">{item.name}</span>
                  <span className="muted">{formatBytes(item.size)}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
        {text.length > 0 ? <div>{text}</div> : null}
      </div>
      {actions}
    </div>
  );
}
