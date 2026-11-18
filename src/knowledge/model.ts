import { create } from "zustand";

import { isDesktopRuntime } from "../app/desktop/runtime";
import manifest from "./model-manifest.json";

export const KNOWLEDGE_MODEL = manifest;
export const KNOWLEDGE_MODEL_BYTES = manifest.files.reduce((total, file) => total + file.bytes, 0);
export const EMBEDDING_VERSION = `${manifest.id}:${manifest.revision}:cls-l2-v1`;

export interface KnowledgeModelStatus {
  enabled: boolean;
  ready: boolean;
  installed: boolean;
  modelDir: string;
  totalBytes: number;
}

export interface ModelDownloadProgress {
  downloaded: number;
  total: number;
  file: string;
}

/** 独立于设置页生命周期：离开页面后下载继续，返回时仍能查看进度。 */
interface ModelState {
  status: KnowledgeModelStatus | null;
  busy: "checking" | "downloading" | "saving" | "removing" | null;
  progress: ModelDownloadProgress | null;
  error: string | null;
  refresh: () => Promise<void>;
  download: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  remove: () => Promise<void>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const useKnowledgeModel = create<ModelState>((set, get) => {
  let cancelRequested = false;
  let downloadStarted = false;
  let checking: Promise<void> | null = null;
  const run = async (
    busy: NonNullable<ModelState["busy"]>,
    task: () => Promise<KnowledgeModelStatus>,
  ) => {
    if (get().busy) return;
    set({ busy, error: null });
    try {
      set({ status: await task() });
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message === "模型下载已取消" ? null : message });
    } finally {
      set({ busy: null, progress: null });
    }
  };

  return {
    status: null,
    busy: null,
    progress: null,
    error: null,
    refresh: () => {
      if (!isDesktopRuntime()) return Promise.resolve();
      if (checking) return checking;
      checking = run("checking", async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke<KnowledgeModelStatus>("knowledge_model_status");
      }).finally(() => {
        checking = null;
      });
      return checking;
    },
    download: () => run("downloading", async () => {
      if (!isDesktopRuntime()) throw new Error("请在桌面应用中下载向量模型。");
      cancelRequested = false;
      downloadStarted = false;
      set({ progress: { downloaded: 0, total: KNOWLEDGE_MODEL_BYTES, file: "" } });
      const { Channel, invoke } = await import("@tauri-apps/api/core");
      if (cancelRequested) throw new Error("模型下载已取消");
      const progress = new Channel<ModelDownloadProgress>();
      progress.onmessage = (value) => {
        if (get().busy === "downloading") set({ progress: value });
      };
      downloadStarted = true;
      return invoke<KnowledgeModelStatus>("knowledge_model_download", { progress });
    }),
    setEnabled: (enabled) => run("saving", async () => {
      if (!isDesktopRuntime()) throw new Error("请在桌面应用中管理向量模型。");
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<KnowledgeModelStatus>("knowledge_model_set_enabled", { enabled });
    }),
    cancel: async () => {
      if (get().busy !== "downloading") return;
      cancelRequested = true;
      if (!downloadStarted) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("knowledge_model_cancel");
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },
    remove: () => run("removing", async () => {
      if (!isDesktopRuntime()) throw new Error("请在桌面应用中管理向量模型。");
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<KnowledgeModelStatus>("knowledge_model_remove");
    }),
  };
});
