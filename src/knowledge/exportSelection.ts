import type { KnowledgeSource } from "./types";

/** 函数级说明（开发者 Jan）：执行 groupExportSources 的单一职责，并返回可供调用方继续处理的结果。 */
export function groupExportSources(sources: KnowledgeSource[], threads: { id: string; projectId: string }[], projects: { id: string; name: string }[], showDocuments = false) {
  const threadProjects = new Map(threads.map((t) => [t.id, t.projectId]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const groups = new Map<string, { title: string; sources: KnowledgeSource[] }>();
  if (showDocuments) groups.set("documents", { title: "上传的文档", sources: [] });
  for (const source of sources) {
    const project = projectMap.get(threadProjects.get(source.threadId ?? "") ?? "");
    const id = source.kind === "document" ? "documents" : project?.id ?? "standalone";
    if (!groups.has(id)) groups.set(id, { title: source.kind === "document" ? "上传的文档" : project?.name ?? "独立会话 / 无所属项目", sources: [] });
    groups.get(id)!.sources.push(source);
  }
  return groups;
}

/** 函数级说明（开发者 Jan）：执行 selectedExportSources 的单一职责，并返回可供调用方继续处理的结果。 */
export function selectedExportSources(sources: KnowledgeSource[], selected: ReadonlySet<string>): KnowledgeSource[] {
  const result = sources.filter((source) => selected.has(source.id));
  if (!result.length) throw new Error("请至少勾选一条要导出的资料");
  return result;
}

/** 函数级说明（开发者 Jan）：执行 toggleExportGroup 的单一职责，并返回可供调用方继续处理的结果。 */
export function toggleExportGroup(selected: ReadonlySet<string>, ids: string[], checked: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
  return next;
}
