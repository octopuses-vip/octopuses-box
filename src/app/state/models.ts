/** 状态辅助层：models。不依赖 Store 实例，调用方显式传入上下文。 */
import { resolveSupportsImages } from "../../model/visionCapability";
import { connectionFromModel } from "../storeSelectors";
import { type RemoteModel, type ModelOption } from "../types";

/** 将模型条目转换为界面选项，集中处理展示名和视觉能力（开发者 Jan）。 */
export function toModelOption(model: RemoteModel, manualImageInput: boolean): ModelOption {
  return {
    id: model.code,
    label: model.name.trim() || model.code,
    description: model.description.trim() || model.provider.trim() || "当前可用的模型",
    // 条目里写了 supportsImages 就以它为准，未写时回落到用户在设置页的手动开关
    supportsImages: resolveSupportsImages(model, manualImageInput),
  };
}

/**
 * 把一份模型列表落成界面要用的四件套（开发者 Jan）。
 *
 * 保留用户原来选中的模型（还能用就沿用），否则落到列表首项；列表为空时不设默认值，
 * 由界面呈现「无可用模型」而不是留一个不存在的 id。
 */
export function applyLoadedModels(
  models: RemoteModel[],
  currentCode: string,
  manualImageInput: boolean,
) {
  const selected = models.find((model) => model.code === currentCode) ?? models[0] ?? null;
  return {
    remoteModels: models,
    modelOptions: models.map((model) => toModelOption(model, manualImageInput)),
    model: selected?.code ?? "",
    modelConfig: selected ? connectionFromModel(selected, manualImageInput) : null,
  };
}

/**
 * 清空已加载的模型列表与其派生数据。
 *
 * 切换缓存目录（等于换了一批 `models.json`）时要丢掉旧列表与旧连接，
 * 集中在一处，避免将来新增字段时漏改。
 */
export const CLEARED_MODELS = {
  remoteModels: [],
  modelOptions: [],
  model: "",
  modelConfig: null,
  modelConfigStatus: "idle" as const,
  modelConfigError: null,
};
