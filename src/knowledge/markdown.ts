import type { KnowledgeSource, MarkdownExportFile } from "./types";

/** 编号确保同名会话不冲突；兼容 Windows 文件名，控制 UTF-8 文件名长度。 */
export function knowledgeMarkdownName(title: string, index: number): string {
  const safe = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim())
    .slice(0, 50).join("").replace(/[. ]+$/, "") || "未命名会话";
  return `${String(index + 1).padStart(4, "0")}-${safe}.md`;
}

/** 函数级说明（开发者 Jan）：执行 inline 的单一职责，并返回可供调用方继续处理的结果。 */
function inline(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/[\\`*_{}\[\]()#+.!<>|]/g, "\\$&");
}

/** 完整会话归档，不使用微调数据的问答配对过滤；保留未回答问题和原有 Markdown。 */
export function knowledgeMarkdown(source: KnowledgeSource): string {
  const messages = source.messages.filter((message) => message.content.trim());
  const blocks = [
    `# ${inline(source.title.trim() || "未命名会话")}`,
    `- 会话 ID：${inline(source.threadId ?? source.id)}\n- 消息数：${messages.length}`,
    "---",
  ];
  messages.forEach((message, index) => {
    blocks.push(`## ${index + 1}. ${message.role === "user" ? "用户" : "助手"}\n\n${message.content}`);
  });
  if (!messages.length) blocks.push(source.body.trim() || "此会话暂无可导出的正文。");
  return `${blocks.join("\n\n")}\n`;
}

/** 函数级说明（开发者 Jan）：执行 knowledgeMarkdownFiles 的单一职责，并返回可供调用方继续处理的结果。 */
export function knowledgeMarkdownFiles(sources: KnowledgeSource[]): MarkdownExportFile[] {
  return [...sources].filter((source) => source.kind === "conversation")
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((source, index) => ({ name: knowledgeMarkdownName(source.title, index), content: knowledgeMarkdown(source) }));
}

/** 浏览器批量下载成一个 ZIP，解压后每个会话对应独立的 Markdown 文件。 */
export async function knowledgeMarkdownZip(files: MarkdownExportFile[]): Promise<Uint8Array<ArrayBuffer>> {
  const { zip, strToU8 } = await import("fflate");
  const entries = Object.fromEntries(files.map((file) => [file.name, strToU8(file.content)]));
  return new Promise((resolve, reject) => {
    zip(entries, { level: 1 }, (error, data) => {
      if (error) reject(error);
      else resolve(new Uint8Array(data));
    });
  });
}
