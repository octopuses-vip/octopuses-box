import type { ToolCall } from "../model/client";
import type { ToolCallExecutionContext } from "../hooks/agentToolCall";
import { requestApproval } from "../approval/gate";
import { inspectAudioFile } from "../app/desktop/audioFiles";
import { writeArtifact } from "../app/desktop/artifacts";
import { transcribeAudio, transcriptionConnection } from "./transcription";
import { checkpointKey } from "./checkpoints";

import { TRANSCRIBE_AUDIO_NAME } from "./protocol";

/** Expose the same native workflow to agents, with the existing approval gate before local reads/uploads. */
export async function runAudioTool(call: ToolCall, context: ToolCallExecutionContext): Promise<string> {
  const id = context.nextId("item");
  context.push({ id, type: "tool_call", kind: "read_file", name: TRANSCRIBE_AUDIO_NAME, callId: call.id,
    arguments: call.function.arguments, title: "提取音视频文字", command: null, status: "running", output: "", durationMs: null });
  const started = Date.now();
  let ok = false, output: string;
  try {
    const args = JSON.parse(call.function.arguments) as { path?: unknown; offset?: unknown };
    if (typeof args.path !== "string" || !args.path.trim()) throw new Error("请提供音视频文件路径。");
    const offset = args.offset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数。");
    const s = context.store;
    const connection = transcriptionConnection(s.remoteModels, s.audioModelCode);
    const approval = await requestApproval({ command: `transcribe_audio ${args.path}`,
      reason: `读取音视频并将音轨发送到语音服务 ${new URL(connection.url).host}，结果保存到当前会话产物目录。`,
      pattern: `audio:${args.path}`, decision: "ask" }, context.approvalHost);
    if (!approval.approved) throw new Error("音视频转写未获批准。");
    context.controller.signal.throwIfAborted();
    if (!context.valid()) throw new DOMException("会话已失效", "AbortError");
    const file = await inspectAudioFile(args.path, context.workspacePath);
    const options = { cachePath: context.cachePath, scope: "local" };
    const text = await transcribeAudio(file, connection, context.controller.signal, (status) => {
      context.patch(id, (item) => item.type === "tool_call" ? { ...item, output: status } : item);
    }, options);
    context.controller.signal.throwIfAborted();
    if (!context.valid()) throw new DOMException("会话已失效", "AbortError");
    const key = await checkpointKey(file, connection, options.scope);
    const name = `transcript-${key.slice(0, 16)}.txt`;
    if (!context.artifactDir) throw new Error("当前会话缺少产物目录。");
    await writeArtifact(context.artifactDir, name, text);
    await s.loadArtifacts();
    const end = Math.min(text.length, offset + 16_000);
    output = `完整文字已保存为 ${name}（共 ${text.length} 字符）。\n当前返回 ${offset}–${end}；${end < text.length ? `继续读取请用 offset=${end}。` : "已到末尾。"}\n\n${text.slice(offset, end)}`;
    ok = true;
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    if (context.controller.signal.aborted) throw error;
  } finally {
    context.patch(id, (item) => item.type === "tool_call" ? { ...item, status: ok ? "success" : "error", output: ok ? "转写完成，完整文字已保存为文件。" : "转写未完成，可查看结果后重试。", durationMs: Date.now() - started } : item);
  }
  context.patch(id, (item) => item.type === "tool_call" ? { ...item, output, result: output } : item);
  return output;
}
