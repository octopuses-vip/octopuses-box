export const DEFAULT_KNOWLEDGE_FILE_MB = 10;
export const MAX_KNOWLEDGE_FILE_MB = 200;

/** 旧配置缺失或损坏时恢复默认值，合法配置按整数 MB 保存。 */
export function normalizeKnowledgeFileMb(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_KNOWLEDGE_FILE_MB
    ? value : DEFAULT_KNOWLEDGE_FILE_MB;
}
