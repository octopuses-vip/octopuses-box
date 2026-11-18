import { useAppStore } from "../app/state";
import { transcriptionCapability } from "./models";

export function TranscriptionModelSetting() {
  const code = useAppStore((state) => state.audioModelCode);
  const setCode = useAppStore((state) => state.setAudioModelCode);
  const models = useAppStore((state) => state.remoteModels);
  const known = models.filter((model) => transcriptionCapability(model) === "supported");
  const other = models.filter((model) => transcriptionCapability(model) === "unverified");
  const invalid = code && ![...known, ...other].some((model) => model.code === code);
  return (
    <label className="list-row">
      <span className="list-row__main">
        <span className="list-row__title">音频转文字模型</span>
        <span className="list-row__desc">
          拖入 MP3 等文件时自动转写。需要已授权且支持 /audio/transcriptions 的模型。
          {known.length === 0 && "当前列表没有可自动识别的语音模型。"}
        </span>
      </span>
      <select aria-label="音频转文字模型" value={code} onChange={(event) => setCode(event.target.value)}>
        <option value="">{known.length === 1 ? `自动（${known[0].name || known[0].code}）` : "自动（需有唯一的语音模型）"}</option>
        {invalid && <option value={code} disabled>原模型不可用，请重新选择</option>}
        {known.length > 0 && <optgroup label="语音识别模型">
          {known.map((model) => <option key={model.code} value={model.code}>{model.name || model.code}</option>)}
        </optgroup>}
        {other.length > 0 && <optgroup label="其他模型（请确认支持转写接口）">
          {other.map((model) => <option key={model.code} value={model.code}>{model.name || model.code}</option>)}
        </optgroup>}
      </select>
    </label>
  );
}
