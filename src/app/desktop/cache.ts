/** 桌面适配层：cache。运行环境差异在此处理，界面只调用公开函数。 */
import { currentPlatform } from "../platform";
import { isDesktopRuntime } from "./runtime";

/* ============================ 缓存路径 ============================ */

export interface CacheSubdirInfo {
  name: string;
  fileCount: number;
  bytes: number;
}

export interface CacheInfo {
  path: string;
  exists: boolean;
  totalBytes: number;
  totalFiles: number;
  /** manifest 中记录的创建时间（Unix 秒），未初始化时为 null */
  createdAt: number | null;
  subdirs: CacheSubdirInfo[];
}

/** 缓存目录的固定子目录与用途说明，与后端 cache.rs 的 SUBDIRS 保持一致 */
export const CACHE_SUBDIRS: { name: string; label: string }[] = [
  { name: "temp", label: "运行时临时文件，可在设置页一键清空" },
  { name: "logs", label: "运行日志与终端输出" },
  { name: "sessions", label: "旧版会话记录文件（已由根目录 octopuses.db 数据库取代）" },
  { name: "outputs", label: "临时会话写出的产物（按天分目录，供右栏预览；项目会话的产物在项目目录 output/ 下）" },
  { name: "snapshots", label: "每轮运行的差异与来源快照（内部缓存，不参与产物列表）" },
];

/**
 * 浏览器演示环境下的占位默认路径（桌面端由后端返回用户主目录下的 octopuses）。
 *
 * 按探测平台生成，避免在 Windows / Linux 的浏览器演示环境里显示错误风格的路径而误导用户。
 */
export function browserDefaultCacheDir(): string {
  switch (currentPlatform()) {
    case "windows":
      return "C:\\Users\\<用户名>\\octopuses";
    case "linux":
      return "~/octopuses";
    default:
      // macOS 与无法识别的平台沿用 Unix 风格路径
      return "~/octopuses";
  }
}

/** 浏览器演示环境的模拟缓存：key 为「缓存根目录/相对路径」 */
export const memoryCache = new Map<string, string>();

/** 浏览器环境产物的写入时间（key 同 memoryCache），用于产物列表排序 */
export const memoryArtifactTime = new Map<string, number>();

/**
 * 浏览器演示环境的二进制产物（base64 内容，key 同 memoryCache）。
 *
 * 不镜像进 localStorage：图像 base64 体积大，写进浏览器配额容易直接失败，
 * 而浏览器演示环境本就不是真实落盘，会话内可预览即可。
 */
export const memoryBinary = new Map<string, string>();

export let memoryCreatedAt: number | null = null;

/** 浏览器演示环境最近一次登记的缓存根目录，仅用于镜像里保留展示用路径 */
export let memoryRoot = "";

/**
 * 浏览器演示环境下把内存缓存镜像到 localStorage 的键。
 *
 * 桌面端缓存落在真实文件系统上，刷新/重启都能读回；浏览器演示环境如果只用内存 Map，
 * 一刷新会话就全丢了，与桌面端行为不一致——因此这里整体镜像一份，保证 `pnpm dev` 下同样可读回。
 */
export const BROWSER_CACHE_KEY = "octopuses:browser-cache";

/**
 * 把当前内存缓存镜像到 localStorage（开发者 Jan）。
 *
 * key 一律是「绝对目录/文件名」：产物目录已不再固定于缓存根（项目会话落在项目 `output/`），
 * 按缓存根前缀过滤会漏掉项目产物，因此这里原样镜像完整 key。
 */
export function saveBrowserCache(): void {
  const files: Record<string, string> = {};
  for (const [key, value] of memoryCache) files[key] = value;
  const times: Record<string, number> = {};
  for (const [key, value] of memoryArtifactTime) times[key] = value;
  try {
    localStorage.setItem(
      BROWSER_CACHE_KEY,
      JSON.stringify({ root: memoryRoot, createdAt: memoryCreatedAt, files, times }),
    );
  } catch {
    // localStorage 不可用（隐私模式、配额耗尽）时退化为纯内存，不影响界面使用
  }
}

/** 启动时把上一次镜像的缓存读回内存 */
export function loadBrowserCache(): void {
  try {
    const body = localStorage.getItem(BROWSER_CACHE_KEY);
    if (!body) return;
    const parsed = JSON.parse(body) as {
      root?: string;
      createdAt?: number | null;
      files?: Record<string, string>;
      times?: Record<string, number>;
    };
    if (typeof parsed.root !== "string" || !parsed.files) return;
    memoryRoot = parsed.root;
    for (const [key, value] of Object.entries(parsed.files)) {
      memoryCache.set(key, value);
    }
    for (const [key, value] of Object.entries(parsed.times ?? {})) {
      memoryArtifactTime.set(key, value);
    }
    memoryCreatedAt = parsed.createdAt ?? null;
  } catch {
    // 镜像损坏时忽略，按空缓存启动
  }
}

loadBrowserCache();

/** 汇总浏览器演示环境的内存缓存用量（开发者 Jan）：按固定子目录分别统计文件数与字节数，形状与桌面端 cache_info 对齐 */
export function memoryInfo(path: string): CacheInfo {
  let totalFiles = 0;
  let totalBytes = 0;
  const subdirs = CACHE_SUBDIRS.map(({ name }) => {
    let fileCount = 0;
    let bytes = 0;
    for (const [key, value] of memoryCache) {
      if (!key.startsWith(`${path}/${name}/`)) continue;
      fileCount += 1;
      bytes += value.length;
    }
    totalFiles += fileCount;
    totalBytes += bytes;
    return { name, fileCount, bytes };
  });
  return {
    path,
    exists: true,
    totalBytes,
    totalFiles,
    createdAt: memoryCreatedAt,
    subdirs,
  };
}

/** 默认缓存路径：`~/octopuses`（桌面端由后端返回用户主目录） */
export async function defaultCacheDir(): Promise<string> {
  if (!isDesktopRuntime()) return browserDefaultCacheDir();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("cache_default_dir");
}

/** 创建/确认缓存目录，返回目录信息；失败时抛出后端返回的错误信息 */
export async function initCacheDir(path: string): Promise<CacheInfo> {
  if (!isDesktopRuntime()) {
    memoryCreatedAt = memoryCreatedAt ?? Math.floor(Date.now() / 1000);
    memoryRoot = path;
    saveBrowserCache();
    return memoryInfo(path);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CacheInfo>("cache_init", { path });
}

/** 读取缓存目录的占用与子目录统计 */
export async function readCacheInfo(path: string): Promise<CacheInfo> {
  if (!isDesktopRuntime()) return memoryInfo(path);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CacheInfo>("cache_info", { path });
}

/** 覆盖写入缓存文件（relative 为相对缓存根目录的路径） */
export async function writeCacheFile(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime()) {
    memoryCache.set(`${root}/${relative}`, contents);
    saveBrowserCache();
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cache_write", { path: root, relative, contents });
}

/** 追加写入缓存文件（用于日志） */
export async function appendCacheFile(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  if (!isDesktopRuntime()) {
    const key = `${root}/${relative}`;
    memoryCache.set(key, `${memoryCache.get(key) ?? ""}${contents}`);
    saveBrowserCache();
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cache_append", { path: root, relative, contents });
}

/** 读取缓存文件（relative 为相对缓存根目录的路径）；文件不存在或读取失败时返回 null */
export async function readCacheFile(root: string, relative: string): Promise<string | null> {
  if (!isDesktopRuntime()) {
    return memoryCache.get(`${root}/${relative}`) ?? null;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("cache_read", { path: root, relative });
  } catch {
    // 首次启动时文件尚不存在，属于正常情况，交由调用方回落到默认状态
    return null;
  }
}

/** 清空缓存内容：`temp` 只清临时文件，`all` 清空全部子目录 */
export async function clearCache(root: string, scope: "temp" | "all"): Promise<CacheInfo> {
  if (!isDesktopRuntime()) {
    const names = scope === "temp" ? ["temp"] : CACHE_SUBDIRS.map((item) => item.name);
    for (const key of [...memoryCache.keys(), ...memoryBinary.keys()]) {
      if (names.some((name) => key.startsWith(`${root}/${name}/`))) {
        memoryCache.delete(key);
        memoryBinary.delete(key);
        memoryArtifactTime.delete(key);
      }
    }
    saveBrowserCache();
    return memoryInfo(root);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CacheInfo>("cache_clear", { path: root, scope });
}
