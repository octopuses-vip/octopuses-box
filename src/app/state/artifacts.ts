/** 状态辅助层：artifacts。不依赖 Store 实例，调用方显式传入上下文。 */
import { isDrawingFile } from "../../model/drawings";
import { isStandaloneThread } from "../../project/projects";
import { isHtmlArtifact } from "../../tools/writeFile";
import { type FileLocation } from "../desktop/files";
import { type LoadStatus, type AppStore } from "../storeTypes";
import {
  type ArtifactInfo,
  type DiffFile,
  type SourceItem,
  type RightTab,
  type DirEntryInfo,
  type Message,
} from "../types";
import { effectiveWorkspacePath } from "./workspace";

/**
 * 右栏顶栏当前应显示的 tab（数组顺序即顶栏顺序）。
 *
 * 顶栏不做全量展示：某个 tab 没有真实内容就不出现——「差异」要有 diff、「来源」要有检索结果、
 * 「图片」要有图片产物、「3D」要有图纸；全部为空时右栏自动收起（见 RightPanel）。
 *
 * 「文件」与「网页」是例外（开发者 Jan）：只要当前会话能定位到产物目录就保留这两个 tab，
 * 目录空着也在空态里显示目录的绝对路径。否则老会话的产物一旦不在预期目录里，tab 会凭空消失，
 * 用户既看不到「去哪儿找文件」，也没有任何入口能重新打开——这正是旧产物迁移前踩到的坑。
 *
 * 差异 tab 只要读过一次（`gitDiffStatus` 不为 idle）就保留：差异是项目级的，项目干净时
 * 也该能看到「没有未提交的改动」这个结论，而不是 tab 直接消失。
 */
export function rightPanelTabs(
  artifacts: ArtifactInfo[],
  diffFiles: DiffFile[],
  sources: SourceItem[],
  gitDiffStatus: LoadStatus,
  unresolvedReviewCount = 0,
  hasDrawings = false,
  hasArtifactDir = false,
  previewName?: string,
): RightTab[] {
  const tabs: RightTab[] = [];
  if (artifacts.length > 0 || hasArtifactDir || previewName) tabs.push("files");
  if (artifacts.some((artifact) => isHtmlArtifact(artifact.name)) || hasArtifactDir ||
    (previewName && isHtmlArtifact(previewName))) tabs.push("web");
  if (artifacts.some((artifact) => artifact.kind === "image" || artifact.kind === "video")) tabs.push("media");
  if (hasDrawings) tabs.push("model");
  if (diffFiles.length > 0 || gitDiffStatus !== "idle") tabs.push("diff");
  if (unresolvedReviewCount > 0) tabs.push("review");
  if (sources.length > 0) tabs.push("sources");
  return tabs;
}

/** 释放产物预览用的 blob 地址；非 blob（或空）直接跳过 */
export function revokeObjectUrl(url: string | null | undefined): void {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * 会话内是否存在可预览的图纸（开发者 Jan）。
 *
 * 「3D」tab 的资料来自两处：模型写出的图纸产物与 `imports/` 下的导入图纸。
 * 两处用同一套扩展名判断（见 `drawings.ts` 注册表），因此判定集中在这里，
 * 顶栏与面板各自调用，避免两处口径不一致导致 tab 该出现却没出现。
 */
export function hasDrawingFiles(
  artifacts: ArtifactInfo[],
  workspaceImports: DirEntryInfo[],
): boolean {
  return (
    artifacts.some((item) => isDrawingFile(item.name)) ||
    workspaceImports.some((item) => isDrawingFile(item.name))
  );
}

/** 项目会话的产物目录名：固定落在工作区根下的 `output/` */
export const PROJECT_OUTPUT_DIR = "output";

/** 独立会话的产物子目录名：缓存根下的 `outputs/<日期>/`，按天分一层 */
export const TEMP_OUTPUT_DIR = "outputs";

/** 把 Unix 秒转成本地日期 `YYYY-MM-DD`，用于独立会话产物按天分目录 */
export function artifactDateKey(seconds: number): string {
  const date = new Date((Number.isFinite(seconds) && seconds > 0 ? seconds : Date.now() / 1000) * 1000);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 取一条会话的产物落盘目录（开发者 Jan）。
 *
 * 规则只有两条：**在项目里生成的文件进项目目录的 `output/`，独立（临时）会话的产物进缓存区的
 * `outputs/<日期>/`。** 判据是会话有没有项目归属，而不是它有没有工作目录——独立会话即便用户
 * 自选了目录，产物也不该混进用户自己的仓库。
 *
 * 独立会话的日期取**会话创建日**而不是当天：跨天再打开旧会话时，右栏仍指向同一层目录，
 * 否则上一次的产物会从列表里消失。项目会话的 `output/` 由 `prepareArtifactDir` 首次创建时
 * 顺带写进项目 `.gitignore`，产物不该进版本库。
 */
export function effectiveArtifactDir(
  state: Pick<AppStore, "threads" | "projects" | "cachePath" | "activeThreadId">,
  threadId = state.activeThreadId,
): string | null {
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return null;
  if (isStandaloneThread(thread)) {
    if (!state.cachePath) return null;
    return `${state.cachePath}/${TEMP_OUTPUT_DIR}/${artifactDateKey(thread.createdAt)}`;
  }
  const workspacePath = effectiveWorkspacePath(state, threadId);
  if (!workspacePath) return null;
  return `${workspacePath}/${PROJECT_OUTPUT_DIR}`;
}

/**
 * 项目会话产物目录对应的 `.gitignore` 位置与应补的条目（开发者 Jan）。
 *
 * 独立会话的产物在缓存区，本就不在任何仓库里，因此返回 `null`，调用侧不写 gitignore。
 */
export function artifactGitignoreEntry(
  state: Pick<AppStore, "threads" | "projects" | "cachePath" | "activeThreadId">,
  threadId = state.activeThreadId,
): { file: string; entry: string } | null {
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread || isStandaloneThread(thread)) return null;
  const workspacePath = effectiveWorkspacePath(state, threadId);
  if (!workspacePath) return null;
  return { file: `${workspacePath}/.gitignore`, entry: `${PROJECT_OUTPUT_DIR}/` };
}

/** 本地链接只由应用预览，避免把文件协议交给 WebView 导航。 */
export const LOCAL_FILE_LINK = /^(?:file|sandbox):/i;

/** 判断 Markdown 链接是否应由文件预览接管。 */
export function isMarkdownFileLink(href: string): boolean {
  const value = href.trim();
  return LOCAL_FILE_LINK.test(value) ||
    Boolean(value && !value.startsWith("#") && !value.startsWith("//") &&
      (!/^[a-z][a-z\d+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value)));
}

/** 解析已列出的产物和当前工作区内的文件链接。 */
export function resolveMarkdownLinkTarget(
  href: string,
  context: {
    artifacts: ArtifactInfo[];
    workspacePath: string | null;
    artifactDir: string | null;
  },
): FileLocation | null {
  const trimmed = href.trim();
  if (!isMarkdownFileLink(trimmed)) return null;
  // URL 参数和锚点不属于路径。先分离，再解码，保留文件名中的 %23 或 %3F。
  const rawPath = trimmed.split(/[?#]/, 1)[0];
  let path: string;
  try {
    path = decodeURIComponent(rawPath).replaceAll("\\", "/");
  } catch {
    return null;
  }
  if (!path || path.includes("\0") || path.split("/").includes("..")) return null;

  const sandbox = /^sandbox:\/mnt\/data\//i.test(path);
  if (sandbox) {
    path = path.slice("sandbox:/mnt/data/".length);
  } else if (/^file:/i.test(path)) {
    const localPath = /^file:\/\/(?:localhost)?(\/[^/].*)$/i.exec(path)?.[1];
    if (!localPath) return null;
    path = localPath.replace(/^\/(?=[a-z]:\/)/i, "");
  }
  if (path.startsWith("//") || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path))) return null;

  const absolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
  const relative = path.replace(/^(?:\.\/)+/, "");
  const artifactRoot = context.artifactDir?.replaceAll("\\", "/").replace(/\/+$/, "");
  const artifactName = absolute
    ? artifactRoot && path.startsWith(`${artifactRoot}/`)
      ? path.slice(artifactRoot.length + 1)
      : null
    : relative.replace(/^output\//, "");
  if (context.artifactDir && artifactName && !artifactName.includes("/") &&
      context.artifacts.some((item) => item.name === artifactName)) {
    return { kind: "artifact", dir: context.artifactDir, name: artifactName };
  }
  if (!context.workspacePath || sandbox || !relative || relative === "." || relative.endsWith("/")) return null;
  const workspaceRoot = context.workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const workspaceRelative = absolute
    ? path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length + 1) : ""
    : relative;
  return workspaceRelative
    ? { kind: "workspace", projectPath: context.workspacePath, path: workspaceRelative }
    : null;
}

/**
 * 从工具调用参数里取出产物文件名（开发者 Jan）。
 *
 * `arguments` 是协议层的 JSON 原文，旧会话可能整体缺失或不是合法 JSON；
 * 取不到就按「认不出归属」处理，不能因为一条坏记录中断整次迁移。
 */
export function artifactNameFromCall(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const name = (parsed as Record<string, unknown>).name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 还原旧产物的会话归属：文件名 → 会话 id（开发者 Jan）。
 *
 * 产物目录按会话定位之前，所有会话共用 `<缓存>/artifacts/`，文件本身不带归属信息；
 * 唯一线索是消息里的工具片段——成功写出产物的那几次调用（`write_artifact` / `image_gen`）
 * 的 `arguments.name` 就是文件名。判据与运行期的 `hasProducedArtifact` 同源，两处必须一致。
 *
 * 遍历顺序是「新会话在前」（`restoreSessions` 按创建时间倒序建表），同名只认第一次命中：
 * 磁盘上留下的是最近一次写出的那份，归属就该属于最近写出它的会话。
 */
export function artifactOwnersOf(messages: Record<string, Message[]>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [threadId, threadMessages] of Object.entries(messages)) {
    for (const message of threadMessages) {
      for (const item of message.items) {
        if (item.type !== "tool_call") continue;
        if (item.kind !== "write_artifact" && item.kind !== "image_gen") continue;
        if (item.status !== "success") continue;
        const name = artifactNameFromCall(item.arguments);
        if (name && !owners.has(name)) owners.set(name, threadId);
      }
    }
  }
  return owners;
}
