/** artifacts 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { AppStore } from "../../storeTypes";
import type { StoreSlice } from "../slice";
import { DRAWINGS_DIR } from "../../../model/drawings";
import { drawingEntryKey } from "../../../model/drawingSources";
import {
  listArtifacts,
  listLegacyArtifacts,
  type LegacyArtifactTarget,
  migrateLegacyArtifacts,
  artifactKind,
  readArtifactBytes,
  artifactMime,
  readArtifact,
} from "../../desktop/artifacts";
import { videoPreviewUrl } from "../../desktop/video";
import { readFileBytes, listWorkspaceDir, type FileLocation } from "../../desktop/files";
import { readWorkspaceFile } from "../../desktop/workspace";
import {
  effectiveArtifactDir,
  revokeObjectUrl,
  artifactOwnersOf,
  isMarkdownFileLink,
  resolveMarkdownLinkTarget,
  TEMP_OUTPUT_DIR,
  artifactDateKey,
} from "../artifacts";
import { isHtmlArtifact } from "../../../tools/writeFile";
import { effectiveWorkspacePath } from "../workspace";

type PreviewSource = Exclude<FileLocation, { kind: "absolute" }>;
type ActivePreview = NonNullable<AppStore["activeArtifact"]>;

/** 复用产物和工作区的读取通道，保留预览文件的实际来源。 */
async function readPreview(source: PreviewSource, artifacts: AppStore["artifacts"]): Promise<ActivePreview> {
  const name = source.kind === "artifact" ? source.name : source.path.split("/").at(-1)!;
  const meta = source.kind === "artifact" ? artifacts.find((item) => item.name === name) : undefined;
  const kind = meta?.kind ?? artifactKind(name);
  const preview = { source, name, kind, bytes: meta?.bytes ?? 0, modifiedAt: meta?.modifiedAt ?? 0, content: "", objectUrl: null };

  if (kind === "video") return { ...preview, objectUrl: await videoPreviewUrl(source) };
  if (kind === "image" || kind === "pdf") {
    const bytes = source.kind === "artifact" ? await readArtifactBytes(source.dir, name) : await readFileBytes(source);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: artifactMime(name) }));
    return { ...preview, bytes: meta?.bytes ?? bytes.length, objectUrl };
  }
  if (kind === "binary") return preview;

  const content = source.kind === "artifact" ? await readArtifact(source.dir, name) : await readWorkspaceFile(source.projectPath, source.path);
  return { ...preview, content, bytes: meta?.bytes ?? new TextEncoder().encode(content).length };
}

export const createArtifactsSlice: StoreSlice<
  | "artifacts"
  | "artifactStatus"
  | "artifactError"
  | "activeArtifact"
  | "legacyMigrationDone"
  | "loadArtifacts"
  | "migrateLegacyArtifacts"
  | "selectArtifact"
  | "openMarkdownLink"
  | "workspaceImports"
  | "importsStatus"
  | "activeDrawing"
  | "loadWorkspaceImports"
  | "selectDrawing"
> = (set, get) => {
  let previewRequest = 0;

  /** 异步读取结束时，只允许最新请求修改原会话的预览。 */
  function beginPreview() {
    const request = ++previewRequest;
    const state = get();
    const artifactDir = effectiveArtifactDir(state);
    const workspacePath = effectiveWorkspacePath(state);
    function isCurrent() {
      const current = get();
      return request === previewRequest && current.activeThreadId === state.activeThreadId &&
        current.cachePath === state.cachePath && effectiveArtifactDir(current) === artifactDir &&
        effectiveWorkspacePath(current) === workspacePath;
    }
    return { state, artifactDir, workspacePath, isCurrent };
  }

  /** 只在成功选中新文件后释放上一份预览，失败时保留原内容。 */
  function replacePreview(preview: AppStore["activeArtifact"], error: string | null = null) {
    revokeObjectUrl(get().activeArtifact?.objectUrl);
    set({ activeArtifact: preview, artifactError: error });
  }

  return {
    artifacts: [],

    artifactStatus: "idle",

    artifactError: null,

    activeArtifact: null,

    legacyMigrationDone: false,

    loadArtifacts: async () => {
      const stateAtLoad = get();
      const dir = effectiveArtifactDir(stateAtLoad);
      const currentScope = () => get().activeThreadId === stateAtLoad.activeThreadId &&
        get().cachePath === stateAtLoad.cachePath && effectiveArtifactDir(get()) === dir;
      if (!dir) {
        // 还没有可用的产物目录（未选缓存目录 / 项目会话没有工作目录）：直接回到空态，
        // 不去读上一个会话的目录，否则右栏会串会话
        set({
          artifacts: [],
          artifactStatus: "idle",
          artifactError: null,
          activeArtifact: stateAtLoad.activeArtifact?.source.kind === "workspace" &&
            stateAtLoad.activeArtifact.source.projectPath === effectiveWorkspacePath(stateAtLoad)
            ? stateAtLoad.activeArtifact : null,
        });
        return;
      }
      set({ artifactStatus: "loading", artifactError: null });
      try {
        const artifacts = await listArtifacts(dir);
        if (!currentScope()) return;
        set((state) => {
          // 选中的产物已被清空时同步取消选中，避免预览到不存在的文件
          const preview = state.activeArtifact;
          const source = preview?.source;
          const stillExists = source?.kind === "workspace"
            ? source.projectPath === effectiveWorkspacePath(state)
            : source?.kind === "artifact" && source.dir === dir &&
              (preview !== stateAtLoad.activeArtifact || artifacts.some((item) => item.name === source.name));
          if (!stillExists) revokeObjectUrl(state.activeArtifact?.objectUrl);
          return {
            artifacts,
            artifactStatus: "ready",
            activeArtifact: stillExists ? state.activeArtifact : null,
          };
        });
      } catch (error) {
        if (!currentScope()) return;
        set({
          artifactStatus: "error",
          artifactError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    migrateLegacyArtifacts: async () => {
      // 每次启动最多跑一次：搬完旧目录就空了，重复调用只是白读一趟磁盘
      if (get().legacyMigrationDone) return;
      const cachePath = get().cachePath;
      if (!cachePath) return;
      set({ legacyMigrationDone: true });
      try {
        const legacy = await listLegacyArtifacts(cachePath);
        if (legacy.length === 0) return;
        // 归属来自会话记录：旧目录里的文件不带会话信息，只有工具片段能说明是谁写出来的
        const owners = artifactOwnersOf(get().messages);
        const targets: LegacyArtifactTarget[] = [];
        for (const file of legacy) {
          const threadId = owners.get(file.name);
          const dir = threadId ? effectiveArtifactDir(get(), threadId) : null;
          if (dir) {
            targets.push({ name: file.name, dir });
            continue;
          }
          // 认不出归属（旧记录缺 `arguments`、会话已删、项目已无目录）：按文件写入日退回
          // 缓存区当天的独立会话目录，至少还能在右栏看到，而不是永远埋在旧目录里
          targets.push({
            name: file.name,
            dir: `${cachePath}/${TEMP_OUTPUT_DIR}/${artifactDateKey(file.modifiedAt)}`,
          });
        }
        const result = await migrateLegacyArtifacts(cachePath, targets);
        // 搬完按当前会话的目录重读一次，右栏立刻显示恢复出来的产物，不必重启
        if (result.moved > 0) void get().loadArtifacts();
      } catch {
        // 迁移失败不影响正常使用：旧目录原样留着，下次启动再试一次
        set({ legacyMigrationDone: false });
      }
    },

    selectArtifact: async (name) => {
      const { state, artifactDir, isCurrent } = beginPreview();
      if (!name || !artifactDir) {
        replacePreview(null, name ? "尚未确定产物目录，无法读取产物。" : null);
        return;
      }
      try {
        const preview = await readPreview({ kind: "artifact", dir: artifactDir, name }, state.artifacts);
        if (isCurrent()) replacePreview(preview);
        else revokeObjectUrl(preview.objectUrl);
      } catch (error) {
        if (isCurrent()) replacePreview(null, error instanceof Error ? error.message : String(error));
      }
    },

    openMarkdownLink: (href) => {
      if (!isMarkdownFileLink(href)) return false;
      const { state, artifactDir, workspacePath, isCurrent } = beginPreview();
      void (async () => {
        let artifacts = state.artifactStatus === "ready" ? state.artifacts : [];
        let target = resolveMarkdownLinkTarget(href, { artifacts, artifactDir, workspacePath });
        // 会话刚打开或产物列表过期时，读取一次实际目录再决定同名文件来自哪里。
        if (artifactDir && target?.kind !== "artifact") {
          artifacts = await listArtifacts(artifactDir);
          if (!isCurrent()) return;
          target = resolveMarkdownLinkTarget(href, { artifacts, artifactDir, workspacePath });
        }
        if (!target || target.kind === "absolute") throw new Error("文件不存在或不在当前会话目录内。");
        const preview = await readPreview(target, artifacts);
        if (!isCurrent()) {
          revokeObjectUrl(preview.objectUrl);
          return;
        }
        replacePreview(preview);
        get().setRightTab(isHtmlArtifact(preview.name) ? "web" : "files");
      })().catch((error) => {
        if (!isCurrent()) return;
        const reason = error instanceof Error ? error.message : String(error);
        get().showNotice(`无法打开链接：${reason}`);
      });
      return true;
    },

    workspaceImports: [],

    importsStatus: "idle",

    activeDrawing: null,

    loadWorkspaceImports: async () => {
      const projectPath = effectiveWorkspacePath(get());
      if (!projectPath) {
        set({ workspaceImports: [], importsStatus: "ready", activeDrawing: null });
        return;
      }
      set({ importsStatus: "loading" });
      try {
        const entries = await listWorkspaceDir(projectPath, DRAWINGS_DIR);
        set((state) => ({
          workspaceImports: entries,
          importsStatus: "ready",
          // 选中的那张已被删掉时同步取消选中，避免预览到不存在的文件
          activeDrawing: entries.some(
            (item) => drawingEntryKey("import", item.name) === state.activeDrawing,
          )
            ? state.activeDrawing
            : null,
        }));
      } catch {
        // 还没导入过时目录并不存在，这不是错误：按空列表处理，不向用户报错
        set({ workspaceImports: [], importsStatus: "ready", activeDrawing: null });
      }
    },

    selectDrawing: (key) => set({ activeDrawing: key })
  };
};
