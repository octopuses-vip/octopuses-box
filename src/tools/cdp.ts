/**
 * CDP 客户端：用 WebView 原生 `WebSocket` 直连调试浏览器，零依赖完成网页自动化。
 *
 * 分工：Rust 侧只负责「拉起一个独立 profile 的浏览器 + 探测端口」，协议交互全部在这里完成。
 * 会话按目标（标签页）缓存，同一次运行里的多次动作复用同一条连接，console 缓冲因此能跨动作累积。
 *
 * 安全边界：
 * - 协议地址必须指向本机回环（后端已限定 127.0.0.1 与 9000-9999 端口，这里再校验一次 host）；
 * - 会改变页面状态的动作（click / type / eval）在审批时按高风险处理，其余只读动作才可能被自动放行；
 * - 回填给模型的文本一律截断，避免整页 HTML 或大数组把上下文撑爆。
 */

import { cdpLaunch, cdpTargets, cdpClose, type CdpTarget } from "../app/desktop/control";

/** 默认调试端口：与后端 `control.rs` 的 `CDP_DEFAULT_PORT` 保持一致 */
export const CDP_DEFAULT_PORT = 9222;
/** 单条调试命令的超时 */
const COMMAND_TIMEOUT_MS = 15000;
/** 等待选择器出现的最长轮询时间 */
const WAIT_TIMEOUT_MS = 10000;
/** 轮询页面状态的间隔 */
const POLL_INTERVAL_MS = 200;
/** 回填给模型的文本上限 */
const MAX_OUTPUT = 4000;
/** console 缓冲的最大条数 */
const MAX_CONSOLE_LOGS = 200;

/** 会改变页面状态的动作：审批按高风险处理，其余按只读处理 */
export const CDP_WRITE_ACTIONS = ["click", "type", "eval"];
/** `browser_cdp` 支持的全部动作 */
export const CDP_ACTIONS = [
  "launch",
  "close",
  "targets",
  "navigate",
  "click",
  "type",
  "eval",
  "screenshot",
  "console",
  "waitForSelector",
];

/** 一次 CDP 动作的结果；`image` 由运行期作为 image_url 附到下一条请求 */
export interface CdpActionResult {
  ok: boolean;
  output: string;
  image?: { mime: string; base64: string; width?: number; height?: number };
}

/** 协议调用的等待队列条目 */
interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一条已建立的调试协议连接 */
interface CdpSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}

/** 按「协议地址」缓存的会话：同一标签页的多次动作复用同一条连接 */
const sessions = new Map<string, CdpSession>();

/**
 * 在页面里提前装一个 console 钩子。
 *
 * 用 `Page.addScriptToEvaluateOnNewDocument` 注入，导航后第一时间生效，
 * 这样 `console` 动作能读到「本次导航之后」的全部日志，而不是只有连上以后的。
 */
const CONSOLE_HOOK = `(() => {
  if (window.__octopusesConsole) return;
  const logs = [];
  window.__octopusesConsole = logs;
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      try {
        logs.push(level + ": " + args.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" "));
        if (logs.length > ${MAX_CONSOLE_LOGS}) logs.shift();
      } catch (error) {
        // 序列化失败不该影响页面本身
      }
      original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => logs.push("error: " + event.message));
})()`;

/** 回填文本的截断，避免整页内容撑爆上下文 */
function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（已截断）` : text;
}

/** 只允许连本机回环的调试地址 */
function assertLoopback(wsUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new Error(`调试地址不合法：${wsUrl}`);
  }
  if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error(`调试地址必须指向本机回环，收到：${wsUrl}`);
  }
}

/** 建立一条调试协议连接：原生 WebSocket，按 id 匹配应答，按 method 分发给事件监听 */
async function openSession(wsUrl: string): Promise<CdpSession> {
  assertLoopback(wsUrl);
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, PendingCall>();
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接调试浏览器超时。")), COMMAND_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("连接调试浏览器失败，请确认调试浏览器仍在运行。"));
    };
  });

  socket.onmessage = (event) => {
    let frame: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      frame = JSON.parse(String(event.data)) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.id !== "number") return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) {
      entry.reject(new Error(frame.error.message ?? "调试协议返回错误。"));
      return;
    }
    entry.resolve((frame.result ?? {}) as Record<string, unknown>);
  };

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`调试命令 ${method} 超时。`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });

/** 函数级说明（开发者 Jan）：执行 close 的单一职责，并返回可供调用方继续处理的结果。 */
  const close = () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("调试连接已关闭。"));
    }
    pending.clear();
    socket.close();
  };

  return { send, close };
}

/** 关闭并遗忘全部缓存会话 */
export function resetCdpSessions(): void {
  for (const [, session] of sessions) session.close();
  sessions.clear();
}

/** 挑一个可驱动的页面目标：优先标签页，排除协议自身的 devtools 页 */
async function pickPageTarget(port: number): Promise<CdpTarget> {
  const targets = await cdpTargets(port);
  const page = targets.find(
    (target) => target.type === "page" && !target.url.startsWith("devtools://"),
  );
  if (!page) {
    throw new Error("没有可驱动的页面：请先用 browser_cdp 的 launch 动作启动调试浏览器。");
  }
  assertLoopback(page.webSocketDebuggerUrl);
  return page;
}

/** 取（必要时建立）目标页面的会话，并确保域已启用 */
async function sessionFor(port: number): Promise<{ session: CdpSession; target: CdpTarget }> {
  const target = await pickPageTarget(port);
  const cached = sessions.get(target.webSocketDebuggerUrl);
  if (cached) return { session: cached, target };
  const session = await openSession(target.webSocketDebuggerUrl);
  // 两个域都要开：Page 提供导航与截图，Runtime 提供脚本执行
  await session.send("Page.enable").catch(() => ({}));
  await session.send("Runtime.enable").catch(() => ({}));
  sessions.set(target.webSocketDebuggerUrl, session);
  return { session, target };
}

/** 在页面里执行一段 JS 并取回值 */
async function evaluate(session: CdpSession, expression: string): Promise<unknown> {
  const payload = (await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (payload.exceptionDetails) {
    throw new Error(
      payload.exceptionDetails.exception?.description ??
        payload.exceptionDetails.text ??
        "页面脚本执行失败。",
    );
  }
  return payload.result?.value ?? null;
}

/** 把脚本返回值转成可读文本 */
function describe(value: unknown): string {
  if (value === null || value === undefined) return "（无返回值）";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 轮询等待页面条件成立 */
async function waitUntil(
  session: CdpSession,
  expression: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(session, expression).catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** 读取端口参数 */
function readPort(args: Record<string, unknown>): number {
  const value = args.port;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return CDP_DEFAULT_PORT;
}

/** 从动作参数里取一个非空字符串 */
function readArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

/** 执行一次 `browser_cdp` 动作 */
export async function runCdpAction(
  action: string,
  args: Record<string, unknown>,
): Promise<CdpActionResult> {
  const port = readPort(args);

  if (action === "launch") {
    const launched = await cdpLaunch(port);
    if (!launched.ok) return { ok: false, output: launched.output };
    const targets = await cdpTargets(port).catch(() => []);
    const pages = targets.filter((target) => target.type === "page");
    return {
      ok: true,
      output: `${launched.output}可驱动页面：\n${pages
        .map((target) => `- ${target.title || "（无标题）"} ${target.url}`)
        .join("\n")}`,
    };
  }

  if (action === "close") {
    resetCdpSessions();
    const closed = await cdpClose();
    return { ok: closed.ok, output: closed.output };
  }

  if (action === "targets") {
    const targets = await cdpTargets(port).catch(() => []);
    if (targets.length === 0) {
      return { ok: false, output: "没有可驱动的目标：调试浏览器可能尚未启动。" };
    }
    return {
      ok: true,
      output: targets
        .map((target) => `- [${target.type}] ${target.title || "（无标题）"} ${target.url}`)
        .join("\n"),
    };
  }

  const { session } = await sessionFor(port);

  if (action === "navigate") {
    const url = readArg(args, "url");
    if (!url) return { ok: false, output: "navigate 缺少非空 url。" };
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: CONSOLE_HOOK });
    await session.send("Page.navigate", { url });
    const ready = await waitUntil(session, "document.readyState === 'complete'", WAIT_TIMEOUT_MS);
    const title = await evaluate(session, "document.title").catch(() => null);
    return {
      ok: true,
      output: `已打开 ${url}${ready ? "" : "（页面仍在加载）"}${title ? `，标题：${describe(title)}` : ""}`,
    };
  }

  if (action === "click") {
    const selector = readArg(args, "selector");
    if (!selector) return { ok: false, output: "click 缺少非空 selector。" };
    const result = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return "NOT_FOUND";
        element.scrollIntoView({ block: "center" });
        element.click();
        return "CLICKED " + element.tagName + " " + (element.textContent || "").trim().slice(0, 60);
      })()`,
    );
    if (result === "NOT_FOUND") {
      return { ok: false, output: `页面上找不到元素：${selector}` };
    }
    return { ok: true, output: describe(result) };
  }

  if (action === "type") {
    const selector = readArg(args, "selector");
    const text = typeof args.text === "string" ? args.text : null;
    if (!selector || text === null) {
      return { ok: false, output: "type 需要同时提供 selector 与非空 text。" };
    }
    const result = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return "NOT_FOUND";
        element.focus();
        const proto = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter && "value" in element) {
          // 走原型上的 setter：直接赋值不会触发 React 的受控组件更新
          setter.call(element, ${JSON.stringify(text)});
        } else if (element.isContentEditable) {
          element.textContent = ${JSON.stringify(text)};
        } else {
          return "UNSUPPORTED";
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return "TYPED " + element.tagName;
      })()`,
    );
    if (result === "NOT_FOUND") return { ok: false, output: `页面上找不到元素：${selector}` };
    if (result === "UNSUPPORTED") {
      return { ok: false, output: `元素 ${selector} 不支持输入（不是输入框或可编辑区域）。` };
    }
    return { ok: true, output: describe(result) };
  }

  if (action === "eval") {
    const expression = readArg(args, "expression");
    if (!expression) return { ok: false, output: "eval 缺少非空 expression。" };
    const value = await evaluate(session, expression);
    return { ok: true, output: truncate(describe(value)) };
  }

  if (action === "screenshot") {
    const captured = (await session.send("Page.captureScreenshot", { format: "png" })) as {
      data?: string;
    };
    const base64 = captured.data ?? "";
    if (base64.length === 0) return { ok: false, output: "网页截图失败：协议没有返回图像数据。" };
    const size = (await evaluate(
      session,
      "JSON.stringify({ width: window.innerWidth, height: window.innerHeight })",
    ).catch(() => null)) as string | null;
    let width: number | undefined;
    let height: number | undefined;
    if (typeof size === "string") {
      try {
        const parsed = JSON.parse(size) as { width?: number; height?: number };
        width = parsed.width;
        height = parsed.height;
      } catch {
        // 尺寸只是补充信息，取不到不影响截图本身
      }
    }
    return {
      ok: true,
      output: `已截取当前网页${width && height ? `（视口 ${width}×${height}）` : ""}。`,
      image: { mime: "image/png", base64, width, height },
    };
  }

  if (action === "console") {
    const logs = await evaluate(session, "JSON.stringify(window.__octopusesConsole ?? [])");
    let parsed: unknown = logs;
    if (typeof logs === "string") {
      try {
        parsed = JSON.parse(logs);
      } catch {
        parsed = logs;
      }
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { ok: true, output: "本次导航以来没有 console 输出。" };
    }
    return { ok: true, output: truncate(parsed.join("\n")) };
  }

  if (action === "waitForSelector") {
    const selector = readArg(args, "selector");
    if (!selector) return { ok: false, output: "waitForSelector 缺少非空 selector。" };
    const found = await waitUntil(
      session,
      `!!document.querySelector(${JSON.stringify(selector)})`,
      WAIT_TIMEOUT_MS,
    );
    return found
      ? { ok: true, output: `元素已出现：${selector}` }
      : { ok: false, output: `等待超时，元素仍未出现：${selector}` };
  }

  return { ok: false, output: `不支持的 browser_cdp 动作：${action}` };
}