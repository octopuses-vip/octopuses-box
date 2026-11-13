/** 桌面适配层：server。运行环境差异在此处理，界面只调用公开函数。 */
import { verifyCredentials, FIXED_ACCOUNT } from "../auth";
import { type Endpoint, type RemoteModel } from "../types";
import { type ApiErrorInfo, type LoginResult } from "./connectionTypes";
import { isDesktopRuntime } from "./runtime";

/** 与 Rust 侧 `CODE_NETWORK_ERROR` 保持一致：网络层失败（未拿到 HTTP 响应） */
export const NETWORK_ERROR_CODE = -1;

/** 把命令抛出的任意错误归一成 `{ code, message }`，非结构化错误给出兜底文案 */
export function parseApiError(error: unknown): ApiErrorInfo {
  if (typeof error === "object" && error !== null) {
    const raw = error as { code?: unknown; message?: unknown };
    if (typeof raw.code === "number" && typeof raw.message === "string") {
      return { code: raw.code, message: raw.message };
    }
  }
  return { code: NETWORK_ERROR_CODE, message: error instanceof Error ? error.message : String(error) };
}

/**
 * 浏览器演示环境的管理端地址预填值。
 *
 * 普通浏览器（`pnpm dev` 直接开浏览器）没有 Rust 侧可以读取环境变量，这里给出与 Rust 侧
 * 默认值一致的地址让「配置管理端地址」页可正常预填；桌面端始终以后端下发的值为准，
 * 因此全项目仅此一处地址字面量。
 */
export const BROWSER_DEMO_ENDPOINT: Endpoint = { host: "127.0.0.1", port: "8000" };

/** 浏览器预览不提供内置模型或共享凭据；模型连接由使用者自行配置。 */
export const BROWSER_REMOTE_MODELS: RemoteModel[] = [];

/** 「配置管理端地址」页的预填值：桌面端由后端读环境变量给出，浏览器演示环境用内置常量 */
export async function defaultEndpoint(): Promise<Endpoint> {
  if (!isDesktopRuntime()) return BROWSER_DEMO_ENDPOINT;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Endpoint>("client_default_endpoint");
}

/**
 * 校验并探测管理端地址，成功时返回规范化后的地址。
 *
 * 桌面端由后端完成「格式校验 + 连通性探测」后再落库，避免把连不上的地址存下来；
 * 浏览器演示环境没有后端可探测，只做去空白后原样返回。
 */
export async function probeEndpoint(endpoint: Endpoint): Promise<Endpoint> {
  const trimmed: Endpoint = { host: endpoint.host.trim(), port: endpoint.port.trim() };
  if (!isDesktopRuntime()) return trimmed;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Endpoint>("client_probe", { endpoint: trimmed });
}

/**
 * 登录 octopuses-server。
 *
 * 桌面端走 Rust 命令发起原生请求（服务端未开启 CORS，WebView 直连会被拦截）；
 * 浏览器演示环境退回内置固定账号，保证界面在两种运行方式下都能进入主界面。
 */
export async function loginToServer(
  endpoint: Endpoint,
  username: string,
  password: string,
): Promise<LoginResult> {
  if (!isDesktopRuntime()) {
    if (!verifyCredentials(username, password)) {
      throw { code: 401, message: "账号或密码错误" } satisfies ApiErrorInfo;
    }
    return {
      token: "browser-demo-token",
      user: { id: 0, username: FIXED_ACCOUNT.username, nickname: "演示账号", status: 1 },
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoginResult>("client_login", { endpoint, username, password });
}

/** 拉取当前用户已授权且启用的模型列表（桌面端走 Rust 命令） */
export async function fetchRemoteModels(
  endpoint: Endpoint,
  token: string,
): Promise<RemoteModel[]> {
  if (!isDesktopRuntime()) return BROWSER_REMOTE_MODELS;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<RemoteModel[]>("client_models", { endpoint, token });
}
