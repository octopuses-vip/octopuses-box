import type { ToolKind, ToolStatus } from "../../app/types";
import { Icon, type IconName } from "../../components/Icon";

const TOOL_ICON: Record<ToolKind, IconName> = {
  plan: "clipboard-check",
  exec_command: "terminal",
  apply_patch: "diff",
  read_file: "file",
  write_file: "code",
  write_artifact: "file",
  image_gen: "image",
  video_gen: "video",
  search_code: "search",
  test_runner: "clipboard-check",
  web_search: "globe",
  knowledge_search: "book",
  read_url: "external",
  read_skill: "book",
  mcp: "terminal",
  browser: "globe",
  computer: "brush",
  vision: "image",
  cv: "search",
  // 远程运维复用终端图标：与 MCP 同类的「命令行执行」语义
  ssh: "terminal",
  subagent: "cube",
  ask_user: "info",
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "运行中",
  success: "完成",
  error: "失败",
};

interface ToolCallCardProps {
  kind: ToolKind;
  title: string;
  command: string | null;
  status: ToolStatus;
  output: string;
  durationMs: number | null;
}

/**
 * 一次工具调用的卡片（开发者 Jan）：按类型展示命令、读写文件、检索或图纸等调用及其结果。
 *
 * 命令类卡片还承载审批入口与「撤销本轮修改」，因此它同时是过程展示与操作落点。
 */
export function ToolCallCard({
  kind,
  title,
  command,
  status,
  output,
  durationMs,
}: ToolCallCardProps) {
  const showOutput = status !== "running" && output.length > 0;

  return (
    <details className={`tool-card tool-card--${status}`} open={status === "error"}>
      <summary className="tool-card__head">
        <span className="tool-card__icon">
          <Icon name={TOOL_ICON[kind]} size={14} />
        </span>
        <span className="tool-card__title">{title}</span>
        <span className="spacer" />
        <span className="tool-card__meta">
          {status === "running" ? (
            <span className="pulse">运行中…</span>
          ) : (
            `${STATUS_LABEL[status]}${durationMs ? ` · ${(durationMs / 1000).toFixed(2)}s` : ""}`
          )}
        </span>
        <Icon name="chevron-down" size={11} />
      </summary>
      {command ? <pre className="tool-card__cmd">$ {command}</pre> : null}
      {showOutput ? (
        <pre
          className={
            status === "error" ? "tool-card__output tool-card__output--error" : "tool-card__output"
          }
        >
          {output}
        </pre>
      ) : null}
    </details>
  );
}
