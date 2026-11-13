/** artifacts 状态与动作。跨域操作经 get() 访问完整契约。 */
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
import { readFileBytes, listWorkspaceDir } from "../../desktop/files";
import { readWorkspaceFile } from "../../desktop/workspace";
import {
  effectiveArtifactDir,
  revokeObjectUrl,
  artifactOwnersOf,
  TEMP_OUTPUT_DIR,
  artifactDateKey,
} from "../artifacts";
import { effectiveWorkspacePath } from "../workspace";

export const createArtifactsSlice: StoreSlice<
  | "artifacts"
  | "artifactStatus"
  | "artifactError"
  | "activeArtifact"
  | "legacyMigrationDone"
  | "loadArtifacts"
  | "migrateLegacyArtifacts"
  | "selectArtifact"
  | "openFileLocation"
  | "workspaceImports"
  | "importsStatus"
  | "activeDrawing"
  | "loadWorkspaceImports"
  | "selectDrawing"
> = (set, get) => ({
  artifacts: [],

  artifactStatus: "idle",

  artifactError: null,

  activeArtifact: null,

  legacyMigrationDone: false,

  loadArtifacts: async () => {
    const dir = effectiveArtifactDir(get());
    if (!dir) {
      // 还没有可用的产物目录（未选缓存目录 / 项目会话没有工作目录）：直接回到空态，
      // 不去读上一个会话的目录，否则右栏会串会话
      set({
        artifacts: [],
        artifactStatus: "idle",
        artifactError: null,
        activeArtifact: null,
      });
      return;
    }
    set({ artifactStatus: "loading", artifactError: null });
    try {
      const artifacts = await listArtifacts(dir);
      set((state) => {
        // 选中的产物已被清空时同步取消选中，避免预览到不存在的文件
        const stillExists =
          state.activeArtifact !== null &&
          artifacts.some((item) => item.name === state.activeArtifact?.name);
        if (!stillExists) revokeObjectUrl(state.activeArtifact?.objectUrl);
        return {
          artifacts,
          artifactStatus: "ready",
          activeArtifact: stillExists ? state.activeArtifact : null,
        };
      });
    } catch (error) {
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
    // 切换前先释放上一张预览的 blob，避免反复切换产物时内存只增不减
    revokeObjectUrl(get().activeArtifact?.objectUrl);
    if (!name) {
      set({ activeArtifact: null });
      return;
    }
    const meta = get().artifacts.find((item) => item.name === name);
    const kind = meta?.kind ?? artifactKind(name);
    const dir = effectiveArtifactDir(get());
    if (!dir) {
      set({
        activeArtifact: null,
        artifactError: "尚未确定产物目录，无法读取产物。",
      });
      return;
    }
    try {
      if (kind === "image" || kind === "pdf") {
        // 图片与 PDF 走字节通道：读成文本必失败，且要包成 Blob 才能交给 img / iframe
        const bytes = await readArtifactBytes(dir, name);
        const objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: artifactMime(name) }),
        );
        set({
          activeArtifact: {
            name,
            kind,
            bytes: meta?.bytes ?? bytes.length,
            modifiedAt: meta?.modifiedAt ?? 0,
            content: "",
            objectUrl,
          },
          artifactError: null,
        });
        return;
      }
      if (kind === "binary") {
        // 未知二进制没有渲染方式，只保留元信息，由预览面板给出说明
        set({
          activeArtifact: {
            name,
            kind,
            bytes: meta?.bytes ?? 0,
            modifiedAt: meta?.modifiedAt ?? 0,
            content: "",
            objectUrl: null,
          },
          artifactError: null,
        });
        return;
      }
      const content = await readArtifact(dir, name);
      set({
        activeArtifact: {
          name,
          kind,
          bytes: meta?.bytes ?? new TextEncoder().encode(content).length,
          modifiedAt: meta?.modifiedAt ?? 0,
          content,
          objectUrl: null,
        },
        artifactError: null,
      });
    } catch (error) {
      set({
        activeArtifact: null,
        artifactError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
         * 打开一个应用内文件位置（开发者 Jan）：Markdown 相对链接导航的落点。
         *
         * 产物位置复用 `selectArtifact`（同一目录、同一读取通道）；工作区位置按扩展名分流——
         * 图片 / PDF 走 `file_read_bytes` 字节通道包成 Blob，文本走 `workspace_read_file`，
         * 与产物预览的出参形状对齐，渲染层无感。读取失败给出可读错误，不静默吞掉。
         */
  openFileLocation: async (target) => {
    if (target.kind === "artifact") {
      await get().selectArtifact(target.name);
      return;
    }
    if (target.kind !== "workspace") return;
    revokeObjectUrl(get().activeArtifact?.objectUrl);
    const name = target.path.split("/").pop() ?? target.path;
    const kind = artifactKind(name);
    set({ artifactStatus: "ready" });
    try {
      if (kind === "image" || kind === "pdf") {
        const bytes = await readFileBytes(target);
        set({
          activeArtifact: {
            name,
            kind,
            bytes: bytes.length,
            modifiedAt: 0,
            content: "",
            objectUrl: URL.createObjectURL(new Blob([bytes], { type: artifactMime(name) })),
          },
          artifactError: null,
        });
        return;
      }
      if (kind === "binary") {
        set({
          activeArtifact: { name, kind, bytes: 0, modifiedAt: 0, content: "", objectUrl: null },
          artifactError: null,
        });
        return;
      }
      const content = await readWorkspaceFile(target.projectPath, target.path);
      set({
        activeArtifact: {
          name,
          kind,
          bytes: new TextEncoder().encode(content).length,
          modifiedAt: 0,
          content,
          objectUrl: null,
        },
        artifactError: null,
      });
    } catch (error) {
      set({
        activeArtifact: null,
        artifactError: error instanceof Error ? error.message : String(error),
      });
    }
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
});
