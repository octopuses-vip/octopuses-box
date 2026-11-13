export interface KnowledgeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 助手消息的思考过程（仅评审 / 扩展时随消息提供给模型，不进导出正文） */
  reasoning?: string;
}

export interface KnowledgeSource {
  id: string;
  kind: "conversation" | "document";
  title: string;
  threadId: string | null;
  body: string;
  messages: KnowledgeMessage[];
  updatedAt: number;
  hash: string;
}

export type SourceSummary = Omit<KnowledgeSource, "body" | "messages">;

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  messageId: string | null;
  ordinal: number;
  text: string;
  hash: string;
  vector?: number[];
  model?: string;
}

export interface KnowledgeStats {
  conversations: number;
  documents: number;
  chunks: number;
  indexed: number;
}

export interface KnowledgeHit {
  id: string;
  sourceId: string;
  title: string;
  kind: KnowledgeSource["kind"];
  threadId: string | null;
  messageId: string | null;
  text: string;
  score: number;
  match: "keyword" | "semantic" | "hybrid";
}

export type KnowledgeRequest =
  | { op: "put"; source: KnowledgeSource; chunks: KnowledgeChunk[] }
  | { op: "list" }
  | { op: "get"; id: string }
  | { op: "remove"; id: string }
  | { op: "prune"; ids: string[] }
  | { op: "stats"; model: string }
  | { op: "pending"; model: string }
  | { op: "embed"; id: string; hash: string; model: string; vector: number[] }
  | { op: "search"; query: string; kind: string; model: string; vector: number[] | null }
  | { op: "export_markdown"; path: string; sources?: KnowledgeSource[] }
  | { op: "export"; path: string; format: TrainingFormat | "documents"; sources?: KnowledgeSource[] };

export type TrainingFormat = "messages" | "alpaca" | "sharegpt";

export interface MarkdownExportFile { name: string; content: string }
export interface MarkdownExportResult {
  count: number;
  directory?: string;
  files?: MarkdownExportFile[];
}
