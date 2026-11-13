import { readContextFile } from "../context/fileText";
import { contentHash } from "./content";
import type { KnowledgeSource } from "./types";
import { DEFAULT_KNOWLEDGE_FILE_MB, normalizeKnowledgeFileMb } from "./importLimits";

// 与 knowledge_db.rs 的正文 UTF-8 字节上限一致；不再额外限制字符数量。
export const MAX_KNOWLEDGE_TEXT_BYTES = 32 * 1024 * 1024;

/** 读取完整文档并生成稳定 ID，长文档由入库流程自动分块。 */
export async function readKnowledgeDocument(name: string, bytes: Uint8Array<ArrayBuffer>, maxFileMb = DEFAULT_KNOWLEDGE_FILE_MB): Promise<KnowledgeSource> {
  const body = (await readContextFile(name, bytes, normalizeKnowledgeFileMb(maxFileMb) * 1024 * 1024)).trim();
  if (!body) throw new Error("文件没有可读取的文字");
  if (new TextEncoder().encode(body).byteLength > MAX_KNOWLEDGE_TEXT_BYTES) {
    throw new Error("解析后的正文超过 32 MB，请拆分后导入");
  }
  const hash = await contentHash(body);
  return { id: `document:${hash}`, kind: "document", title: name, threadId: null,
    body, messages: [], updatedAt: Date.now(), hash };
}
