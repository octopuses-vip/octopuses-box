/** 桌面适配层：files。运行环境差异在此处理，界面只调用公开函数。 */
import { type DirEntryInfo } from "../types";
import { decodeBase64 } from "./encoding";
import { requireDesktopWorkspace } from "./workspace";

/* ============================ 文件搬运与二进制读取 ============================ */

/**
 * 一个文件所在的位置，与后端 `fileops::FileLocation` 同构。
 *
 * 导入、导出、预览三条链路都要先回答「文件在哪」，因此集中在这里定义一次：
 * 工作区相对路径、产物目录（项目 `output/` 或缓存 `outputs/<日期>/`）下的产物、本机绝对路径。
 * 上层只描述来源，底层的路径校验与读写口径统一由 `fileops` 一处把关。
 */
export type FileLocation =
  | { kind: "workspace"; projectPath: string; path: string }
  | { kind: "artifact"; dir: string; name: string }
  | { kind: "absolute"; path: string };

/** 一次导入的结果；整批导入时逐项返回，`ok` 为 false 时 `error` 是可读原因 */
export interface ImportOutcome {
  /** 导入前的本机绝对路径 */
  source: string;
  /** 导入后相对工作区的路径；失败时空串 */
  path: string;
  bytes: number;
  ok: boolean;
  error: string;
}

/** 一次另存为的结果 */
export interface FileTransferResult {
  path: string;
  bytes: number;
}

/**
 * 把一批本机文件复制进工作区的指定子目录。
 *
 * 逐项返回结果：某个文件不合格（不存在、非文件、超限、重名过多）只影响它自己，
 * 其余照常导入——用户一次拖进来十个文件，不该因为其中一个坏了就全丢。
 */
export async function importWorkspaceFiles(
  projectPath: string,
  destDir: string,
  sources: string[],
): Promise<ImportOutcome[]> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ImportOutcome[]>("workspace_import_files", { projectPath, destDir, sources });
}

/** 把一个文件另存到用户选定的绝对路径；是否覆盖由系统「另存为」对话框把关 */
export async function transferFile(
  source: FileLocation,
  targetPath: string,
): Promise<FileTransferResult> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FileTransferResult>("file_save_as", { source, targetPath });
}

/**
 * 读取一个文件的原始字节。
 *
 * 二进制文件（STEP / IGES 图纸、图片）没法走 `readWorkspaceFile` 的文本通道，
 * 统一从这条 base64 通道取，前端解出 `Uint8Array` 即可交给 WASM 解析或包成 Blob。
 */
export async function readFileBytes(source: FileLocation): Promise<Uint8Array<ArrayBuffer>> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return decodeBase64(await invoke<string>("file_read_bytes", { source }));
}

export type ContextPathData =
  | { kind: "file"; name: string; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "folder"; entries: string[]; truncated: boolean };

/** 用户主动附加的本机文件或目录：原生限长读取，兼容 Windows 路径和用户主目录。 */
export async function readContextPath(path: string, base: string | null, maxFileMb?: number): Promise<ContextPathData> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<
    { kind: "file"; name: string; encoded: string } | { kind: "folder"; entries: string[]; truncated: boolean }
  >("context_read_path", { path, base, ...(maxFileMb === undefined ? {} : { maxFileMb }) });
  return result.kind === "file"
    ? { kind: "file", name: result.name, bytes: decodeBase64(result.encoded) }
    : result;
}

/** 列出工作区某个目录下的文件（按最后写入时间倒序）；目录不存在时返回空数组 */
export async function listWorkspaceDir(projectPath: string, path: string): Promise<DirEntryInfo[]> {
  requireDesktopWorkspace();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DirEntryInfo[]>("workspace_list_dir", { projectPath, path });
}
