import type { RemoteModel } from "../app/types";

/**
 * 图片输入能力判定（开发者 Jan）。
 *
 * 本次「让模型能看图」只有两条来源，且优先级固定：
 * 1. 后台接口下发的 `supports_images` —— 后台说了算；
 * 2. 接口未下发（`undefined`）时 —— 用用户在设置页的手动开关。
 *
 * 这里的函数是**唯一判定入口**：界面提示、连接派生都必须调用它，
 * 避免各处自行判断导致「界面显示支持、实际请求却不带图片」这类不一致。
 * 继续遵守既有约定：不做任何按模型 `code` 猜测的映射。
 */

/** 图片输入能力的来源，用于设置页区分「接口下发」与「手动设置」两种文案 */
export type VisionSource = "remote" | "manual";

/**
 * 判定某个模型的图片能力来源。
 *
 * 只要后台明确下发了布尔值，来源即为 `remote`（此时手动开关只作展示，不参与判定）；
 * 否则来源为 `manual`，由手动开关决定。
 */
export function visionSourceOf(
  remote: Pick<RemoteModel, "supportsImages"> | null | undefined,
): VisionSource {
  return typeof remote?.supportsImages === "boolean" ? "remote" : "manual";
}

/**
 * 解析某个模型是否支持图片输入。
 *
 * @param remote 后台下发的授权模型；为空（尚未选到模型）时按不支持处理
 * @param manualEnabled 用户在设置页的手动开关状态
 */
export function resolveSupportsImages(
  remote: Pick<RemoteModel, "supportsImages"> | null | undefined,
  manualEnabled: boolean,
): boolean {
  return visionSourceOf(remote) === "remote" ? remote!.supportsImages! : manualEnabled;
}

/**
 * 生成设置页「允许图片输入」一行的说明文案。
 *
 * 文案随来源与最终生效值变化，让用户一眼看清「这个开关此刻到底管不管用」，
 * 避免出现「接口已下发不支持、用户却以为拨动开关就能打开」的误解。
 */
export function describeVisionSource(source: VisionSource, enabled: boolean): string {
  if (source === "remote") {
    return enabled
      ? "当前模型由后台标记为支持图片输入，该能力由后台统一管理，本地开关不参与判定。"
      : "当前模型由后台标记为不支持图片输入，该能力由后台统一管理，本地开关不参与判定。";
  }
  return enabled
    ? "后台未声明当前模型的图片能力，已按你的本地开关允许粘贴与拖拽图片。"
    : "后台未声明当前模型的图片能力，开启后即可粘贴与拖拽图片交给模型识别。";
}
