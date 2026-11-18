/**
 * `generate_image` 工具：调用网关的 `/images/generations` 生成图片，落盘到当前会话的产物目录
 * （项目会话在项目根下的 `output/`，临时会话在缓存区的 `outputs/<日期>/`），右栏「媒体」tab 随即可以预览。
 *
 * 走「探测 + 降级」：先看 `/models` 有没有图像模型、再退回空体 POST 探一次路由，结果缓存 24h；
 * 网关没有渠道时返回**可读的不可用提示**而不是静默失败，渠道开通后无需改代码即生效。
 *
 * 三个请求（两次探测 + 一次生成）在桌面端都经 Rust 侧代理发出，原因见 `app/desktop.ts`
 * 的「模型请求代理」一节。
 */

import { fetchModelResource, generateImage, type ImageGenerationResult } from "../app/desktop/models";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { writeArtifactBytes } from "../app/desktop/artifacts";
import { type ModelConnection } from "../app/desktop/connectionTypes";
import type { ChatTool } from "../model/client";

/** 工具名，与模型返回的 function.name 对应 */
export const IMAGE_GEN_TOOL_NAME = "generate_image";

/** 支持的出图尺寸（与接口的 size 取值一致） */
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"];

/**
 * 判定图像模型的 id 关键词。
 *
 * 网关的 `/models` 只给 id，没有能力字段，只能按命名习惯识别；命中后即认为渠道可用。
 */
const IMAGE_MODEL_HINTS = [
  "dall-e",
  "gpt-image",
  "image",
  "flux",
  "stable-diffusion",
  "midjourney",
  "kolors",
  "wanx",
];

/** 探测结果缓存时长：渠道开通后最多 24 小时生效，期间不再重复请求 */
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/** 图像生成可用性探测结果 */
export interface ImageSupportProbe {
  /** 是否可用 */
  available: boolean;
  /** 可用时选中的图像模型 id；不可用时为空串 */
  model: string;
  /** 不可用时的可读原因 */
  reason: string;
}

/** 探测结果缓存：按「地址 + 密钥」区分网关，避免切换配置后读到旧结论 */
let probeCache: { key: string; at: number; result: ImageSupportProbe } | null = null;

/** `generate_image` 的工具定义 */
export const IMAGE_GEN_TOOL: ChatTool = {
  type: "function",
  function: {
    name: IMAGE_GEN_TOOL_NAME,
    description:
      "根据文字描述生成一张图片并写入工作区，用户可在右侧面板直接预览。" +
      "用户要求画图、生成配图 / 插画 / 海报 / 图标时使用；" +
      "若返回不可用提示，说明当前网关没有图像渠道，请改用 write_artifact 产出 SVG 或 HTML 图形。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片内容的详细描述，建议包含主体、风格、构图与色调。",
        },
        size: {
          type: "string",
          description: `图片尺寸，取值：${IMAGE_SIZES.join(" / ")}；默认 ${IMAGE_SIZES[0]}`,
        },
        name: {
          type: "string",
          description: "保存的文件名（含 .png 扩展名），不填时按时间自动命名。",
        },
      },
      required: ["prompt"],
    },
  },
};

/** `generate_image` 的执行结果：成功时返回文件名，失败时 output 是可读原因 */
export interface ImageGenResult {
  ok: boolean;
  output: string;
  /** 成功写出的图片文件名 */
  name: string | null;
}

/** 触发模型在需要配图时使用 `generate_image` 的系统提示 */
export function buildImageGenHint(): string {
  return [
    "需要图片素材（配图、插画、图标、海报）时可用 generate_image 生成并落盘；",
    "它返回文件名，可在右侧面板预览。若它回「不可用」，说明当前网关没有图像渠道，",
    "此时改用 write_artifact 写 SVG 或 HTML 图形，不要反复重试 generate_image。",
  ].join("");
}

/** 拉取网关的模型 id 列表；请求失败返回 null（与「列表为空」区分开） */
async function listModelIds(
  connection: ModelConnection,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const url = `${connection.url.replace(/\/+$/, "")}/models`;
  try {
    let text: string;
    if (isDesktopRuntime()) {
      const result = await fetchModelResource({ method: "GET", url, key: connection.key, signal });
      if (result.aborted || result.status < 200 || result.status >= 300) return null;
      text = result.body;
    } else {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${connection.key}` },
        signal,
      });
      if (!response.ok) return null;
      text = await response.text();
    }
    const payload = JSON.parse(text) as { data?: { id?: unknown }[] };
    return (payload.data ?? [])
      .map((item) => (typeof item.id === "string" ? item.id : ""))
      .filter((id) => id.length > 0);
  } catch {
    return null;
  }
}

/**
 * 兜底探测：对 `/images/generations` 发一次空体 POST，只探路由与渠道是否存在。
 *
 * 空体不会真的出图（缺 prompt 必然被拒），因此不消耗配额；返回失败状态的可读片段，
 * 正是要展示给模型与用户的降级原因（例如 `503 model_not_found`）。
 */
async function probeImageRoute(
  connection: ModelConnection,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${connection.url.replace(/\/+$/, "")}/images/generations`;
  try {
    if (isDesktopRuntime()) {
      const result = await fetchModelResource({
        method: "POST",
        url,
        key: connection.key,
        body: "{}",
        signal,
      });
      if (result.aborted) return "请求已中断";
      if (result.status < 200 || result.status >= 300) {
        return `${result.status} ${result.body.slice(0, 120)}`.trim();
      }
      return "";
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.key}`,
      },
      body: "{}",
      signal,
    });
    if (response.ok) return "";
    const text = await response.text();
    return `${response.status} ${text.slice(0, 120)}`.trim();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 探测图像生成是否可用：先查 `/models` 是否含图像模型，再退回空体 POST 探路由。
 *
 * 任一成功都算可用；结果缓存 24h，渠道开通后无需改代码即生效。
 */
export async function probeImageSupport(
  connection: ModelConnection,
  signal?: AbortSignal,
): Promise<ImageSupportProbe> {
  const key = `${connection.url}|${connection.key}`;
  if (probeCache && probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.result;
  }

  const ids = await listModelIds(connection, signal);
  const hit = (ids ?? []).find((id) =>
    IMAGE_MODEL_HINTS.some((hint) => id.toLowerCase().includes(hint)),
  );
  let result: ImageSupportProbe;
  if (hit) {
    result = { available: true, model: hit, reason: "" };
  } else {
    const detail = await probeImageRoute(connection, signal);
    result = {
      available: false,
      model: "",
      reason: `当前网关没有可用的图像生成渠道${detail.length > 0 ? `（${detail}）` : ""}`,
    };
  }
  probeCache = { key, at: Date.now(), result };
  return result;
}

/** 把模型给的文件名收敛成合法的 PNG 产物名；不合法时按时间兜底 */
function resolveImageName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return `image-${Date.now()}.png`;
  const safe = trimmed.replace(/[\\/]/g, "").replace(/^\.+/, "");
  const named = safe.length > 0 ? safe : `image-${Date.now()}.png`;
  return named.toLowerCase().endsWith(".png") ? named : `${named}.png`;
}

/**
 * 执行一次 `generate_image`。
 *
 * 参数缺失、渠道不可用、接口报错都作为可读文本返回，让模型自行改道（写 SVG）或向用户说明。
 *
 * @param artifactDir 当前会话的产物目录（项目 `output/` 或缓存区 `outputs/<日期>/`），未确定时无法落盘
 */
export async function runGenerateImageTool(
  artifactDir: string | null,
  connection: ModelConnection | null,
  argumentsJson: string,
  signal?: AbortSignal,
): Promise<ImageGenResult> {
  let prompt = "";
  let size = IMAGE_SIZES[0];
  let name = "";
  try {
    const parsed = JSON.parse(argumentsJson.trim() || "{}") as {
      prompt?: unknown;
      size?: unknown;
      name?: unknown;
    };
    if (typeof parsed.prompt === "string") prompt = parsed.prompt.trim();
    if (typeof parsed.size === "string" && IMAGE_SIZES.includes(parsed.size.trim())) {
      size = parsed.size.trim();
    }
    if (typeof parsed.name === "string") name = parsed.name;
  } catch {
    return {
      ok: false,
      output: '工具参数不是合法 JSON，请按 { "prompt": "一只猫" } 调用。',
      name: null,
    };
  }

  if (prompt.length === 0) {
    return { ok: false, output: "缺少参数 prompt，请描述要生成的图片内容。", name: null };
  }
  if (!connection) {
    return { ok: false, output: "尚未取到模型连接信息，无法调用图像接口。", name: null };
  }

  const probe = await probeImageSupport(connection, signal);
  if (!probe.available) {
    return {
      ok: false,
      output: `${probe.reason}。可改用 write_artifact 产出 SVG 或 HTML 图形作为替代。`,
      name: null,
    };
  }

  let generated: ImageGenerationResult;
  try {
    generated = await generateImage(connection, probe.model, prompt, size, signal);
  } catch (error) {
    // 用户点了停止：原样抛出，由运行循环按中断处理
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, output: `生成图片失败：${String(error)}`, name: null };
  }
  if (!generated.ok || !generated.base64) {
    return { ok: false, output: generated.output, name: null };
  }

  const fileName = resolveImageName(name);
  try {
    const bytes = await writeArtifactBytes(artifactDir, fileName, generated.base64);
    return {
      ok: true,
      output: `已生成 ${fileName}（${bytes} 字节），用户可在右侧面板「媒体」中查看。`,
      name: fileName,
    };
  } catch (error) {
    return {
      ok: false,
      output: `图片落盘失败：${error instanceof Error ? error.message : String(error)}`,
      name: null,
    };
  }
}