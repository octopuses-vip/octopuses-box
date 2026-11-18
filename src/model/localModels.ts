import type { RemoteModel } from "../app/types";

/**
 * 本地模型配置：文件名固定，落在缓存目录下（如 `~/octopuses/models.json`）。
 *
 * 与缓存目录同处一地是刻意为之——用户换缓存目录时模型配置跟着走，
 * 不必再维护第二个路径；同时读取与写入可以直接复用 `cache_read` / `cache_write`。
 */
export const LOCAL_MODELS_FILE = "models.json";

/**
 * 首次进入本地模式时预填的模板。
 *
 * 字段与后台下发的 `RemoteModel` 同构（`id` 由本地按下标补齐，用户不必写），
 * 目的是让用户照着改一条就能跑起来，而不是面对一个空白文本框。
 */
export const LOCAL_MODELS_TEMPLATE = `[
  {
    "code": "gpt-4o-mini",
    "name": "GPT-4o mini",
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "description": "示例：改成本机 Ollama / 自建网关的地址与密钥"
  }
]`;

/** 解析结果：`errors` 非空时 `models` 不可用 */
export interface LocalModelsParseResult {
  models: RemoteModel[];
  errors: string[];
}

/** 去掉 UTF-8 BOM：Windows 记事本保存的 JSON 带 BOM，`JSON.parse` 会直接报错 */
function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * 校验并归一化一条本地模型记录（开发者 Jan）。
 *
 * 只强制 `code` 与 `baseUrl`：其余字段留空时按空串处理，与后台下发的语义一致
 * （`name` 空则展示用 `code`，`apiKey` 空表示本地网关不需要鉴权）。
 * `id` 由下标补齐，只为满足 `RemoteModel` 的形状，不参与任何匹配逻辑。
 */
function normalizeEntry(entry: unknown, index: number): { model?: RemoteModel; errors: string[] } {
  const errors: string[] = [];
  const label = `第 ${index + 1} 项`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { errors: [`${label}不是对象，应为 { "code": ..., "baseUrl": ... } 形式`] };
  }
  const item = entry as Record<string, unknown>;

  const code = typeof item.code === "string" ? item.code.trim() : "";
  if (!code) errors.push(`${label}缺少 code（调用模型时用的模型名）`);

  const rawBaseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
  if (!rawBaseUrl) {
    errors.push(`${label}缺少 baseUrl（OpenAI 兼容协议的基础地址）`);
  } else {
    // 必须是绝对 http(s) 地址：相对地址或漏写协议会让后续所有请求静默失败
    let url: URL | null = null;
    try {
      url = new URL(rawBaseUrl);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      errors.push(`${label}的 baseUrl 必须以 http:// 或 https:// 开头：${rawBaseUrl}`);
    }
  }

  if (errors.length > 0) return { errors };

  return {
    model: {
      id: index + 1,
      code,
      name: typeof item.name === "string" ? item.name.trim() : "",
      provider: typeof item.provider === "string" ? item.provider.trim() : "",
      baseUrl: rawBaseUrl,
      apiKey: typeof item.apiKey === "string" ? item.apiKey.trim() : "",
      description: typeof item.description === "string" ? item.description.trim() : "",
      // 未写该字段时保持 undefined（而不是 false）：交给设置页的「允许图片输入」手动开关兜底
      supportsImages: typeof item.supportsImages === "boolean" ? item.supportsImages : undefined,
      ...(typeof item.supportsAudioTranscription === "boolean" ? { supportsAudioTranscription: item.supportsAudioTranscription } : {}),
    },
    errors,
  };
}

/**
 * 解析本地模型 JSON（开发者 Jan）。
 *
 * 顶层必须是数组——与后台 `/api/client/models` 返回的列表同构，用户从后台导出的
 * 结构可以直接粘进来。错误逐条收集并带序号，一次保存就能把所有问题暴露出来，
 * 而不是修一个报一个。`code` 重复也要拦：选择器与当前连接都按 code 匹配，
 * 重复会让用户选中的模型和实际调用的模型不是同一个。
 */
export function parseLocalModels(raw: string): LocalModelsParseResult {
  const trimmed = stripBom(raw).trim();
  if (!trimmed) {
    return { models: [], errors: ["内容为空，请至少配置一条模型"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      models: [],
      errors: [`JSON 格式有误：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!Array.isArray(parsed)) {
    return { models: [], errors: ["顶层必须是数组，形如 [ { ... }, { ... } ]"] };
  }
  if (parsed.length === 0) {
    return { models: [], errors: ["至少需要一条模型配置"] };
  }

  const models: RemoteModel[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const result = normalizeEntry(entry, index);
    errors.push(...result.errors);
    if (!result.model) return;
    if (seen.has(result.model.code)) {
      errors.push(`第 ${index + 1} 项的 code 与前面的条目重复：${result.model.code}`);
      return;
    }
    seen.add(result.model.code);
    models.push(result.model);
  });
  return { models, errors };
}

/**
 * 把本地模型列表写回 JSON 文本（保存时用的规范形态）。
 *
 * 不写 `id`（本地按下标重建，写出来只会多出一列噪音），也不写值为空的可选字段，
 * 让文件保持最小可读；`supportsImages` 只在显式为 true 时落盘。
 */
export function serializeLocalModels(models: RemoteModel[]): string {
  const rows = models.map((model) => {
    const entry: Record<string, unknown> = {
      code: model.code,
      name: model.name,
      provider: model.provider,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      description: model.description,
    };
    if (typeof model.supportsImages === "boolean") entry.supportsImages = model.supportsImages;
    if (typeof model.supportsAudioTranscription === "boolean") entry.supportsAudioTranscription = model.supportsAudioTranscription;
    return entry;
  });
  return JSON.stringify(rows, null, 2);
}
