/** account 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { LOCAL_MODELS_FILE, parseLocalModels, serializeLocalModels } from "../../../model/localModels";
import { readCacheFile, writeCacheFile } from "../../desktop/cache";
import { loginToServer, parseApiError } from "../../desktop/server";
import { CLEARED_SESSION, CLEARED_MODELS } from "../models";

export const createAccountSlice: StoreSlice<
  | "currentUser"
  | "authToken"
  | "endpoint"
  | "modelSource"
  | "cachePath"
  | "setEndpoint"
  | "login"
  | "logout"
  | "setModelSource"
  | "readLocalModelsText"
  | "saveLocalModels"
  | "setCachePath"
  | "clearCachePath"
> = (set, get) => ({
  currentUser: null,

  authToken: null,

  // 从未配置过管理端地址时为 null，路由据此先停在「配置管理端地址」页
  endpoint: null,

  // 全新安装时来源未定：路由据此先停在「选择模型来源」页，
  // 让用户自己决定要不要走登录这条链路，而不是先被问一遍管理端地址
  modelSource: null,

  cachePath: null,

  /**
         * 写入管理端地址。地址没变时只做规范化写入，避免用户点一次「保存」就被登出；
         * 真的换了服务端则一并清空登录态——令牌与模型列表都是旧服务端给的。
         */
  setEndpoint: (endpoint) => {
    const next = { host: endpoint.host.trim(), port: endpoint.port.trim() };
    const current = get().endpoint;
    if (current && current.host === next.host && current.port === next.port) {
      set({ endpoint: next });
      return;
    }
    set({ ...CLEARED_SESSION, endpoint: next });
  },

  login: async (username, password) => {
    const endpoint = get().endpoint;
    if (!endpoint) return { ok: false, error: "尚未配置管理端地址。" };
    try {
      const result = await loginToServer(endpoint, username.trim(), password);
      set({ currentUser: result.user.username, authToken: result.token });
      return { ok: true };
    } catch (error) {
      // 失败文案一律取服务端返回（如「账号或密码错误」「账号已被禁用，请联系管理员」），
      // 连不上服务端时由 parseApiError 给出网络层文案
      return { ok: false, error: parseApiError(error).message };
    }
  },

  /**
         * 退出登录：令牌、模型列表与派生出的连接一并清空，避免残留内容被下一个账号用上。
         * 管理端地址不清——它属于本机配置，不属于某次登录。
         */
  logout: () => set(CLEARED_SESSION),

  /**
         * 切换模型来源（开发者 Jan）。
         *
         * 只清模型列表与派生连接，不清登录态与管理端地址：用户切到本地只是换一条取模型的路，
         * 切回远程时不必重新登录、不必重填地址。清空后状态回到 `idle`，
         * 由 `AppShell` 的启动 effect 立即按新来源重新加载。
         */
  setModelSource: (modelSource) => {
    if (get().modelSource === modelSource) return;
    set({ modelSource, ...CLEARED_MODELS });
  },

  /** 读取本地模型 JSON 原文；未配置缓存目录或文件不存在时返回 null */
  readLocalModelsText: async () => {
    const { cachePath } = get();
    if (!cachePath) return null;
    return readCacheFile(cachePath, LOCAL_MODELS_FILE);
  },

  /**
         * 校验并保存本地模型 JSON（开发者 Jan）。
         *
         * 先整体校验再落盘：写坏这个文件等于把模型链路整体弄断，因此宁可一次报全所有问题
         * 也不写半份内容。落盘写的是重新序列化后的规范文本，用户手写的多余空白与键序会被整理，
         * 但字段值原样保留。保存成功后按新列表重载，用户不必再点一次「重新读取」。
         */
  saveLocalModels: async (raw) => {
    const { cachePath } = get();
    if (!cachePath) return ["尚未配置缓存目录，无法保存本地模型配置。"];
    const { models, errors } = parseLocalModels(raw);
    if (errors.length > 0) return errors;
    try {
      await writeCacheFile(cachePath, LOCAL_MODELS_FILE, serializeLocalModels(models));
    } catch (error) {
      return [`保存失败：${error instanceof Error ? error.message : String(error)}`];
    }
    await get().loadModelConfig();
    return [];
  },

  // 缓存目录变化后要重新读回该目录下的会话与自动化任务，先清空并重置状态
  setCachePath: (path) =>
    set({
      cachePath: path,
      // 本地模式下模型列表来自缓存目录下的 models.json，换目录等于换了一批模型；
      // 远程模式的列表由服务端按账号下发，与缓存目录无关，不跟着清
      ...(get().modelSource === "local" ? CLEARED_MODELS : {}),
      sessionsRestored: false,
      sessionsRestoring: false,
      sessionsRestoreError: null,
      threads: [], messages: {}, activeThreadId: "",
      sessionLoadErrors: {},
      sessionNotices: {},
      automations: [],
      automationRuns: [],
      automationStatus: "idle",
      parallelBatches: [],
      parallelStatus: "idle",
      // 独立会话的产物目录挂在缓存区下，换目录等于换了一批产物，必须清空重读
      artifacts: [],
      artifactStatus: "idle",
      artifactError: null,
      activeArtifact: null,
    }),

  clearCachePath: () =>
    set({
      cachePath: null,
      // 同 `setCachePath`：本地模式下模型文件跟着缓存目录走
      ...(get().modelSource === "local" ? CLEARED_MODELS : {}),
      sessionsRestored: false,
      sessionsRestoring: false,
      sessionsRestoreError: null,
      sessionLoadErrors: {},
      sessionNotices: {},
      // 解除缓存目录后会话不再有归属，回到空态，避免残留内容被写入下一个目录
      threads: [],
      activeThreadId: "",
      messages: {},
      automations: [],
      automationRuns: [],
      automationStatus: "idle",
      parallelBatches: [],
      parallelStatus: "idle",
      artifacts: [],
      artifactStatus: "idle",
      artifactError: null,
      activeArtifact: null,
    })
});
