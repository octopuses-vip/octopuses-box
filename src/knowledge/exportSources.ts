import type { Message, Thread } from "../app/types";
import { sessionMessages } from "../cache/conversationSnapshot";
import { knowledgeRequest } from "./api";
import { conversationSource } from "./content";
import type { KnowledgeSource, SourceSummary } from "./types";

/** 独立读取文档与会话；单条资料损坏不遮蔽其他可导出的来源。 */
export async function loadExportSources(scope: string, kind: "training" | "markdown" | "documents", snapshot: {
  sessionsRestored: boolean;
  sessionsRestoreError: string | null;
  threads: Thread[];
  threadRunStates: Record<string, { status: string } | undefined>;
  messages: Record<string, Message[] | undefined>;
}) {
  const sources: KnowledgeSource[] = [];
  const warnings: string[] = [];
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  if (kind !== "markdown") {
    try {
      const summaries = await knowledgeRequest<SourceSummary[]>(scope, { op: "list" });
      for (const summary of summaries.filter((s) => s.kind === "document")) {
        try { sources.push(await knowledgeRequest<KnowledgeSource>(scope, { op: "get", id: summary.id })); }
        catch (error) { warnings.push(`文档“${summary.title}”读取失败：${errorText(error)}`); }
      }
    } catch (error) { warnings.push(`上传文档读取失败：${errorText(error)}`); }
  }
  if (kind !== "documents") {
    if (!snapshot.sessionsRestored || snapshot.sessionsRestoreError) {
      warnings.push("会话尚未成功读回，暂不可选；已上传文档仍可导出。");
    } else {
      let running = 0;
      for (const thread of snapshot.threads) {
        const status = snapshot.threadRunStates[thread.id]?.status;
        if (status === "running" || status === "queued") { running++; continue; }
        try { sources.push(await conversationSource(thread, await sessionMessages(scope, thread.id, snapshot.messages[thread.id]))); }
        catch (error) { warnings.push(`会话“${thread.title}”读取失败：${errorText(error)}`); }
      }
      if (running) warnings.push(`已排除 ${running} 条正在运行的会话，结束后可重新打开导出。`);
    }
  }
  return { sources, warnings };
}
