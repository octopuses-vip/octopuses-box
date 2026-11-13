import { isDesktopRuntime } from "../app/desktop/runtime";
import { trainingRecord } from "./content";
import { knowledgeMarkdownFiles } from "./markdown";
import type { KnowledgeChunk, KnowledgeHit, KnowledgeRequest, KnowledgeSource, SourceSummary } from "./types";

interface Library { sources: KnowledgeSource[]; chunks: KnowledgeChunk[] }
const memory = new Map<string, Library>();
let browserQueue: Promise<unknown> = Promise.resolve();

/** 函数级说明（开发者 Jan）：执行 browserLibrary 的单一职责，并返回可供调用方继续处理的结果。 */
async function browserLibrary(scope: string, write?: Library): Promise<Library> {
  if (typeof indexedDB === "undefined") {
    if (typeof window !== "undefined") throw new Error("当前浏览器不支持知识库存储，请使用桌面应用。");
    if (write) memory.set(scope, structuredClone(write));
    return structuredClone(memory.get(scope) ?? { sources: [], chunks: [] });
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("octopuses-knowledge", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("libraries");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<Library>((resolve, reject) => {
      const transaction = db.transaction("libraries", write ? "readwrite" : "readonly");
      const store = transaction.objectStore("libraries");
      let result = write ?? { sources: [], chunks: [] };
      if (write) store.put(write, scope);
      else {
        const read = store.get(scope);
        read.onsuccess = () => { result = read.result ?? result; };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("知识库存储已中断"));
    });
  } finally { db.close(); }
}

/** 函数级说明（开发者 Jan）：执行 summary 的单一职责，并返回可供调用方继续处理的结果。 */
function summary(source: KnowledgeSource): SourceSummary {
  return { id: source.id, kind: source.kind, title: source.title, threadId: source.threadId,
    updatedAt: source.updatedAt, hash: source.hash };
}

/** 函数级说明（开发者 Jan）：执行 cosine 的单一职责，并返回可供调用方继续处理的结果。 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== 512 || b.length !== 512) return 0;
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}

/** 函数级说明（开发者 Jan）：执行 browserRequest 的单一职责，并返回可供调用方继续处理的结果。 */
async function browserRequest(scope: string, action: KnowledgeRequest): Promise<unknown> {
  const library = await browserLibrary(scope);
  const { sources, chunks } = library;
  switch (action.op) {
    case "export_markdown": {
      const files = knowledgeMarkdownFiles(action.sources ?? sources);
      if (!files.length) throw new Error("没有可导出的会话");
      return { count: files.length, files };
    }
    case "list": return [...sources].sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
    case "get": {
      const source = sources.find((s) => s.id === action.id);
      if (!source) throw new Error("资料不存在或已被删除");
      return source;
    }
    case "put": {
      const prior = new Map(chunks.filter((c) => c.sourceId === action.source.id).map((c) => [c.id, c]));
      library.sources = sources.filter((s) => s.id !== action.source.id).concat(action.source);
      library.chunks = chunks.filter((c) => c.sourceId !== action.source.id).concat(action.chunks.map((c) =>
        prior.get(c.id)?.hash === c.hash ? { ...c, vector: prior.get(c.id)?.vector, model: prior.get(c.id)?.model } : c));
      break;
    }
    case "remove":
      if (!sources.some((s) => s.id === action.id && s.kind === "document")) return false;
      library.sources = sources.filter((s) => s.id !== action.id);
      library.chunks = chunks.filter((c) => c.sourceId !== action.id);
      break;
    case "prune": {
      const retain = new Set(action.ids);
      library.sources = sources.filter((s) => s.kind !== "conversation" || retain.has(s.id));
      const keep = new Set(library.sources.map((s) => s.id));
      library.chunks = chunks.filter((c) => keep.has(c.sourceId));
      break;
    }
    case "stats": return { conversations: sources.filter((s) => s.kind === "conversation").length,
      documents: sources.filter((s) => s.kind === "document").length, chunks: chunks.length,
      indexed: chunks.filter((c) => c.vector && c.model === action.model).length };
    case "pending": return chunks.filter((c) => !c.vector || c.model !== action.model).slice(0, 8);
    case "embed": {
      if (action.vector.length !== 512 || action.vector.some((v) => !Number.isFinite(v)) || !action.vector.some((v) => v !== 0)) throw new Error("无效向量");
      const chunk = chunks.find((c) => c.id === action.id && c.hash === action.hash);
      if (!chunk) return false;
      chunk.vector = action.vector; chunk.model = action.model;
      break;
    }
    case "search": {
      const query = action.query.trim().toLowerCase();
      if (!query) return [];
      if (Array.from(query).length > 512) throw new Error("搜索内容请控制在 512 字以内");
      const map = new Map(sources.map((s) => [s.id, s]));
      const candidates = chunks.filter((c) => !action.kind || map.get(c.sourceId)?.kind === action.kind);
      const hits = new Map<string, KnowledgeHit>();
/** 函数级说明（开发者 Jan）：执行 hit 的单一职责，并返回可供调用方继续处理的结果。 */
      const hit = (c: KnowledgeChunk, rank: number, semantic: boolean) => {
        const source = map.get(c.sourceId);
        if (!source) return;
        const score = 1 / (60 + rank);
        const existing = hits.get(c.id);
        if (existing) { existing.score += score; existing.match = "hybrid"; return; }
        hits.set(c.id, { id: c.id, sourceId: c.sourceId, title: source.title, kind: source.kind,
          threadId: source.threadId, messageId: c.messageId, text: c.text, score, match: semantic ? "semantic" : "keyword" });
      };
      // 带向量时只做语义召回：关键词命中不能替代向量相似度，否则上传文档
      // 即使尚未建立完整索引也会被误报成搜索成功。
      if (action.vector) candidates.filter((c) => c.vector && c.model === action.model)
        .map((c) => ({ c, score: cosine(c.vector!, action.vector!) })).filter((v) => v.score >= .4)
        .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id)).forEach((v, index) => hit(v.c, index, true));
      else candidates.filter((c) => c.text.toLowerCase().includes(query) || map.get(c.sourceId)?.title.toLowerCase().includes(query))
        .forEach((c, index) => hit(c, index, false));
      // 先按相关性选择每个来源的最佳片段，再限制结果数，避免长文档挤占其他来源。
      const seen = new Set<string>();
      return [...hits.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).filter((hit) => {
        const key = JSON.stringify([hit.kind, hit.kind === "conversation" ? hit.threadId ?? hit.sourceId : hit.sourceId]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 60);
    }
    case "export": {
      let skipped = 0;
      const lines = (action.sources ?? sources).flatMap((s) => {
        if (action.format === "documents") return s.kind === "document" ? [JSON.stringify({ id: s.id, title: s.title, text: s.body })] : [];
        if (s.kind !== "conversation") return [];
        const record = trainingRecord(s, action.format);
        if (!record) { skipped++; return []; }
        return [JSON.stringify(record)];
      });
      if (!lines.length) throw new Error("没有可导出的有效数据");
      return { count: lines.length, skipped, text: `${lines.join("\n")}\n` };
    }
  }
  await browserLibrary(scope, library);
  return true;
}

/** 函数级说明（开发者 Jan）：执行 knowledgeRequest 的单一职责，并返回可供调用方继续处理的结果。 */
export async function knowledgeRequest<T>(cacheDir: string, action: KnowledgeRequest): Promise<T> {
  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>("knowledge_request", { cacheDir, action });
  }
  const result = browserQueue.then(() => browserRequest(cacheDir, action));
  browserQueue = result.catch(() => {});
  return result as Promise<T>;
}
