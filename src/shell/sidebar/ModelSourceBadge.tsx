import { useAppStore } from "../../app/state";
import { IconButton } from "../../components/Button";

/** 本地模式打开模型设置，管理端模式打开当前账号信息。 */
export function ModelSourceBadge() {
  const currentUser = useAppStore((state) => state.currentUser);
  const modelSource = useAppStore((state) => state.modelSource);
  const openSettings = useAppStore((state) => state.openSettings);
  const local = modelSource === "local";
  const label = local ? "打开模型设置" : "打开账号设置";
  return (
    <IconButton
      icon={local ? "folder" : "user"}
      size={13}
      label={label}
      title={local ? `本地模型 · ${label}` : `${currentUser ?? "未登录"} · ${label}`}
      onClick={() => openSettings(local ? "models" : "about")}
    />
  );
}
