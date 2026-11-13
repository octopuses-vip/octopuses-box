import { useAppStore } from "../app/state";
import { selectModelConnectionByCode } from "../app/storeSelectors";
import { stopComputerRun, useComputerRun, useComputerSettings } from "./settings";

/** 复用已配置的模型服务，独立选择负责桌面操作的视觉模型。 */
export function ComputerSettings() {
  const settings = useComputerSettings(); const run = useComputerRun();
  const models = useAppStore((s) => s.remoteModels);
  return <div className="page__section">
    <div className="page__section-label">电脑操作助手（macOS）</div>
    <label><input type="checkbox" checked={settings.enabled} onChange={(e) => { useComputerSettings.setState({ enabled: e.target.checked }); if (!e.target.checked) stopComputerRun(); }} />按需启用电脑操作助手</label>
    <p className="page__desc">主模型可调用 computer_assistant 完成指定应用中的任务。主屏幕截图会发送至所选模型服务；操作沿用会话权限审批。需授予屏幕录制与辅助功能权限，请将目标窗口放在主屏幕。</p>
    <label className="knowledge-field">电脑操作视觉模型<select className="form__select" disabled={run.running} value={settings.modelCode} onChange={(e) => useComputerSettings.setState({ modelCode: e.target.value })}>
      <option value="">请选择支持图片的模型</option>{models.filter((m) => selectModelConnectionByCode(useAppStore.getState(), m.code)?.supportsImages).map((m) => <option key={m.code} value={m.code}>{m.name || m.code}</option>)}
    </select></label>
    <label className="knowledge-field">允许操作的应用 bundle ID（每行一个）<textarea className="form__input" disabled={run.running} value={settings.allowedApps} placeholder="com.apple.TextEdit" onChange={(e) => useComputerSettings.setState({ allowedApps: e.target.value })} /></label>
    <label className="knowledge-field">单次操作步数上限<input className="form__input" disabled={run.running} type="number" min={1} max={50} value={settings.maxSteps} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 50) useComputerSettings.setState({ maxSteps: value }); }} /></label>
    <p className="page__desc">配置自动保存。可在会话中提出“使用电脑操作助手，在 com.apple.TextEdit 中输入……”；会话停止按钮也会停止该任务。</p>
    <button className="btn btn--sm" disabled={!run.running} onClick={stopComputerRun}>立即停止电脑操作</button>
    {run.progress ? <p role="status">{run.progress}</p> : null}
    {run.log.length ? <details><summary>最近执行记录</summary><pre className="knowledge-preview">{run.log.join("\n")}</pre></details> : null}
  </div>;
}
