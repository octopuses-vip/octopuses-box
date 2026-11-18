import type { CSSProperties } from "react";

export type IconName =
  | "plus"
  | "search"
  | "puzzle"
  | "clock"
  | "sparkles"
  | "folder"
  | "message"
  | "settings"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "panel-right"
  | "terminal"
  | "arrow-up"
  | "stop"
  | "pause"
  | "play"
  | "check"
  | "close"
  | "copy"
  | "share"
  | "refresh"
  | "external"
  | "branch"
  | "file"
  | "globe"
  | "image"
  | "video"
  | "mic"
  | "audio"
  | "diff"
  | "book"
  | "clipboard-check"
  | "paperclip"
  | "code"
  | "alert"
  | "info"
  | "shield"
  | "user"
  | "logout"
  | "spinner"
  | "archive"
  | "brush"
  | "pencil"
  | "trash"
  | "undo"
  | "minimize"
  | "maximize"
  | "restore"
  | "cube"
  | "download"
  | "upload"
  | "ellipsis";

const PATHS: Record<IconName, string> = {
  pause: "M5.5 3.5v9M10.5 3.5v9",
  play: "M5 3.5 12 8 5 12.5Z",
  plus: "M8 3.5v9M3.5 8h9",
  search: "M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM11.2 11.2 14 14",
  puzzle:
    "M3 6.2h2.2a1.4 1.4 0 1 1 2.8 0H10v2.1a1.4 1.4 0 1 0 0 2.8v2H3V6.2ZM10 9.1V6.2",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.8V8l2.2 1.3",
  sparkles:
    "M8 2.4l1.2 3.1L12.3 6.7 9.2 7.9 8 11 6.8 7.9 3.7 6.7l3.1-1.2L8 2.4ZM12.4 10.6l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z",
  folder: "M2.4 4.6h4l1.3 1.6h5.9v6.4H2.4V4.6Z",
  message: "M2.6 4.2h10.8v6.6H7.4L4.4 13.2v-2.4H2.6V4.2Z",
  settings:
    "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM12.6 9.7l1 .8-1 1.7-1.2-.3-.9.5-.3 1.2H8.6l-.3-1.2-.9-.5-1.2.3-1-1.7 1-.8v-1l-1-.8 1-1.7 1.2.3.9-.5.3-1.2h2.4l.3 1.2.9.5 1.2-.3 1 1.7-1 .8v1Z",
  "chevron-down": "M4.4 6.4 8 10l3.6-3.6",
  "chevron-left": "M10 4L6 8l4 4",
  "chevron-right": "M6.4 4.4 10 8l-3.6 3.6",
  "panel-right": "M2.6 3.2h10.8v9.6H2.6V3.2ZM9.6 3.2v9.6",
  terminal: "M4.4 5.6 6.8 8l-2.4 2.4M8.4 11h3.2M2.6 3.2h10.8v9.6H2.6V3.2Z",
  "arrow-up": "M8 12.8V3.6M4.4 7.2 8 3.6l3.6 3.6",
  stop: "M5.2 5.2h5.6v5.6H5.2z",
  check: "M3.4 8.4 6.4 11.4l6.2-7",
  close: "M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2",
  copy: "M5.6 5.6h7v7h-7v-7ZM3.4 10.4V3.4h7",
  share: "M8 10.6V2.8M5.4 5.4 8 2.8l2.6 2.6M3.4 8.6v4.6h9.2V8.6",
  refresh: "M14.9 2.8v3.9h-3.9M13.7 10a6 6 0 1 1-1.4-6.2l2.6 2.9",
  external: "M9.4 3.4h3.2v3.2M12.6 3.4 7.8 8.2M11 9.6v3H3.4v-7.6h3",
  branch:
    "M4.6 3.6v8.8M4.6 5.6h4a2.2 2.2 0 0 1 2.2 2.2v4.6M4.6 14a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM4.6 5.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM12.6 14a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z",
  file: "M4 2.6h5l3 3v7.8H4V2.6ZM9 2.6v3h3",
  globe: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM2.4 8h11.2M8 2.2c1.7 1.7 2.6 3.7 2.6 5.8S9.7 12.1 8 13.8c-1.7-1.7-2.6-3.7-2.6-5.8S6.3 3.9 8 2.2Z",
  video: "M2 4h8v8H2zM10 7l4-2v6l-4-2",
  mic: "M5.5 3a2.5 2.5 0 015 0v4a2.5 2.5 0 01-5 0V3zM3.5 6.5V7a4.5 4.5 0 009 0v-.5M8 11.5V15M5.5 15h5",
  audio: "M2 6v4M5 3v10M8 5v6M11 2v12M14 6v4",
  image: "M2.6 3.4h10.8v9.2H2.6V3.4ZM5.2 7a1.1 1.1 0 1 0 0-2.2A1.1 1.1 0 0 0 5.2 7ZM13.4 10.4 10 7.4l-5.2 5.2 3-2.6 2.4 2.1",
  diff: "M4.4 5.2h4.2M6.5 3.1v4.2M4.4 11.2h4.2M9.6 3.4h2M9.6 12.4h2M11.6 3.4v3.2a2 2 0 0 1-2 2H8.4a2 2 0 0 0-2 2v1.8",
  book: "M3.4 2.8h4.2a1.6 1.6 0 0 1 1.6 1.6v8.8L8 12l-1.2 1.2V4.4a1.6 1.6 0 0 0-1.6-1.6H3.4Z M12.6 2.8H9.2v9.2L8 12",
  "clipboard-check": "M6 3.4h4v1.6H6V3.4ZM4.4 5h1.6M4.4 5v8h7.2V5H10M4.4 13V5M6.4 9.4l1.4 1.4 2.6-3",
  paperclip:
    "M11.4 7.6 7.2 11.8a2.4 2.4 0 0 1-3.4-3.4l4.6-4.6a1.7 1.7 0 0 1 2.4 2.4l-4.6 4.6a.9.9 0 0 1-1.3-1.3l4-4",
  code: "M6 4.4 2.8 8 6 11.6M10 4.4 13.2 8 10 11.6",
  alert: "M8 2.8 14 13H2L8 2.8ZM8 6.6v3M8 11.4h.01",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 7.2v3.4M8 5.2h.01",
  shield: "M8 2.4 13 4v4.2c0 3-2.2 4.6-5 5.4-2.8-.8-5-2.4-5-5.4V4l5-1.6Z",
  user: "M8 7.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM3.4 13.4c0-2.3 2-3.8 4.6-3.8s4.6 1.5 4.6 3.8",
  logout: "M6.6 3.2H3.4v9.6h3.2M9.8 5.4 12.4 8l-2.6 2.6M12.4 8H6.8",
  spinner: "M8 2.4a5.6 5.6 0 1 0 5.6 5.6",
  archive: "M2.6 4.4h10.8v2H2.6v-2ZM3.6 6.4v6.6h8.8V6.4M6.6 9h2.8",
  brush: "M10.8 2.6 13.4 5.2 7.6 11l-2.6-2.6 5.8-5.8ZM4.6 9.2l2.6 2.6-.6 1.6a1.9 1.9 0 0 1-2.6 0 1.9 1.9 0 0 1 0-2.6l.6-1.6Z",
  pencil: "M3.2 12.8 3.6 10.4 10.4 3.6a1.5 1.5 0 0 1 2.1 2.1l-6.8 6.8-2.5.3ZM9.6 4.4l2.1 2.1",
  trash: "M3.4 5h9.2M6.4 5V3.6h3.2V5M4.8 5l.6 8h5.2l.6-8M6.8 7.4v3.4M9.2 7.4v3.4",
  undo: "M3.4 7.6h5.4a2.8 2.8 0 0 1 0 5.6H6M3.4 7.6l2.6-2.6M3.4 7.6l2.6 2.6",
  minimize: "M3.6 8h8.8",
  maximize: "M4.2 4.2h7.6v7.6H4.2z",
  restore: "M6.2 6.2h6.4v6.4H6.2V6.2ZM3.4 9.8V3.4h6.4",
  // 等轴测立方体：3D 预览 tab 的标识
  cube: "M8 2.2 13.4 5.1v5.8L8 13.8 2.6 10.9V5.1L8 2.2ZM2.6 5.1 8 8l5.4-2.9M8 8v5.8",
  download: "M8 2.8v7.2M5 7 8 10l3-3M3.4 12.8h9.2",
  upload: "M8 10.4V3.2M5 6.2 8 3.2l3 3M3.4 12.8h9.2",
  ellipsis: "M3.8 8h.01M8 8h.01M12.2 8h.01",
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** 渲染一枚内置图标（开发者 Jan）：统一尺寸与描边风格，避免各处手写 svg 导致观感漂移 */
export function Icon({ name, size = 15, className, style }: IconProps) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
