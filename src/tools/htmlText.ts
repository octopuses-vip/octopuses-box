/**
 * HTML → 文本的纯函数集合（开发者 Jan）。
 *
 * 联网检索的摘要解析、网页正文读取、附加上下文三处都要把 HTML 变成可读文本，
 * 因此这里做唯一实现：无 IO、无网络、无依赖，纯输入输出，便于单独验证。
 */

/** 正文默认字符上限，避免一次读取把上下文撑爆 */
export const DEFAULT_TEXT_LIMIT = 16_000;

/** 需要整块删除（连同内容）的噪声标签：这些内容对模型理解正文只有干扰 */
const NOISE_TAGS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "head",
  "nav",
  "footer",
  "aside",
  "form",
  "template",
];

/** 需要转换成换行的块级标签：否则段落会被黏成一行 */
const BLOCK_TAGS = [
  "p",
  "div",
  "br",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "section",
  "article",
  "main",
  "header",
];

/** 正文根候选标签，按优先级从高到低逐级回退 */
const CONTENT_ROOT_TAGS = ["article", "main", "body"];

/** 常见命名实体表；未收录的实体原样保留 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  hellip: "…",
  middot: "·",
};

/** 成对出现的噪声标签块，如 `<script>…</script>` */
const PAIRED_NOISE_PATTERN = new RegExp(
  `<(${NOISE_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  "gi",
);

/** 未闭合的噪声标签块：截到文末，避免正则匹配不到成对标签时残留脚本内容 */
const DANGLING_NOISE_PATTERN = new RegExp(
  `<(${NOISE_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`,
  "gi",
);

/** 块级标签整体替换为换行 */
const BLOCK_BREAK_PATTERN = new RegExp(`</?(?:${BLOCK_TAGS.join("|")})\\b[^>]*>`, "gi");

/** 常见 HTML 实体与数字实体解码（开发者 Jan） */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** 去掉标签、解码实体并压平空白，输出单行文本（开发者 Jan）；适合做摘要 */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** 按字符数截断并追加省略标记（开发者 Jan） */
export function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（内容过长，已截断）`;
}

/** 抽取网页标题（开发者 Jan）；没有 `<title>` 时返回空串，由调用方决定回退文案 */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripTags(match[1]) : "";
}

/** 删除噪声标签块（开发者 Jan）：先删成对的，再删未闭合的残留 */
function removeNoiseBlocks(html: string): string {
  return html.replace(PAIRED_NOISE_PATTERN, " ").replace(DANGLING_NOISE_PATTERN, " ");
}

/** 选取正文根（开发者 Jan）：`article` → `main` → `body` → 整页逐级回退 */
function pickContentRoot(html: string): string {
  for (const tag of CONTENT_ROOT_TAGS) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
    if (match) return match[1];
  }
  return html;
}

/**
 * 抽取网页正文（开发者 Jan）。
 *
 * 流水线：删噪声块 → 选正文根 → 块级标签转换行 → 去标签并解实体 → 逐行压平空白 →
 * 折叠空行 → 限长。保留换行是为了让模型能看清段落结构，而不是拿到一大坨单行文本。
 */
export function htmlToText(html: string, limit: number = DEFAULT_TEXT_LIMIT): string {
  const root = pickContentRoot(removeNoiseBlocks(html));
  const stripped = decodeEntities(root.replace(BLOCK_BREAK_PATTERN, "\n").replace(/<[^>]*>/g, ""));
  const text = stripped
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return clampText(text, limit);
}