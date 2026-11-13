import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { closePtySession, createPtySession, listenPtyEvents, resizePtySession, writePtySession } from "../app/desktop/terminal";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { writeCacheFile } from "../app/desktop/cache";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { useAppStore } from "../app/state";
const MAX_OUTPUT_CHARS = 300_000;

/** 取目录名作为标签（开发者 Jan）：只显示最后一段，路径为空的兜底文案是「用户主目录」 */
function dirLabel(path: string | null): string {
  if (!path) return "用户主目录";
  const parts = path.split("/").filter((segment) => segment.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** 保留输出末尾若干字符（开发者 Jan）：终端输出可能极长，只留最近部分用于持久化与导出 */
function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(-MAX_OUTPUT_CHARS) : value;
}

/** 剥掉 ANSI 转义序列与回车符（开发者 Jan）：导出为纯文本时不能把控制符带出去 */
function plainText(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

/**
 * 集成终端面板（开发者 Jan）。
 *
 * 这是用户直接控制面：键盘输入原样送进 PTY，不经过模型的命令审批链路，
 * 也不放宽模型 test_runner 的策略。终端的工作目录跟随当前会话的有效工作区，
 * 输出按节流写进缓存目录，便于重挂载后接回上下文。
 */
export function Terminal() {
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  const workspacePath = useAppStore(effectiveWorkspacePath);
  const cachePath = useAppStore((state) => state.cachePath);
  const desktop = isDesktopRuntime();
  const [status, setStatus] = useState<"connecting" | "connected" | "exited" | "unavailable">(
    desktop ? "connecting" : "unavailable",
  );
  const [exitCode, setExitCode] = useState<number | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const outputRef = useRef("");
  const cacheTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!desktop) return;
    const host = terminalHostRef.current;
    if (!host) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let ownedSessionId: string | null = null;
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      scrollback: 10_000,
      theme: {
        background: "#111111",
        foreground: "#d8d8d8",
        cursor: "#d8d8d8",
        selectionBackground: "#3b4352",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminal.focus();

    outputRef.current = "";
    setExitCode(null);
    setStatus("connecting");

/** 函数级说明（开发者 Jan）：执行 persistOutput 的单一职责，并返回可供调用方继续处理的结果。 */
    const persistOutput = () => {
      if (!cachePath || outputRef.current.length === 0) return;
      if (cacheTimerRef.current !== null) window.clearTimeout(cacheTimerRef.current);
      cacheTimerRef.current = window.setTimeout(() => {
        cacheTimerRef.current = null;
        void writeCacheFile(cachePath, "logs/terminal.log", plainText(outputRef.current)).catch(
          () => {},
        );
      }, 300);
    };

/** 函数级说明（开发者 Jan）：执行 writeOutput 的单一职责，并返回可供调用方继续处理的结果。 */
    const writeOutput = (data: string) => {
      terminal.write(data);
      outputRef.current = trimOutput(outputRef.current + data);
      persistOutput();
    };

    const inputDisposable = terminal.onData((data) => {
      if (ownedSessionId) void writePtySession(ownedSessionId, data).catch(() => {});
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (ownedSessionId) void resizePtySession(ownedSessionId, cols, rows).catch(() => {});
    });
    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(host);

    void listenPtyEvents((event) => {
      if (event.sessionId !== ownedSessionId) return;
      if (event.kind === "output" && event.data) writeOutput(event.data);
      if (event.kind === "error" && event.data) writeOutput(`\r\n[PTY 错误] ${event.data}\r\n`);
      if (event.kind === "exit") {
        setExitCode(event.exitCode);
        setStatus("exited");
        ownedSessionId = null;
      }
    })
      .then((dispose) => {
        unlisten = dispose;
        /**
         * 监听已就绪但组件已被卸载时，必须放弃创建 PTY（开发者 Jan）。
         *
         * 建立监听是异步 IPC，卸载可能发生在其 resolve 之前（开发模式下 StrictMode 必然如此：
         * 挂载→卸载→挂载）。原先这里只调用了 dispose() 却继续往下走，于是凭空多出一个
         * 无人认领的 PTY 会话：它的 conhost 会残留下来整核空转，把主线程消息循环拖死，
         * 表现为「打开终端一会儿整个界面卡死」。此处直接返回 null，不再创建。
         */
        if (disposed) {
          dispose();
          return null;
        }
        return createPtySession(workspacePath, terminal.cols, terminal.rows);
      })
      .then((session) => {
        if (!session) return;
        if (disposed) {
          void closePtySession(session.sessionId);
          return;
        }
        ownedSessionId = session.sessionId;
        setStatus("connected");
        terminal.focus();
      })
      .catch((error) => {
        if (disposed) return;
        setStatus("exited");
        writeOutput(`\r\n[无法连接 PTY] ${error instanceof Error ? error.message : String(error)}\r\n`);
      });

    return () => {
      disposed = true;
      unlisten?.();
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      if (cacheTimerRef.current !== null) window.clearTimeout(cacheTimerRef.current);
      cacheTimerRef.current = null;
      if (ownedSessionId) void closePtySession(ownedSessionId);
    };
  }, [activeThreadId, cachePath, desktop, workspacePath]);

  const statusText =
    status === "connected"
      ? "已连接"
      : status === "connecting"
        ? "连接中"
        : status === "unavailable"
          ? "浏览器不可用"
          : exitCode === null
            ? "已退出"
            : `已退出 (${exitCode})`;

  return (
    <section className="terminal">
      <div className="terminal__head">
        {/* 顶栏的终端开关按钮已带同名图标，面板标题不再重复放一个小图标 */}
        <span>终端</span>
        <span className={`terminal__status terminal__status--${status}`}>{statusText}</span>
        <span className="spacer" />
        {/* 未指定工作目录时终端从用户主目录启动，因此这里只说「工作目录」，不套用「项目目录」的说法 */}
        <span title={workspacePath ?? "未指定工作目录，终端从用户主目录启动"}>
          PTY · {dirLabel(workspacePath)}
        </span>
      </div>
      <div className="terminal__body">
        {status === "unavailable" ? (
          <div className="terminal__notice">
            浏览器环境不提供本地终端。请使用桌面端；这里不会伪造命令执行结果。
          </div>
        ) : (
          <div className="terminal__xterm" ref={terminalHostRef} />
        )}
      </div>
    </section>
  );
}
