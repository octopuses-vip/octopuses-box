import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { readFileBytes, type FileLocation } from "./files";
import { readArtifactBytes } from "./artifacts";
import { isDesktopRuntime } from "./runtime";
import type { VideoJob } from "../../video/protocol";

/** Restore the small job records from this cache, without loading chat attachments. */
export async function listVideoJobs(scope: string): Promise<VideoJob[]> {
  const rows = await invoke<string[]>("video_jobs", { cacheDir: scope });
  return rows.map((row) => JSON.parse(row) as VideoJob);
}

/** Reserve a unique job or persist its latest observed state. */
export function saveVideoJob(scope: string, job: VideoJob, create = false): Promise<void> {
  return invoke("video_save_job", { cacheDir: scope, threadId: job.threadId, id: job.id, payload: JSON.stringify(job), create });
}

/** Download via Rust without transferring video bytes through IPC. */
export function downloadVideo(job: VideoJob, url: string, key?: string): Promise<void> {
  return invoke("video_download", { dir: job.dir, name: job.file, url, ...(key ? { key } : {}) });
}

/** Authorize an individual file and hand its native asset URL to the player. */
export async function videoPreviewUrl(source: FileLocation): Promise<string> {
  if (!isDesktopRuntime()) {
    const bytes = source.kind === "artifact" ? await readArtifactBytes(source.dir, source.name) : await readFileBytes(source);
    return URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
  }
  return convertFileSrc(await invoke<string>("video_preview_path", { source }));
}
