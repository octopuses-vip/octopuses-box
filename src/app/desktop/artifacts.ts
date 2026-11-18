/** 桌面适配层：artifacts。运行环境差异在此处理，界面只调用公开函数。 */
import { type ArtifactKind, type ArtifactInfo } from "../types";
import { memoryCache, memoryArtifactTime, saveBrowserCache, memoryBinary } from "./cache";
import { base64ByteLength, decodeBase64 } from "./encoding";
import { isDesktopRuntime } from "./runtime";

/* ============================ 产物文件 ============================ */

/**
 * 由产物扩展名派生种类，与后端 `artifact_kind` 同一套映射。
 *
 * 浏览器演示环境没有后端可问，产物列表只能在前端算；扩展名映射因此必须两端对齐。
 */
export function artifactKind(name: string): ArtifactKind {
  const extension = name.trim().toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(extension)) {
    return "image";
  }
  if (extension === "mp4") return "video";
  if (extension === "pdf") return "pdf";
  if (
    [
      "html",
      "htm",
      "css",
      "js",
      "mjs",
      "ts",
      "tsx",
      "jsx",
      "json",
      "md",
      "txt",
      "csv",
      "xml",
      "yml",
      "yaml",
      "log",
    ].includes(extension)
  ) {
    return "text";
  }
  return "binary";
}

/** 产物扩展名 → MIME，用于把二进制产物包成 Blob 交给 `<img>` / `<iframe>` 预览 */
export function artifactMime(name: string): string {
  const extension = name.trim().toLowerCase().split(".").pop() ?? "";
  switch (extension) {
    case "mp4":
      return "video/mp4";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/** 校验产物文件名：只允许单个文件名（无路径分隔符、非隐藏文件），与后端 artifact_name 保持一致 */
export function artifactFileName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new Error("产物文件名不能为空。");
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`产物文件名不合法（只允许文件名，不允许路径）：${name}`);
  }
  return name;
}

/**
 * 准备产物目录：建目录，并按需在项目 `.gitignore` 里补一行忽略规则（开发者 Jan）。
 *
 * 项目会话首次写产物时调用，避免产物被误提交进版本库；临时会话的目录在缓存区，不需要 gitignore。
 */
export async function prepareArtifactDir(
  dir: string | null,
  gitignore?: string,
  entry?: string,
): Promise<void> {
  if (!dir) throw new Error("尚未确定产物目录，无法创建。");
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("artifact_prepare_dir", { dir, gitignore: gitignore ?? null, entry: entry ?? null });
}

/** 写入一个产物文件（落在给定产物目录下），返回写入字节数 */
export async function writeArtifact(
  dir: string | null,
  name: string,
  content: string,
): Promise<number> {
  if (!dir) throw new Error("尚未确定产物目录，无法写入产物。");
  const fileName = artifactFileName(name);
  if (!isDesktopRuntime()) {
    const key = `${dir}/${fileName}`;
    memoryCache.set(key, content);
    memoryArtifactTime.set(key, Math.floor(Date.now() / 1000));
    saveBrowserCache();
    return new TextEncoder().encode(content).length;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const info = await invoke<{ path: string; bytes: number }>("artifact_write", {
    dir,
    name: fileName,
    contents: content,
  });
  return info.bytes;
}

/** 读取一个产物文件的文本内容 */
export async function readArtifact(dir: string | null, name: string): Promise<string> {
  if (!dir) throw new Error("尚未确定产物目录，无法读取产物。");
  const fileName = artifactFileName(name);
  if (!isDesktopRuntime()) {
    const value = memoryCache.get(`${dir}/${fileName}`);
    if (value === undefined) throw new Error(`产物不存在：${fileName}`);
    return value;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("artifact_read", { dir, name: fileName });
}

/**
 * 写入一个二进制产物（图片等）。
 *
 * 入参直接是图像接口返回的 base64 内容：前端不必解码再编码，后端解一次即落盘。
 */
export async function writeArtifactBytes(
  dir: string | null,
  name: string,
  base64: string,
): Promise<number> {
  if (!dir) throw new Error("尚未确定产物目录，无法写入产物。");
  const fileName = artifactFileName(name);
  if (!isDesktopRuntime()) {
    const key = `${dir}/${fileName}`;
    memoryBinary.set(key, base64);
    memoryArtifactTime.set(key, Math.floor(Date.now() / 1000));
    return base64ByteLength(base64);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const info = await invoke<{ path: string; bytes: number }>("artifact_write_bytes", {
    dir,
    name: fileName,
    data: base64,
  });
  return info.bytes;
}

/** 读取一个二进制产物的原始字节（图片 / PDF 预览用，文本产物仍走 readArtifact） */
export async function readArtifactBytes(
  dir: string | null,
  name: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!dir) throw new Error("尚未确定产物目录，无法读取产物。");
  const fileName = artifactFileName(name);
  if (!isDesktopRuntime()) {
    const value = memoryBinary.get(`${dir}/${fileName}`);
    if (value === undefined) throw new Error(`产物不存在：${fileName}`);
    return decodeBase64(value);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const encoded = await invoke<string>("artifact_read_bytes", { dir, name: fileName });
  return decodeBase64(encoded);
}

/** 列出产物目录下的全部产物文件（按写入时间倒序）；目录不存在时返回空列表 */
export async function listArtifacts(dir: string | null): Promise<ArtifactInfo[]> {
  if (!dir) return [];
  if (!isDesktopRuntime()) {
    const prefix = `${dir}/`;
    const out: ArtifactInfo[] = [];
    for (const [key, value] of memoryCache) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (name.includes("/")) continue; // 产物只平铺一层
      out.push({
        name,
        bytes: new TextEncoder().encode(value).length,
        modifiedAt: memoryArtifactTime.get(key) ?? 0,
        kind: artifactKind(name),
      });
    }
    for (const [key, value] of memoryBinary) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (name.includes("/")) continue;
      out.push({
        name,
        bytes: base64ByteLength(value),
        modifiedAt: memoryArtifactTime.get(key) ?? 0,
        kind: artifactKind(name),
      });
    }
    return out.sort((left, right) => right.modifiedAt - left.modifiedAt);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ArtifactInfo[]>("artifact_list", { dir });
}

/** 旧版共享产物目录名：与 Rust 侧 `LEGACY_ARTIFACTS_DIR` 一致，只用于一次性迁移 */
export const LEGACY_ARTIFACTS_DIR = "artifacts";

/** 一条旧产物的迁移目标（开发者 Jan）：文件名 + 它应归属的会话产物目录 */
export interface LegacyArtifactTarget {
  name: string;
  dir: string;
}

/** 旧产物迁移结果 */
export interface LegacyMigrationResult {
  moved: number;
  skipped: number;
}

/** 列出旧版共享产物目录 `<缓存>/artifacts/` 下的历史产物；目录不存在时为空 */
export async function listLegacyArtifacts(cachePath: string | null): Promise<ArtifactInfo[]> {
  if (!cachePath || !isDesktopRuntime()) return [];
  return listArtifacts(`${cachePath}/${LEGACY_ARTIFACTS_DIR}`);
}

/**
 * 把旧版共享产物目录里的历史产物搬回各自会话的产物目录（开发者 Jan）。
 *
 * 归属由调用方算：项目路径只存在界面侧的持久化里，库里没有，后端只按「文件名 → 目标目录」搬。
 * 认不出归属、目标已有同名文件、目标目录不合法的一律原样留在旧目录，不覆盖也不删。
 */
export async function migrateLegacyArtifacts(
  cachePath: string | null,
  targets: LegacyArtifactTarget[],
): Promise<LegacyMigrationResult> {
  if (!cachePath || targets.length === 0 || !isDesktopRuntime()) return { moved: 0, skipped: 0 };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LegacyMigrationResult>("artifact_migrate_legacy", { cacheDir: cachePath, targets });
}
