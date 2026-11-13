/** account 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { LOCAL_MODELS_FILE, parseLocalModels, serializeLocalModels } from "../../../model/localModels";
import { readCacheFile, writeCacheFile } from "../../desktop/cache";
import { CLEARED_MODELS } from "../models";

export const createAccountSlice: StoreSlice<
  | "cachePath"
  | "readLocalModelsText"
  | "saveLocalModels"
  | "setCachePath"
  | "clearCachePath"
> = (set, get) => ({
  cachePath: null,

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
      // 模型列表来自缓存目录下的 models.json，换目录等于换了一批模型
      ...CLEARED_MODELS,
      sessionsRestored: false,
      sessionsRestoring: false,
      sessionsRestoreError: null,
      threads: [],
      messages: {},
      activeThreadId: "",
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
      // 模型文件跟着缓存目录走，解除目录后一并清空
      ...CLEARED_MODELS,
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
