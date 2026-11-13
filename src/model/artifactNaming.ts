/**
 * 产物命名规则（开发者 Jan）。
 *
 * 客户端本地生成的产物（3D 视图截图、目标检测画框图）需要一个统一且不重名的文件名，
 * 因此把「前缀 + 时间戳 + 去重序号」这套规则集中在这里，各处只引用不重写，
 * 避免同一批产物出现两种命名风格。
 */

/** 产物名前缀常量：同类产物只允许一个前缀，供用户按钮与 AI 工具共用 */
export const ARTIFACT_PREFIXES = {
  /** 3D 视图截图 */
  drawingView: "3d-view",
  /** 目标检测画框图 */
  objectDetection: "detect",
} as const;

/** 时间戳里各数值统一补零到两位 */
const PAD_WIDTH = 2;

/** 把数字补成两位，用于拼时间戳 */
function pad(value: number): string {
  return String(value).padStart(PAD_WIDTH, "0");
}

/**
 * 生成本地时间的紧凑时间戳，形如 `20261004-153012`。
 *
 * 用本地时间而非 UTC：产物名是给人看的，跟用户时钟一致才便于在文件管理器里对照。
 */
export function timestampSlug(now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}

/**
 * 生成一个不与既有产物重名的文件名（开发者 Jan）。
 *
 * @param prefix 产物前缀，取值见 `ARTIFACT_PREFIXES`
 * @param extension 扩展名，可带或不带点
 * @param existing 已有产物名，用于去重；同名时依次追加 `-1`、`-2`…
 */
export function nextArtifactName(
  prefix: string,
  extension: string,
  existing: readonly string[],
): string {
  const ext = extension.replace(/^\.+/, "").toLowerCase();
  const stem = `${prefix}-${timestampSlug()}`;
  // 文件名比较一律不区分大小写：同一目录下大小写不同也算重名
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  let candidate = `${stem}.${ext}`;
  let index = 1;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${stem}-${index}.${ext}`;
    index += 1;
  }
  return candidate;
}
