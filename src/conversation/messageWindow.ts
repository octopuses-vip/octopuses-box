/** Render recent history while retaining full canonical messages for context, search and export. */
export function messageWindowStart(ids: string[], visible: number, target?: string): number {
  return messageWindowRange(ids, visible, target).start;
}

/** 函数级说明（开发者 Jan）：执行 messageWindowRange 的单一职责，并返回可供调用方继续处理的结果。 */
export function messageWindowRange(ids: string[], visible: number, target?: string, end?: number | null) {
  const index = target ? ids.indexOf(target) : -1;
  const until = index < 0 ? Math.min(ids.length, end ?? ids.length) : Math.min(ids.length, index + 50);
  return { start: Math.max(0, until - visible), end: until };
}
