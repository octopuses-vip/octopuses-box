import { useAppStore } from "../app/state";

/** 独立选择出图服务，并在原模型下架后保留可读的配置提示。 */
export function ImageGenerationModelSetting() {
  const code = useAppStore((state) => state.imageModelCode);
  const setCode = useAppStore((state) => state.setImageModelCode);
  const models = useAppStore((state) => state.remoteModels);
  const unavailable = code && !models.some((model) => model.code === code);
  return <label className="list-row">
    <span className="list-row__main">
      <span className="list-row__title">图片生成模型</span>
      <span className="list-row__desc">选择用于生成图片的模型，将使用它的服务地址和密钥。自动模式沿用当前对话服务。</span>
    </span>
    <select aria-label="图片生成模型" value={code} onChange={(event) => setCode(event.target.value)}>
      <option value="">自动（跟随对话服务）</option>
      {unavailable && <option value={code} disabled>原模型不可用，请重新选择</option>}
      {models.map((model) => <option key={model.code} value={model.code}>{model.name || model.code}</option>)}
    </select>
  </label>;
}
