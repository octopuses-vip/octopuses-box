import { useAppStore } from "../../app/state";
import { IconButton } from "../../components/Button";

/**
 * 模型来源标识（开发者 Jan）。
 *
 * 只做展示不做交互：本地模型模式下说明模型来自缓存目录的 models.json（无需登录），
 * 登录模式显示当前用户。放在顶栏右侧操作区，常驻为一个安静的小图标，
 * 完整说明走 hover 提示，左侧品牌与位置上下文保持纯净。
 */
export function ModelSourceBadge() {
  const currentUser = useAppStore((state) => state.currentUser);
  const modelSource = useAppStore((state) => state.modelSource);
  const local = modelSource === "local";
  return (
    <IconButton
      icon={local ? "folder" : "user"}
      size={13}
      label={local ? "本地模型模式" : (currentUser ?? "未登录")}
      title={
        local
          ? "本地模型模式：模型列表来自缓存目录下的 models.json，无需登录"
          : (currentUser ?? "未登录")
      }
    />
  );
}
