/** models 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { LOCAL_MODELS_FILE, parseLocalModels } from "../../../model/localModels";
import { readCacheFile } from "../../desktop/cache";
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
         * 读缓存目录下的 `models.json` 并重建模型选择器与当前连接。
         *
         * 文件缺失或内容有问题都属于「用户能自己修好」的配置错误，因此只报错、
         * 不阻塞界面；用户在设置页保存后会自动重新加载。
         */
  loadModelConfig: async () => {
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
  },

  /**
         * 切换模型：连同 `modelConfig` 一起重算。
         *
         * 每个模型自带 `baseUrl` / `apiKey`，不重算的话切换后仍会用上一个模型的地址与密钥。
         * 传入的 id 不在列表里时（例如文件被外部改小）不改变当前连接，避免连到未知地址。
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
         * 模型自己声明了能力的（`supportsImages` 已填写）不受影响。
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
