/** models 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { LOCAL_MODELS_FILE, parseLocalModels } from "../../../model/localModels";
import { readCacheFile } from "../../desktop/cache";
import { fetchRemoteModels, parseApiError, NETWORK_ERROR_CODE } from "../../desktop/server";
import { connectionFromModel } from "../../storeSelectors";
import { applyLoadedModels, toModelOption } from "../models";

export const createModelsSlice: StoreSlice<
  | "model"
  | "modelOptions"
  | "remoteModels"
  | "modelConfig"
  | "videoModelCode"
  | "setVideoModelCode"
  | "audioModelCode"
  | "setAudioModelCode"
  | "imageInputEnabled"
  | "modelConfigStatus"
  | "modelConfigError"
  | "loadModelConfig"
  | "setModel"
  | "setImageInputEnabled"
> = (set, get) => ({
  model: "",

  videoModelCode: "",
  setVideoModelCode: (videoModelCode) => set({ videoModelCode }),

  audioModelCode: "",
  /** Retain an explicit choice without guessing capability from model names. */
  setAudioModelCode: (audioModelCode) => set({ audioModelCode }),

  modelOptions: [],

  remoteModels: [],

  modelConfig: null,

  // 默认关闭：图片输入属于会额外消耗 token 的能力，由用户显式开启
  imageInputEnabled: false,

  modelConfigStatus: "idle",

  modelConfigError: null,

  /**
         * 按当前来源加载模型列表，并据此重建选择器与当前连接。
         *
         * 远程：拉取当前账号已授权且启用的模型。权限类失败（401 令牌失效 / 403 账号被禁用）
         * 意味着这个会话已经不能继续用，直接退出登录回到登录页：401 静默处理，
         * 403 由登录页展示服务端给的禁用文案。
         *
         * 本地：读缓存目录下的 `models.json` 并按同一套校验解析。文件缺失或内容有问题
         * 都属于「用户能自己修好」的配置错误，因此只报错、不退出登录，也不回退到远程。
         */
  loadModelConfig: async () => {
    if (get().modelSource === "local") {
      const { cachePath } = get();
      if (!cachePath) {
        set({
          modelConfigStatus: "idle",
          modelConfigError: "尚未配置缓存目录，无法读取本地模型配置。",
        });
        return;
      }
      set({ modelConfigStatus: "loading", modelConfigError: null });
      try {
        const raw = await readCacheFile(cachePath, LOCAL_MODELS_FILE);
        if (raw === null) {
          set({
            modelConfigStatus: "error",
            modelConfigError: `缓存目录下没有 ${LOCAL_MODELS_FILE}，请在设置页「本地模型配置」里保存一份。`,
          });
          return;
        }
        const { models, errors } = parseLocalModels(raw);
        if (errors.length > 0) {
          set({
            modelConfigStatus: "error",
            modelConfigError: `${LOCAL_MODELS_FILE} 有问题：${errors.join("；")}`,
          });
          return;
        }
        set({
          ...applyLoadedModels(models, get().model, get().imageInputEnabled),
          modelConfigStatus: "ready",
        });
      } catch (error) {
        set({
          modelConfigStatus: "error",
          modelConfigError: `读取本地模型配置失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    const { authToken: token, endpoint } = get();
    if (!endpoint) {
      set({ modelConfigStatus: "idle", modelConfigError: "尚未配置管理端地址。" });
      return;
    }
    if (!token) {
      set({ modelConfigStatus: "idle", modelConfigError: "尚未登录，无法获取模型列表。" });
      return;
    }
    set({ modelConfigStatus: "loading", modelConfigError: null });
    try {
      const models = await fetchRemoteModels(endpoint, token);
      // 收尾与本地分支共用 `applyLoadedModels`：保留原选中模型，否则落到列表首项
      const manualImageInput = get().imageInputEnabled;
      set({
        ...applyLoadedModels(models, get().model, manualImageInput),
        modelConfigStatus: "ready",
      });
    } catch (error) {
      const { code, message } = parseApiError(error);
      // 403：账号被管理员禁用，属于需要用户知晓的管理动作，退出后保留文案给登录页展示
      if (code === 403) {
        get().logout();
        set({ modelConfigError: message });
        return;
      }
      // 401：令牌非法或已过期，按文档约定静默清空登录态回到登录页重新登录
      if (code === 401) {
        get().logout();
        return;
      }
      set({
        modelConfigStatus: "error",
        modelConfigError:
          code === NETWORK_ERROR_CODE ? message : `获取模型列表失败：${message}`,
      });
    }
  },

  /**
         * 切换模型：连同 `modelConfig` 一起重算。
         *
         * 每个授权模型自带 `baseUrl` / `apiKey`，不重算的话切换后仍会用上一个模型的地址与密钥。
         * 传入的 id 不在授权列表里时（例如列表被后台收窄）不改变当前连接，避免连到未知地址。
         */
  setModel: (model) =>
    set((state) => {
      const selected = state.remoteModels.find((item) => item.code === model);
      return {
        model,
        ...(selected
          ? { modelConfig: connectionFromModel(selected, state.imageInputEnabled) }
          : {}),
      };
    }),

  /**
         * 切换「允许图片输入」手动开关（开发者 Jan）。
         *
         * 手动开关参与 `supportsImages` 的判定，因此改开关必须同步重算 `modelOptions`
         * 与 `modelConfig`：否则输入框的禁止提示与真正发出的请求会不一致。
         * 后台已下发能力的模型不受影响（`resolveSupportsImages` 会优先取接口值）。
         */
  setImageInputEnabled: (imageInputEnabled) =>
    set((state) => {
      const selected = state.remoteModels.find((item) => item.code === state.model);
      return {
        imageInputEnabled,
        modelOptions: state.remoteModels.map((model) =>
          toModelOption(model, imageInputEnabled),
        ),
        modelConfig: selected
          ? connectionFromModel(selected, imageInputEnabled)
          : state.modelConfig,
      };
    })
});
