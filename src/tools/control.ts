/**
 * 浏览器与电脑自动化工具：让模型能打开网页、用协议驱动浏览器、截图看屏幕并点按坐标。
 *
 * 分工：
 * - `open_in_browser` / `browser_script` / `computer_script`：脚本式，交由 Rust 侧的 `control.rs` 执行；
 * - `browser_cdp`：协议式，Rust 只负责拉起调试浏览器，协议交互在 `src/tools/cdp.ts` 里用原生 WebSocket 完成；
 * - `screenshot` / `computer_click`：视觉闭环，截图回灌给视觉模型后再按坐标点击。
 *
 * 这些操作都会在本机产生真实副作用，因此运行期一律先经审批闸门（见 `src/hooks/useAgentRun.ts`
 * 的分发逻辑）：按会话权限决定是否需要人工确认。
 */

import { computerClick, openInBrowser, runBrowserScript, runComputerScript, takeScreenshot, type ControlBrowser, type ControlBrowserAction } from "../app/desktop/control";
import { writeArtifactBytes } from "../app/desktop/artifacts";
import { supportsDesktopAutomation } from "../app/platform";
import type { ChatTool } from "../model/client";
import { CDP_ACTIONS, CDP_WRITE_ACTIONS, runCdpAction } from "./cdp";

export const OPEN_IN_BROWSER_TOOL_NAME = "open_in_browser";
export const BROWSER_SCRIPT_TOOL_NAME = "browser_script";
export const COMPUTER_SCRIPT_TOOL_NAME = "computer_script";
export const BROWSER_CDP_TOOL_NAME = "browser_cdp";
export const SCREENSHOT_TOOL_NAME = "screenshot";
export const COMPUTER_CLICK_TOOL_NAME = "computer_click";

export const OPEN_IN_BROWSER_TOOL: ChatTool = {
  type: "function",
  function: {
    name: OPEN_IN_BROWSER_TOOL_NAME,
    description:
      "用系统默认浏览器打开一个网址（仅 http/https）。当用户要求打开某个网页或链接时使用。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的网址，必须以 http:// 或 https:// 开头" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const BROWSER_SCRIPT_TOOL: ChatTool = {
  type: "function",
  function: {
    name: BROWSER_SCRIPT_TOOL_NAME,
    description:
      "驱动本机已安装的 Chrome 或 Safari：navigate 让当前标签页打开指定网址，eval 在当前标签页执行一段 JavaScript 并取回结果。" +
      "仅支持本机浏览器；Safari 需在「开发」菜单里允许 Apple 事件中的 JavaScript。",
    parameters: {
      type: "object",
      properties: {
        browser: { type: "string", enum: ["chrome", "safari"], description: "目标浏览器" },
        action: {
          type: "string",
          enum: ["navigate", "eval"],
          description: "navigate 打开网址；eval 在当前标签页执行 JS",
        },
        value: { type: "string", description: "navigate 时是网址；eval 时是要执行的 JavaScript" },
      },
      required: ["browser", "action", "value"],
      additionalProperties: false,
    },
  },
};

export const COMPUTER_SCRIPT_TOOL: ChatTool = {
  type: "function",
  function: {
    name: COMPUTER_SCRIPT_TOOL_NAME,
    description:
      "执行一段 AppleScript 以操作本机应用（如切换应用、点击、输入、读取界面元素）。" +
      "多行脚本按行依次执行；返回值会是脚本的输出文本。仅在 macOS 桌面端可用。",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "要执行的 AppleScript 文本，可多行" },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
};

export const BROWSER_CDP_TOOL: ChatTool = {
  type: "function",
  function: {
    name: BROWSER_CDP_TOOL_NAME,
    description:
      "用 DevTools 协议驱动一个受控的调试浏览器（独立 profile，不碰用户日常浏览器数据）：" +
      "launch 启动并返回可驱动页面、navigate 打开网址、click 点元素、type 填输入框、" +
      "eval 执行 JS 取回结果、screenshot 截当前网页、console 读页面日志、waitForSelector 等元素出现、" +
      "targets 列出页面、close 关闭浏览器。需要真实操作网页（填表、点按钮、读页面数据）时优先用它。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: CDP_ACTIONS,
          description: "要执行的动作",
        },
        url: { type: "string", description: "navigate 时要打开的网址（http/https）" },
        selector: {
          type: "string",
          description: "click / type / waitForSelector 时的 CSS 选择器",
        },
        text: { type: "string", description: "type 时要填入的文本" },
        expression: { type: "string", description: "eval 时要执行的 JavaScript 表达式" },
        port: { type: "number", description: "调试端口，默认 9222（取值范围 9000-9999）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};

export const SCREENSHOT_TOOL: ChatTool = {
  type: "function",
  function: {
    name: SCREENSHOT_TOOL_NAME,
    description:
      "截取当前整块屏幕并把图像回灌给你，用于「看」桌面上的原生应用界面。" +
      "截图会同时存为右栏可预览的图片产物；拿到图后再用 computer_click 按坐标操作，形成看 → 点 → 再看的闭环。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const COMPUTER_CLICK_TOOL: ChatTool = {
  type: "function",
  function: {
    name: COMPUTER_CLICK_TOOL_NAME,
    description:
      "按坐标点击屏幕（坐标取自 screenshot 看到的截图，单位为截图像素）。" +
      "用于操作没有网页接口的原生应用；macOS 需要授予 octopuses「辅助功能」权限才能生效。",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "截图像素横坐标" },
        y: { type: "number", description: "截图像素纵坐标" },
        imageWidth: {
          type: "number",
          description: "截图宽度（像素）。传了才能按屏幕缩放精确换算坐标，建议从 screenshot 结果里带上",
        },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
};

export const CONTROL_TOOLS: ChatTool[] = [
  { type: "function", function: { name: "computer_assistant", description: "使用独立视觉模型操作指定 macOS 应用。仅在用户要求操作电脑时调用。应用必须在设置的允许列表中；会逐步审批、操作并截图验证。", parameters: { type: "object", properties: { goal: { type: "string", description: "用户要求的具体目标" }, app: { type: "string", description: "目标应用 bundle ID，例如 com.apple.TextEdit" } }, required: ["goal", "app"], additionalProperties: false } } },
  OPEN_IN_BROWSER_TOOL,
  BROWSER_SCRIPT_TOOL,
  COMPUTER_SCRIPT_TOOL,
  BROWSER_CDP_TOOL,
  SCREENSHOT_TOOL,
  COMPUTER_CLICK_TOOL,
];

/** 全部浏览器 / 电脑自动化工具名集合 */
export const CONTROL_TOOL_NAMES = [
  "computer_assistant",
  OPEN_IN_BROWSER_TOOL_NAME,
  BROWSER_SCRIPT_TOOL_NAME,
  COMPUTER_SCRIPT_TOOL_NAME,
  BROWSER_CDP_TOOL_NAME,
  SCREENSHOT_TOOL_NAME,
  COMPUTER_CLICK_TOOL_NAME,
];

/**
 * 依赖 macOS 桌面自动化能力的工具名。
 *
 * 非 macOS 平台这四项无法执行（AppleScript 与系统截图 / 模拟点击都只有 macOS 后端），
 * 挂给模型只会让它反复调用必然失败的工具，因此在挂载工具表时按平台过滤掉。
 * `open_in_browser` 走系统默认浏览器、`browser_cdp` 走三平台候选路径的 Chrome，均保留。
 */
export const DESKTOP_AUTOMATION_TOOL_NAMES = [
  "computer_assistant",
  BROWSER_SCRIPT_TOOL_NAME,
  COMPUTER_SCRIPT_TOOL_NAME,
  SCREENSHOT_TOOL_NAME,
  COMPUTER_CLICK_TOOL_NAME,
];

/** 按当前平台筛选可挂载的自动化工具：非 macOS 剔除桌面自动化四项 */
export function controlToolsForPlatform(): ChatTool[] {
  if (supportsDesktopAutomation()) return CONTROL_TOOLS;
  return CONTROL_TOOLS.filter(
    (tool) => !DESKTOP_AUTOMATION_TOOL_NAMES.includes(tool.function.name),
  );
}

/**
 * 控制类工具的说明（开发者 Jan）。
 *
 * 只讲本轮真的挂出的工具：非 macOS 平台上 AppleScript / 截屏 / 坐标点击这几个已被
 * [`controlToolsForPlatform`] 从工具表里摘掉，再提一句「不要尝试」等于把不存在的工具
 * 写进常驻系统消息，模型拿不到可执行信息，只是白占上下文。
 */
export function buildControlHint(): string {
  if (!supportsDesktopAutomation()) {
    return [
      "你可以在本机做浏览器自动化：",
      "网页场景用 browser_cdp（launch 启动调试浏览器 → navigate 打开 → click / type / eval 操作 → console 看日志），",
      "它驱动的是独立 profile 的受控浏览器，不碰用户日常浏览器数据；",
      "open_in_browser 用于用系统默认浏览器打开链接；",
      "只读动作（navigate / screenshot / console）可能被自动放行，写动作会弹出审批卡片，被拒绝时不要重试同一个操作。",
    ].join("");
  }
  return [
    "你可以在本机做浏览器与电脑自动化：",
    "用户要求操作桌面应用时，可以调用 computer_assistant，提供明确 goal 和目标应用 bundle ID；它使用设置中独立选择的视觉模型，主模型无需支持图片。未启用或未授权应用时按工具提示处理。",
    "网页场景优先用 browser_cdp（launch 启动调试浏览器 → navigate 打开 → click / type / eval 操作 → console 看日志），",
    "它驱动的是独立 profile 的受控浏览器，不碰用户日常浏览器数据；",
    "桌面原生应用场景用 screenshot 截屏「看」界面、再用 computer_click 按截图像素坐标点，形成看 → 点 → 再看的闭环；",
    "open_in_browser / browser_script / computer_script 仍在，用于打开链接或执行 AppleScript；",
    "只读动作（navigate / screenshot / console）可能被自动放行，写动作与点击会弹出审批卡片，被拒绝时不要重试同一个操作；",
    "screenshot 需要「屏幕录制」权限、computer_click 需要「辅助功能」权限，提示未授权时请告知用户去系统设置授权。",
  ].join("");
}

/** 工具产出的一张图片：由运行期作为 image_url 附到下一条用户消息上 */
export interface ControlToolImage {
  mime: string;
  base64: string;
  width?: number;
  height?: number;
}

/** 一次自动化工具调用的结果；失败时 output 是可读原因 */
export interface ControlToolResult {
  ok: boolean;
  output: string;
  /** 截图类工具产出的图像；**不写进 output**，避免 base64 撑爆上下文 */
  image?: ControlToolImage;
  /** 落盘后的产物文件名（截图会同时存成图片产物，便于右栏预览） */
  name?: string;
}

/** 工具执行期需要的上下文 */
export interface ControlToolContext {
  signal?: AbortSignal;
  approve?: (description: string) => Promise<boolean>;
  /** 当前会话的产物目录（项目 `output/` 或缓存区 `outputs/<日期>/`）：有值时截图会额外落成图片产物 */
  artifactDir: string | null;
}

/** 从参数 JSON 里取一个非空字符串字段 */
function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

/** 从参数 JSON 里取一个数值字段 */
function readNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 把截图落成图片产物，返回文件名；失败不影响工具结果本身。
 *
 * 截图既回灌给模型，也存进产物目录，这样用户能在右栏「图片」tab 里看到模型看到的那一屏。
 */
async function saveShot(
  artifactDir: string | null,
  base64: string,
  prefix: string,
): Promise<string | null> {
  if (!artifactDir || base64.length === 0) return null;
  const name = `${prefix}-${Date.now()}.png`;
  try {
    await writeArtifactBytes(artifactDir, name, base64);
    return name;
  } catch {
    return null;
  }
}

/** 执行一次浏览器 / 电脑自动化工具调用 */
export async function runControlTool(
  tool: string,
  argumentsJson: string,
  context: ControlToolContext,
): Promise<ControlToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, output: "工具参数不是合法 JSON。" };
  }

  if (tool === "computer_assistant") {
    if (!context.signal || !context.approve) return { ok: false, output: "电脑操作缺少取消与审批上下文" };
    const { runComputerAssistant } = await import("../computer/runner");
    try {
      return await runComputerAssistant(args as { goal: string; app: string }, context.signal, context.approve);
    } catch (error) {
      // 前置校验失败（未启用、应用不在允许列表、视觉模型不支持图片）都是确定性错误：
      // 回填给模型让它说明或换方案，不能抛出去把整轮运行判成「模型请求失败」
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
  if (tool === BROWSER_CDP_TOOL_NAME) {
    const action = readString(args, "action");
    if (!action) return { ok: false, output: "browser_cdp 缺少非空 action。" };
    try {
      const result = await runCdpAction(action, args);
      if (!result.image) return result;
      // 网页截图同样落一份产物：模型看过的画面用户也能在右栏核对
      const name = await saveShot(context.artifactDir, result.image.base64, "web-shot");
      return name
        ? { ...result, name, output: `${result.output}已存为产物 ${name}。` }
        : result;
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }

  if (tool === SCREENSHOT_TOOL_NAME) {
    const shot = await takeScreenshot();
    if (!shot.ok) return { ok: false, output: shot.output };
    const name = await saveShot(context.artifactDir, shot.base64, "screen-shot");
    return {
      ok: true,
      output: `${shot.output}${name ? `已存为产物 ${name}。` : ""}`,
      image: { mime: shot.mime, base64: shot.base64, width: shot.width, height: shot.height },
      name: name ?? undefined,
    };
  }

  if (tool === COMPUTER_CLICK_TOOL_NAME) {
    const x = readNumber(args, "x");
    const y = readNumber(args, "y");
    if (x === null || y === null) {
      return { ok: false, output: "computer_click 需要提供数值型 x 与 y。" };
    }
    return computerClick(x, y, readNumber(args, "imageWidth") ?? undefined);
  }

  if (tool === OPEN_IN_BROWSER_TOOL_NAME) {
    const url = readString(args, "url");
    if (!url) return { ok: false, output: "open_in_browser 缺少非空 url。" };
    return openInBrowser(url);
  }

  if (tool === BROWSER_SCRIPT_TOOL_NAME) {
    const browser = readString(args, "browser")?.toLowerCase();
    const action = readString(args, "action")?.toLowerCase();
    const value = readString(args, "value");
    if (browser !== "chrome" && browser !== "safari") {
      return { ok: false, output: "browser_script 的 browser 只能是 chrome 或 safari。" };
    }
    if (action !== "navigate" && action !== "eval") {
      return { ok: false, output: "browser_script 的 action 只能是 navigate 或 eval。" };
    }
    if (!value) {
      return { ok: false, output: "browser_script 缺少非空 value（网址或 JavaScript）。" };
    }
    return runBrowserScript(browser as ControlBrowser, action as ControlBrowserAction, value);
  }

  if (tool === COMPUTER_SCRIPT_TOOL_NAME) {
    const script = typeof args.script === "string" ? args.script : "";
    if (script.trim().length === 0) {
      return { ok: false, output: "computer_script 缺少非空 script。" };
    }
    return runComputerScript(script);
  }

  return { ok: false, output: `未知自动化工具：${tool}` };
}

/**
 * 该自动化调用是否只读。
 *
 * 该分类仅用于审批说明，不作为自动放行依据；实际执行由统一审批闸门决定。
 */
export function isReadOnlyControlCall(tool: string, argumentsJson: string): boolean {
  if (tool === SCREENSHOT_TOOL_NAME) return true;
  if (tool !== BROWSER_CDP_TOOL_NAME) return false;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson.trim() || "{}") as Record<string, unknown>;
  } catch {
    return false;
  }
  const action = readString(args, "action");
  if (!action) return false;
  // 拿不准的动作按写处理：只读白名单必须是枚举，不能是「排除法」
  const readOnly = [
    "launch",
    "targets",
    "navigate",
    "screenshot",
    "console",
    "waitForSelector",
  ];
  return readOnly.includes(action) && !CDP_WRITE_ACTIONS.includes(action);
}
