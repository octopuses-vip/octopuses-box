/**
 * 统一拖放路由（开发者 Jan）。
 *
 * 桌面端（Tauri）默认开启原生拖放，网页层收不到 HTML5 的 drop 事件，此前输入框上挂的
 * 拖拽附件在 Windows 桌面端其实是失效的。这里把两条通道归一化成同一种「被拖入的文件」，
 * 再按一次判断分流：
 *   - 图纸（STEP / IGES / DWG）→ 交给导入链路，复制进会话工作目录 `imports/`
 *   - 其余文件 → 还原成 `File` 交给输入框当附件
 * 分流只在这里做一次，各组件不再各自解析拖放内容。
 */

import { isDesktopRuntime } from "./desktop/runtime";
import { readFileBytes } from "./desktop/files";
import { fileNameFromPath, isDrawingFile } from "../model/drawings";
import { importDrawings } from "../model/drawingImport";
import { mimeFromName } from "../model/attachments";
import type { AttachmentBatch } from "../model/attachmentDraft";

/**
 * 一次拖入里的单个文件。
 *
 * 两种运行环境的产物不同，因此两个字段互补：桌面端原生拖放只给本机绝对路径，
 * 浏览器给 `File` 对象。上层按哪个有值决定怎么取内容。
 */
export interface DroppedFile {
  name: string;
  /** 本机绝对路径；浏览器环境为 null */
  path: string | null;
  /** 浏览器环境拿到的文件对象；桌面端为 null */
  file: File | null;
}

/** 附件接收方：先接收本批读取任务，再等待读取结果，保证拖放时即绑定所属会话。 */
export type DropSink = (batch: Promise<AttachmentBatch>) => void;

/** 已注册的接收方；组件挂载时注册、卸载时注销 */
const sinks = new Set<DropSink>();

/** 注册附件接收方，返回注销函数（可直接作为 `useEffect` 的清理函数） */
export function subscribeDropSink(sink: DropSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * 把文件派发给所有接收方；没有接收方时静默丢弃（此时输入框不在界面上）。
 *
 * 失败项也在批次结果中交给输入框显示，不能静默丢弃。
 */
function emitFiles(batch: Promise<AttachmentBatch>): void {
  for (const sink of [...sinks]) sink(batch);
}

/**
 * 把「只有路径」的文件还原成 `File`。
 *
 * 桌面端拖放给的是路径，而附件管线吃的是 `File`，因此读回字节再包一层。
 * 读取失败（文件已被删掉、拖进来的是个文件夹等）返回 null，由调用方跳过该项，
 * 不影响同批其它文件。
 *
 * 类型必须显式补上（开发者 Jan）：`file.type` 是附件分流（图片 / 文本）的唯一依据，
 * 而原生拖放只给了路径。不补的话拖进来的 PNG 会以「未知类型」被拒——它本是被支持的。
 * 浏览器端由系统给 File 带好 MIME，这里按扩展名补齐两条通道的差异。
 */
async function restoreFile(item: DroppedFile): Promise<File | null> {
  if (!item.path) return null;
  try {
    const bytes = await readFileBytes({ kind: "absolute", path: item.path });
    return new File([bytes], item.name, { type: mimeFromName(item.name) });
  } catch {
    return null;
  }
}

/**
 * 分流一批被拖入的文件（开发者 Jan）。
 *
 * 图纸走导入（落进工作目录，AI 才读得到），其余走附件；两批互不影响，
 * 因此混拖一张图与一张 PNG 时，图纸进右栏、图片进输入框。
 */
export async function routeDroppedFiles(items: DroppedFile[]): Promise<void> {
  if (items.length === 0) return;
  const drawings = items.filter((item) => isDrawingFile(item.name));
  const others = items.filter((item) => !isDrawingFile(item.name));

  const imports = drawings.length > 0 ? importDrawings(drawings) : Promise.resolve();
  if (others.length > 0) {
    const batch = restoreFiles(others);
    // 在首次异步读取之前通知当前输入框，避免快速发送漏带附件、切换会话后串到新会话。
    emitFiles(batch);
    await Promise.all([imports, batch]);
  } else {
    await imports;
  }
}

/** 函数级说明（开发者 Jan）：执行 restoreFiles 的单一职责，并返回可供调用方继续处理的结果。 */
async function restoreFiles(items: DroppedFile[]): Promise<AttachmentBatch> {
  const files: File[] = [];
  const failed: string[] = [];
  for (const item of items) {
    if (item.file) {
      files.push(item.file);
      continue;
    }
    const restored = await restoreFile(item);
    if (restored) files.push(restored);
    else failed.push(item.name);
  }
  return { files, failed };
}

/** 原生拖放事件里的落点信息 → 统一的被拖入文件 */
function toDroppedFiles(paths: string[]): DroppedFile[] {
  return paths.map((path) => ({ name: fileNameFromPath(path), path, file: null }));
}

/** 桌面端：订阅 Tauri 原生拖放事件 */
async function listenNativeDrop(): Promise<void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent((event) => {
    // enter / over / leave 只是悬停过程，不需要处理
    if (event.payload.type !== "drop") return;
    void routeDroppedFiles(toDroppedFiles(event.payload.paths));
  });
}

/** 浏览器环境：拦截 window 的 dragover，否则浏览器会直接打开被拖入的文件 */
function handleBrowserDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
}

/** 浏览器环境：把 HTML5 drop 得到的文件交给同一条路由 */
function handleBrowserDrop(event: DragEvent): void {
  const list = event.dataTransfer?.files;
  if (!list || list.length === 0) return;
  event.preventDefault();
  void routeDroppedFiles(
    Array.from(list).map((file) => ({ name: file.name, path: null, file })),
  );
}

/** 是否已经装好监听：整个界面只装一次，避免重复注册导致同一文件被处理多遍 */
let started = false;

/**
 * 启动拖放路由（开发者 Jan）。
 *
 * 幂等：无论调用多少次都只装一次监听，因此可以放心在会重复执行的副作用里调用。
 * 界面挂载期间常驻（应用根组件卸载即整个页面结束），不需要成对的停止逻辑。
 */
export function startDropRouter(): void {
  if (started) return;
  started = true;
  if (isDesktopRuntime()) {
    void listenNativeDrop();
    return;
  }
  window.addEventListener("dragover", handleBrowserDragOver);
  window.addEventListener("drop", handleBrowserDrop);
}
