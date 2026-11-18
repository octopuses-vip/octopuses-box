/** 状态辅助层：models。不依赖 Store 实例，调用方显式传入上下文。 */
import { resolveSupportsImages } from "../../model/visionCapability";
import { supportsChat, type SpecializedModelSelection } from "../../model/chatCapability";
import { connectionFromModel } from "../storeSelectors";
import { type RemoteModel, type ModelOption } from "../types";

/** 将远程模型转换为界面选项，集中处理展示名和视觉能力（开发者 Jan）。 */
function toModelOption(model: RemoteModel, manualImageInput: boolean): ModelOption {
  return {
    id: model.code,
    label: model.name.trim() || model.code,
    description: model.description.trim() || model.provider.trim() || "当前账号可用的模型",
    // 后台下发了 supports_images 就以它为准，未下发时回落到用户在设置页的手动开关
    supportsImages: resolveSupportsImages(model, manualImageInput),
  };
}

/**
 * 把一份模型列表落成界面要用的四件套（开发者 Jan）。
 *
 * 保留已授权模型供各工具使用，并从对话模型中选取当前连接。
 * 当前模型不可用时选第一项，对话列表为空时清空当前连接。
 */
export function applyLoadedModels(
  models: RemoteModel[],
  currentCode: string,
  manualImageInput: boolean,
  specializedModels: SpecializedModelSelection,
) {
  const chatModels = models.filter((model) => supportsChat(model, specializedModels));
  const selected = chatModels.find((model) => model.code === currentCode) ?? chatModels[0];
  return {
    remoteModels: models,
    modelOptions: chatModels.map((model) => toModelOption(model, manualImageInput)),
    model: selected?.code ?? "",
    modelConfig: selected ? connectionFromModel(selected, manualImageInput) : null,
  };
}

/**
 * 清空已加载的模型列表与其派生数据。
 *
 * 登出、切换管理端地址、切换模型来源都要用到：三条路径都必须丢掉旧列表与旧连接，
 * 集中在一处，避免将来新增字段时漏改其中一个分支。
 */
export const CLEARED_MODELS = {
  remoteModels: [],
  modelOptions: [],
  model: "",
  modelConfig: null,
  modelConfigStatus: "idle" as const,
  modelConfigError: null,
};

/**
 * 清空登录态与其派生数据。
 *
 * 登出与「切换管理端地址」都要用到：两者都必须丢掉旧令牌与旧模型列表，
 * 集中在一处，避免将来新增字段时漏改其中一个分支。
 */
export const CLEARED_SESSION = {
  currentUser: null,
  authToken: null,
  ...CLEARED_MODELS,
};
