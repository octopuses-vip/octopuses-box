import { useEffect } from "react";
import { useAppStore } from "../app/state";
import { effectiveArtifactDir } from "../app/state/artifacts";
import { selectModelConnectionByCode } from "../app/storeSelectors";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { advanceVideoJob, jobsForScope, restoreVideoJobs } from "./jobs";
import { videoOwner } from "./generate";
import type { VideoJob } from "./protocol";

/** Check current authorization again when resuming a task, independently of the selected chat model. */
export async function checkVideo(scope: string, job: VideoJob, action: "poll" | "resume" | "cancel") {
  const state = useAppStore.getState();
  if (scope !== state.cachePath || job.owner !== videoOwner(state) || !state.threads.some((t) => t.id === job.threadId)) return;
  const connection = selectModelConnectionByCode(state, job.model);
  if (await advanceVideoJob(scope, job.id, connection, action)) {
    const active = () => {
      const latest = useAppStore.getState();
      return latest.cachePath === scope && latest.activeThreadId === job.threadId && videoOwner(latest) === job.owner && effectiveArtifactDir(latest) === job.dir;
    };
    if (!active()) return;
    await state.loadArtifacts();
    if (!active()) return;
    await state.selectArtifact(job.file);
    if (active()) state.setRightTab("media");
  }
}

/** Resume unfinished jobs even when their originating conversation is not open. */
export function useVideoWorker() {
  const scope = useAppStore((s) => s.cachePath);
  const ready = useAppStore((s) => s.sessionsRestored && !s.sessionsRestoreError);
  useEffect(() => {
    if (!scope || !ready || !isDesktopRuntime()) return;
    let disposed = false;
    const tick = async () => {
      await restoreVideoJobs(scope);
      if (!disposed) await Promise.all(jobsForScope(scope).map((job) => checkVideo(scope, job, "poll")));
    };
    let lastError = "";
    const run = () => { void tick().catch((error) => {
      if (!disposed && String(error) !== lastError) {
        lastError = String(error);
        useAppStore.getState().showNotice("无法同步视频任务：" + lastError);
      }
    }); };
    run();
    const timer = setInterval(run, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [scope, ready]);
}
