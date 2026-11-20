import { useState } from "react";
import { useAppStore } from "../app/state";
import { ExportButton } from "../shell/rightpanel/ExportButton";
import { effectiveArtifactDir } from "../app/state/artifacts";
import { Icon } from "../components/Icon";
import type { StreamItem } from "../app/types";
import { ToolCallCard } from "../conversation/blocks/ToolCallCard";
import { useVideoJobs, videoJobAt } from "./jobs";
import { phaseLabel } from "./protocol";
import { checkVideo } from "./useVideoWorker";
import { videoOwner } from "./generate";

type ToolItem = Extract<StreamItem, { type: "tool_call" }>;

/** Show durable job progress and the exact user-supplied first frame. */
export function VideoJobCard({ item }: { item: ToolItem }) {
  const scope = useAppStore((s) => s.cachePath);
  const currentDir = useAppStore((s) => effectiveArtifactDir(s));
  const owner = useAppStore(videoOwner);
  const job = useVideoJobs((s) => videoJobAt(s.jobs, scope, item.videoJobId ?? ""));
  const reference = useAppStore((s) => job?.referenceId && job.owner === owner
    ? s.messages[job.threadId]?.flatMap((m) => m.attachments ?? []).find((a) => a.id === job.referenceId) : null);
  const modelAvailable = useAppStore((s) => s.remoteModels.some((m) => m.code === job?.model && m.baseUrl === job.baseUrl));
  const [busy, setBusy] = useState(false);
  if (!job || !scope || job.owner !== owner) return <ToolCallCard {...item} />;
  const control = async (action: "resume" | "cancel") => {
    setBusy(true);
    try { await checkVideo(scope, job, action); }
    catch (error) { useAppStore.getState().showNotice(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="tool-card">
    <div className="tool-card__head">
      <Icon name="video" size={15} />
      <span className="tool-card__title">{job.referenceId ? "图生视频" : "文生视频"}</span>
      <span className="spacer" /><span role="status">{phaseLabel[job.phase]}</span>
    </div>
    {reference?.dataUrl && <img className="attach-chip__thumb" src={reference.dataUrl} alt={`首帧：${reference.name}`} />}
    {job.phase === "done" && (job.seconds || job.size) && <div className="tool-card__output">实际规格 {[job.seconds ? `${job.seconds} 秒` : "", job.size].filter(Boolean).join(" · ")}</div>}
    {job.detail && <div className="tool-card__output">{job.detail}</div>}
    {job.phase === "done" && job.dir !== currentDir && <div className="tool-card__output">已保存到 {job.dir}/{job.file} <ExportButton name={job.file} source={{ kind: "artifact", dir: job.dir, name: job.file }} /></div>}
    {job.phase === "done" && job.dir === currentDir && <button type="button" className="btn btn--ghost btn--sm" onClick={async () => {
      const s = useAppStore.getState();
      await s.loadArtifacts();
      if (useAppStore.getState().activeThreadId !== job.threadId) return;
      await s.selectArtifact(job.file);
      if (useAppStore.getState().activeThreadId === job.threadId) s.setRightTab("media");
    }}>播放 {job.file}</button>}
    {!modelAvailable && job.taskId && ["queued", "running", "retrying", "paused", "downloading"].includes(job.phase) &&
      <span className="muted">等待原视频模型连接恢复</span>}
    {["paused", "retrying"].includes(job.phase) && <button disabled={busy || !modelAvailable} className="btn btn--sm" onClick={() => void control("resume")}>{job.phase === "retrying" ? "立即重试" : "继续原任务"}</button>}
    {job.phase === "queued" && (!job.api || job.api === "seedance") && <button disabled={busy || !modelAvailable} className="btn btn--ghost btn--sm" onClick={() => void control("cancel")}>取消排队</button>}
  </div>;
}
