
import { callMcpTool } from "../app/desktop/mcp";
import { classifyWorkspaceCommand } from "../app/desktop/workspace";
import {
  commandPattern,
  permissionModeOf,
  requestApproval,
  type ApprovalHost,
} from "../approval/gate";
import { useAppStore } from "../app/state";
import type {
  StreamItem,
  ToolKind,
} from "../app/types";
import { type ToolImage } from "../model/toolImage";
import {
  type ChatContentPart,
  type ChatMessage,
  type ToolCall,
} from "../model/client";
import {
  findMcpBinding,
} from "../mcp/tool";
import {
  type SkillToolScope,
} from "../skills/invoke";
import { READ_SKILL_TOOL, runReadSkillTool } from "../skills/tool";
import { ASK_USER_TOOL_NAME, parseAskUser } from "../tools/askUser";
import {
  BROWSER_CDP_TOOL_NAME,
  BROWSER_SCRIPT_TOOL_NAME,
  COMPUTER_CLICK_TOOL_NAME,
  COMPUTER_SCRIPT_TOOL_NAME,
  CONTROL_TOOL_NAMES,
  OPEN_IN_BROWSER_TOOL_NAME,
  SCREENSHOT_TOOL_NAME,
  isReadOnlyControlCall,
  runControlTool,
} from "../tools/control";
import {
  IMAGE_GEN_TOOL_NAME,
  runGenerateImageTool,
} from "../tools/imageGen";
import {
  WRITE_FILE_TOOL,
  isHtmlArtifact,
  runWriteFileTool,
} from "../tools/writeFile";
import { WEB_SEARCH_TOOL, runWebSearch } from "../tools/webSearch";
import { KNOWLEDGE_SEARCH_TOOL_NAME, runKnowledgeSearch } from "../tools/knowledge";
import {
  READ_URL_TOOL_NAME,
  runReadUrl,
} from "../tools/readUrl";
import {
  READ_IMAGE_TOOL_NAME,
  RENDER_3D_VIEW_TOOL_NAME,
  runVisionTool,
} from "../tools/vision";
import {
  DETECT_OBJECTS_TOOL_NAME,
  OCR_IMAGE_TOOL_NAME,
  runCvTool,
} from "../tools/cv";
import {
  APPLY_PATCH_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SEARCH_CODE_TOOL_NAME,
  TEST_RUNNER_TOOL_NAME,
  WRITE_FILE_TOOL_NAME as PROJECT_WRITE_FILE_TOOL_NAME,
  runWorkspaceTool,
} from "../tools/workspace";
import {
  buildSshGuardHint,
  describeSshCall,
  isSshTool,
  runSshTool,
} from "../tools/ssh";
import {
  MAX_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_DEPTH,
  RUN_SUBAGENT_TOOL_NAME,
  clipSubagentOutput,
  parseSubagentArgs,
} from "../tools/subagent";
import { lastAssistantReply } from "../automations/suggestions";

/**
 * 一次运行里最多保留几张截图回灌给模型：截图体积大，无限累积会撑爆上下文
 */
import { AgentExecutor, AgentRequest, AgentRunOutcome, collectToolImages, preview, readFileName, readSkillName, readArgumentNumber, readArgumentString, isActiveThread, runSlot, titleSummary, enqueueRequest, subagentApprovalMirrors } from "./useAgentRunShared";

import type { ModelConnection } from "../app/desktop/connectionTypes";
import type { AppStore } from "../app/storeTypes";
import type { McpToolBinding } from "../mcp/tool";
// AgentExecutionResult / AgentExecutor 已由 useAgentRunShared 的值导入带入，
// ChatContentPart / ChatMessage / ToolCall 已由 model/client 的行内 type 导入带入，
// 这里不能再重复声明，否则 oxc（vite）解析直接报重复标识符，开发模式白屏。
// StreamItem 已由文件头部 app/types 的 type 导入带入，SkillToolScope 已由 skills/invoke
// 的行内 type 导入带入；此处重复声明会让 oxc（vite）解析报重复标识符，开发模式白屏。
import type { SshHost, Thread } from "../app/types";

/** 工具调用执行器的共享上下文；把模型循环与具体工具解耦（开发者 Jan）。 */
export interface ToolCallExecutionContext {
  controller: AbortController;
  valid: () => boolean;
  push: (item: StreamItem) => void;
  state: { producedAny: boolean; askPending: boolean };
  canSpawnSubagent: boolean;
  threadId: string;
  threadProjectId: string;
  thread: Thread;
  execute: AgentExecutor;
  patch: (itemId: string, updater: (item: StreamItem) => StreamItem) => void;
  mcpBindings: McpToolBinding[];
  cachePath: string | null;
  skillToolScope: SkillToolScope;
  artifactDir: string | null;
  config: ModelConnection;
  store: AppStore;
  approvalHost: ApprovalHost;
  workspacePath: string | null;
  renderedCheckpoints: Set<string>;
  sshHosts: SshHost[];
  pendingImages: ChatContentPart[];
  runId: string;
  model: string;
  nextId: (prefix: string) => string;
}

/** 执行一条模型工具调用并把结果写回会话（开发者 Jan）。 */
export async function runToolCall(call: ToolCall, context: ToolCallExecutionContext): Promise<ChatMessage> {
  const { controller, valid, push, state, canSpawnSubagent, threadId, threadProjectId, thread, execute, patch, mcpBindings, cachePath, skillToolScope, artifactDir, config, store, approvalHost, workspacePath, renderedCheckpoints, sshHosts, pendingImages, runId, nextId } = context;

        controller.signal.throwIfAborted();
        if (!valid()) throw new DOMException("会话已删除或切换存储目录", "AbortError");
        const tool = call.function.name.trim();

        // 需求确认：成功时渲染一张待回答的卡片并标记本轮结束；参数不合法则让模型自行纠错
        if (tool === ASK_USER_TOOL_NAME) {
          const parsed = parseAskUser(call.function.arguments);
          if (parsed.ok) {
            push({
              id: nextId("item"),
              type: "question",
              questions: parsed.questions,
              answers: null,
            });
            state.producedAny = true;
            state.askPending = true;
          } else {
            push({
              id: nextId("item"),
              type: "tool_call",
              kind: "ask_user",
              title: "需求确认",
              command: null,
              status: "error",
              output: parsed.output,
              durationMs: null,
              // 协议层字段与正文工具调用同一口径，便于跨轮次还原
              callId: call.id,
              name: tool,
              arguments: call.function.arguments,
              result: parsed.output,
            });
          }
          return { role: "tool", tool_call_id: call.id, content: parsed.output };
        }

        // 子代理委派：建一个子会话跑任务，挂起等待结果，把它的最后一条助手正文回填为工具结果。
        // 走的是同一条运行链路（createThread → enqueueRequest → execute），预算 / 权限 / 白名单全部沿用。
        if (tool === RUN_SUBAGENT_TOOL_NAME) {
          const parsed = parseSubagentArgs(call.function.arguments);
          const itemId = nextId("item");
          push({
            id: itemId,
            type: "tool_call",
            kind: "subagent",
            title: parsed.ok ? `委派子代理 ${titleSummary(parsed.prompt, 30)}` : "委派子代理",
            command: null,
            status: "running",
            output: "",
            durationMs: null,
            callId: call.id,
            name: tool,
            arguments: call.function.arguments,
          });
          state.producedAny = true;
          const startedAt = Date.now();

          let ok = false;
          let output: string;
          if (!parsed.ok) {
            output = parsed.output;
          } else if (!canSpawnSubagent) {
            output = `当前会话已达子代理嵌套上限（${MAX_SUBAGENT_DEPTH} 层），无法再委派，请直接完成该任务。`;
          } else {
            const state = useAppStore.getState();
            // 并发上限：统计同一父会话下仍在运行 / 排队的子会话数量
            const activeSiblings = state.threads
              .filter((item) => item.parentThreadId === threadId)
              .filter((item) => {
                const status = state.threadRunStates[item.id]?.status ?? "idle";
                return status === "running" || status === "queued";
              }).length;
            if (activeSiblings >= MAX_SUBAGENT_CONCURRENCY) {
              output = `同时运行的子代理已达上限（${MAX_SUBAGENT_CONCURRENCY} 个），请稍后重试或直接完成该任务。`;
            } else {
              const childId = state.createThread(
                titleSummary(parsed.prompt, 24) || "子代理任务",
                // 子会话归属父会话所在项目，共享同一份工作区与项目规则；focus 为 false，不抢走界面
                threadProjectId,
                false,
                parsed.agentId ?? thread?.agentId ?? null,
                threadId,
                // 权限档位随委派继承：用户在主任务上选到哪一档，委派出去就是哪一档。
                // 不继承会两头都错——收紧到「每次询问」的会话派出个「只读自动」的子代理反而更松，
                // 而放到「全部自动」的会话派出的子代理却莫名退回只读自动、写操作全转人工。
                // 这里取的是父会话的**有效**档位（已含其 Agent 上限），子会话自己的 Agent 上限
                // 还会在闸门里再收窄一次，因此继承只会同样严或更严，不会放开权限。
                permissionModeOf(threadId),
              );
              // 审批镜像：子会话的人工审批卡片同时推进最外层可见会话；更深层的后代沿用本会话的
              // 映射，因此无论嵌套多深，卡片最终都落在用户正在看的那条会话里
              subagentApprovalMirrors.set(
                childId,
                subagentApprovalMirrors.get(threadId) ?? threadId,
              );
              // 中断联动：父运行被停止时一并中止子会话，避免留下无人回收的后台运行
              const abortChild = () => runSlot(childId).abort?.abort();
              controller.signal.addEventListener("abort", abortChild, { once: true });
              if (controller.signal.aborted) abortChild();
              try {
                const outcome = await new Promise<AgentRunOutcome>((resolve) => {
                  const request: AgentRequest = {
                    id: nextId("request"),
                    threadId: childId,
                    prompt: parsed.prompt,
                    attachments: [],
                    source: "user",
                    automationRunId: null,
                    resolve,
                  };
                  enqueueRequest(request, "run", execute);
                });
                const reply = clipSubagentOutput(
                  lastAssistantReply(useAppStore.getState().messages[childId] ?? []),
                );
                if (outcome === "success" && reply.length > 0) {
                  ok = true;
                  output = reply;
                } else if (outcome === "aborted") {
                  output = "子代理运行被中断，未返回结果。";
                } else if (reply.length > 0) {
                  // 被上限截停但已有正文时仍回填正文，同时说明未正常收束，便于父代理判断是否重试
                  output = `${reply}\n\n（子代理未正常结束，结束状态：${outcome}）`;
                } else {
                  output = "子代理未返回任何内容。";
                }
              } finally {
                subagentApprovalMirrors.delete(childId);
                controller.signal.removeEventListener("abort", abortChild);
              }
            }
          }

          patch(itemId, (item) =>
            item.type === "tool_call"
              ? {
                  ...item,
                  status: ok ? "success" : "error",
                  output,
                  durationMs: Date.now() - startedAt,
                  result: output,
                }
              : item,
          );
          return { role: "tool", tool_call_id: call.id, content: output };
        }

        const isReadSkill = tool === READ_SKILL_TOOL.function.name;
        const isWriteArtifact = tool === WRITE_FILE_TOOL.function.name;
        const isImageGen = tool === IMAGE_GEN_TOOL_NAME;
        const isWebSearch = tool === WEB_SEARCH_TOOL.function.name;
        const isKnowledgeSearch = tool === KNOWLEDGE_SEARCH_TOOL_NAME;
        const isReadUrl = tool === READ_URL_TOOL_NAME;
        const isWorkspaceTool = [
          READ_FILE_TOOL_NAME,
          PROJECT_WRITE_FILE_TOOL_NAME,
          APPLY_PATCH_TOOL_NAME,
          SEARCH_CODE_TOOL_NAME,
          TEST_RUNNER_TOOL_NAME,
        ].includes(tool);
        const mcpBinding = findMcpBinding(mcpBindings, tool);
        const isControl = CONTROL_TOOL_NAMES.includes(tool);
        const isVision = tool === READ_IMAGE_TOOL_NAME || tool === RENDER_3D_VIEW_TOOL_NAME;
        const isCv = tool === OCR_IMAGE_TOOL_NAME || tool === DETECT_OBJECTS_TOOL_NAME;
        const isSsh = isSshTool(tool);
        const kind: ToolKind = isWebSearch
          ? "web_search"
          : isKnowledgeSearch
            ? "knowledge_search"
          : isReadUrl
            ? "read_url"
            : isReadSkill
              ? "read_skill"
              : isWriteArtifact
                ? "write_artifact"
                : isImageGen
                  ? "image_gen"
                  : tool === PROJECT_WRITE_FILE_TOOL_NAME
                    ? "write_file"
                    : tool === APPLY_PATCH_TOOL_NAME
                      ? "apply_patch"
                      : tool === SEARCH_CODE_TOOL_NAME
                        ? "search_code"
                        : tool === TEST_RUNNER_TOOL_NAME
                          ? "test_runner"
                          : mcpBinding
                            ? "mcp"
                              : tool === COMPUTER_SCRIPT_TOOL_NAME
                                || tool === "computer_assistant"
                                || tool === COMPUTER_CLICK_TOOL_NAME
                                || tool === SCREENSHOT_TOOL_NAME
                                ? "computer"
                                : isControl
                                  ? "browser"
                                  : isCv
                                    ? "cv"
                                    : isVision
                                      ? "vision"
                                      : isSsh
                                        ? "ssh"
                                        : "read_file";

        const target = isReadSkill
          ? readSkillName(call.function.arguments)
          : isWriteArtifact
            ? readFileName(call.function.arguments)
            : isImageGen
              ? titleSummary(readArgumentString(call.function.arguments, "prompt"))
            : isWebSearch || isKnowledgeSearch || tool === SEARCH_CODE_TOOL_NAME
                ? readArgumentString(call.function.arguments, "query")
                : isReadUrl
                  ? readArgumentString(call.function.arguments, "url")
                  : isVision || isCv
                    ? readArgumentString(call.function.arguments, "name")
                    : tool === APPLY_PATCH_TOOL_NAME
                    ? null
                    : tool === TEST_RUNNER_TOOL_NAME
                      ? readArgumentString(call.function.arguments, "command")
                      : readArgumentString(call.function.arguments, "path");
        const workspaceTitle = tool === READ_FILE_TOOL_NAME
          ? target ? `读取文件 ${target}` : "读取文件"
          : tool === PROJECT_WRITE_FILE_TOOL_NAME
            ? target ? `写入文件 ${target}` : "写入文件"
            : tool === APPLY_PATCH_TOOL_NAME
              ? "应用补丁"
              : tool === SEARCH_CODE_TOOL_NAME
                ? target ? `搜索代码 ${target}` : "搜索代码"
                : target ? `运行验证 ${target}` : "运行验证";
        const cdpAction = tool === BROWSER_CDP_TOOL_NAME
          ? readArgumentString(call.function.arguments, "action")
          : null;
        const controlTarget = tool === OPEN_IN_BROWSER_TOOL_NAME
          ? readArgumentString(call.function.arguments, "url")
          : tool === BROWSER_SCRIPT_TOOL_NAME
            ? readArgumentString(call.function.arguments, "value")
            : tool === BROWSER_CDP_TOOL_NAME
              ? readArgumentString(call.function.arguments, "url")
                ?? readArgumentString(call.function.arguments, "selector")
              : tool === COMPUTER_CLICK_TOOL_NAME
                ? [readArgumentNumber(call.function.arguments, "x"), readArgumentNumber(call.function.arguments, "y")]
                    .filter((value) => value !== null)
                    .join(", ") || null
                : null;
        const controlTitle = tool === OPEN_IN_BROWSER_TOOL_NAME
          ? controlTarget ? `打开网页 ${controlTarget}` : "打开网页"
          : tool === BROWSER_SCRIPT_TOOL_NAME
            ? controlTarget ? `驱动本机浏览器 ${controlTarget}` : "驱动本机浏览器"
            : tool === BROWSER_CDP_TOOL_NAME
              ? [`驱动调试浏览器 ${cdpAction ?? ""}`.trim(), controlTarget]
                  .filter(Boolean)
                  .join("：")
              : tool === SCREENSHOT_TOOL_NAME
                ? "截取屏幕"
                : tool === COMPUTER_CLICK_TOOL_NAME
                  ? `点击屏幕 ${controlTarget ?? ""}`.trim()
                  : "执行 AppleScript";
        const visionTitle = tool === READ_IMAGE_TOOL_NAME
          ? target ? `读取图片 ${target}` : "读取图片"
          : "抓取 3D 视图";
        const cvTitle = tool === OCR_IMAGE_TOOL_NAME
          ? target ? `识别文字 ${target}` : "识别文字"
          : target ? `检测物体 ${target}` : "检测物体";
        // 远程操作要一眼看出「对哪台机器做了什么」，因此复用 ssh.ts 的统一摘要
        const sshCall = isSsh ? describeSshCall(tool, call.function.arguments) : null;
        const sshTitle = sshCall
          ? [sshCall.title, titleSummary(sshCall.command, 40)].filter(Boolean).join(" ")
          : "远程操作";
        const title = isReadSkill
          ? target ? `读取技能 ${target}` : "读取技能目录"
          : isWriteArtifact
            ? target ? `写出产物 ${target}` : "写出产物"
            : isImageGen
              ? target ? `生成图片 ${target}` : "生成图片"
              : isWebSearch
                ? target ? `联网检索 ${target}` : "联网检索"
                : isKnowledgeSearch
                  ? target ? `检索知识库 ${target}` : "检索知识库"
                : isReadUrl
                  ? target ? `读取网页 ${target}` : "读取网页"
                  : isWorkspaceTool
                    ? workspaceTitle
                    : mcpBinding
                      ? `调用 MCP 工具 ${mcpBinding.tool.name}`
                      : isControl
                        ? controlTitle
                        : isCv
                          ? cvTitle
                          : isVision
                            ? visionTitle
                            : isSsh
                              ? sshTitle
                              : `调用工具 ${tool}`;

        const itemId = nextId("item");
        push({
          id: itemId,
          type: "tool_call",
          kind,
          title,
          command: null,
          status: "running",
          output: "",
          durationMs: null,
          // 协议层字段：跨轮次重建上下文时要拼出合法的 assistant(tool_calls) + tool 配对
          callId: call.id,
          name: tool,
          arguments: call.function.arguments,
        });
        state.producedAny = true;

        const startedAt = Date.now();
        // 声明里带上可选的图片字段：各工具产出图片的字段不同，统一由 collectToolImages 收敛
        let result: {
          ok: boolean;
          output: string;
          image?: { mime: string; base64: string; width?: number; height?: number };
          images?: ToolImage[];
        } = {
          ok: false,
          output: `工具 ${tool} 未产生执行结果。`,
        };
        // 该主机的「执行限制」提示词：只在远程调用真正发生时才有值，
        // 由调用结果一并回灌给模型（见末尾 modelOutput），不污染工具卡片的展示文案
        let sshGuardHint = "";
        if (isReadSkill) {
          result = await runReadSkillTool(cachePath, call.function.arguments, skillToolScope);
        } else if (isWriteArtifact) {
          const written = await runWriteFileTool(artifactDir, call.function.arguments);
          result = written;
          if (written.ok && written.name) {
            // 写盘成功：刷新产物列表；右栏只在当前会话时才跟着切，避免后台会话抢走界面
            const state = useAppStore.getState();
            await state.loadArtifacts();
            if (isActiveThread(threadId)) {
              await state.selectArtifact(written.name);
              state.setRightTab(isHtmlArtifact(written.name) ? "web" : "files");
            }
          }
        } else if (isImageGen) {
          const generated = await runGenerateImageTool(
            artifactDir,
            config,
            call.function.arguments,
            controller.signal,
          );
          result = generated;
          if (generated.ok && generated.name) {
            // 与 write_artifact 同一条落地路径：刷新列表并（仅当前会话）切到「图片」tab
            const state = useAppStore.getState();
            await state.loadArtifacts();
            if (isActiveThread(threadId)) {
              await state.selectArtifact(generated.name);
              state.setRightTab("media");
            }
          }
        } else if (isWorkspaceTool) {
          if (tool === TEST_RUNNER_TOOL_NAME) {
            const command = readArgumentString(call.function.arguments, "command");
            if (!command) {
              result = { ok: false, output: "test_runner 缺少非空 command。" };
            } else {
              // 静态策略先判 deny / allow；只有 ask 才会进闸门的评审与人工分支
              const policy = await classifyWorkspaceCommand(command, store.trustReadOnlyCommands);
              const approval = await requestApproval(
                {
                  command,
                  reason: policy.reason,
                  decision: policy.decision,
                  pattern: commandPattern(command),
                },
                approvalHost,
              );
              if (!approval.approved) {
                result = {
                  ok: false,
                  output:
                    policy.decision === "deny"
                      ? `命令已被安全策略拒绝：${policy.reason}`
                      : approval.expired
                        ? "审批等待超时，命令已跳过（无人确认）。"
                        : "用户拒绝执行该命令。",
                };
              } else {
                result = await runWorkspaceTool(
                  {
                    cachePath,
                    projectPath: workspacePath,
                    threadId,
                    runId,
                    trustReadOnlyCommands: store.trustReadOnlyCommands,
                    // 静态白名单放行时无需审批标记；ask 分支（人工或自动批准）需要
                    approved: policy.decision === "ask",
                    sandboxEnabled: store.sandboxEnabled,
                    sandboxAllowNetwork: store.sandboxAllowNetwork,
                  },
                  tool,
                  call.function.arguments,
                );
              }
            }
          } else {
            result = await runWorkspaceTool(
              {
                cachePath,
                projectPath: workspacePath,
                threadId,
                runId,
                trustReadOnlyCommands: store.trustReadOnlyCommands,
                sandboxEnabled: store.sandboxEnabled,
                sandboxAllowNetwork: store.sandboxAllowNetwork,
              },
              tool,
              call.function.arguments,
            );
          }
          const executed = result as typeof result & { changed?: boolean; checkpointId?: string };
          if (
            executed.ok
            && executed.checkpointId
            && !renderedCheckpoints.has(executed.checkpointId)
          ) {
            renderedCheckpoints.add(executed.checkpointId);
            push({
              id: nextId("item"),
              type: "checkpoint",
              checkpointId: executed.checkpointId,
              status: "ready",
              detail: "已保存本轮修改前的文件状态。",
            });
          }
          if (executed.ok && executed.changed && isActiveThread(threadId)) {
            const state = useAppStore.getState();
            await state.loadGitDiff();
            state.setRightTab("diff");
          }
        } else if (isWebSearch) {
          const searched = await runWebSearch(call.function.arguments, {
            dir: workspacePath,
            enabled: store.sandboxEnabled,
            allowNetwork: store.sandboxAllowNetwork,
          });
          result = searched;
          // 检索到的来源静默记进本次运行所属会话（后台会话也照记，切过去才看得到）；
          // 不在检索时切 tab 或弹出右栏（`setRightTab` 会顺带打开右栏），避免打断用户当前的阅读
          if (searched.sources.length > 0) {
            useAppStore.getState().mergeSources(threadId, searched.sources);
          }
        } else if (isKnowledgeSearch) {
          result = await runKnowledgeSearch(call.function.arguments, cachePath);
        } else if (isReadUrl) {
          const read = await runReadUrl(call.function.arguments, {
            dir: workspacePath,
            enabled: store.sandboxEnabled,
            allowNetwork: store.sandboxAllowNetwork,
          });
          result = read;
          // 读到的网页同样并入本次运行所属会话的「来源」，但不抢用户的当前 tab：
          // 一次任务常连着读好几页，每次都跳转会打断用户正在看的内容
          if (read.sources.length > 0) {
            useAppStore.getState().mergeSources(threadId, read.sources);
          }
        } else if (mcpBinding) {
          // MCP 工具可能启动本地进程，交给审批闸门按会话权限处理。
          const approval = await requestApproval(
            {
              command: `${mcpBinding.tool.name} ${call.function.arguments}`.trim(),
              reason: `MCP 服务「${mcpBinding.server.name}」的工具将在本机执行。`,
              pattern: `mcp:${mcpBinding.server.id}:${mcpBinding.tool.name}`,
            },
            approvalHost,
          );
          result = approval.approved
            ? await callMcpTool(
                cachePath,
                mcpBinding.server.id,
                mcpBinding.tool.name,
                call.function.arguments,
              )
            : {
                ok: false,
                output: approval.expired ? "审批等待超时，该 MCP 工具已跳过。" : "用户拒绝执行该 MCP 工具。",
              };
        } else if (isControl) {
          // 视觉闭环的前置校验：模型不吃图就别白跑一次截图，直接给出替代做法
          const wantsImage = tool === SCREENSHOT_TOOL_NAME
            || (tool === BROWSER_CDP_TOOL_NAME && cdpAction === "screenshot");
          if (wantsImage && !config.supportsImages) {
            result = {
              ok: false,
              output:
                "当前模型不支持图像输入，截图无法回灌给它。请改用 browser_cdp 的 eval / console 或 browser_script 的 eval 读取页面数据。",
            };
          } else {
            // 浏览器与电脑操作统一进入审批闸门；只读判定仅用于说明操作内容。
            const readOnly = isReadOnlyControlCall(tool, call.function.arguments);
            const approval = await requestApproval(
              {
                command: controlTarget ? `${tool} ${controlTarget}`.trim() : tool,
                reason: readOnly
                  ? "该操作只读取本机浏览器状态，不改变页面内容。"
                  : "该操作会在本机浏览器或系统上产生真实副作用，需要你确认。",
                pattern: `control:${tool}${cdpAction ? `:${cdpAction}` : ""}`,
              },
              approvalHost,
            );
            if (!approval.approved) {
              result = {
                ok: false,
                output: approval.expired
                  ? "审批等待超时，该自动化操作已跳过。"
                  : "用户拒绝执行该自动化操作。",
              };
            } else {
              const controlled = await runControlTool(tool, call.function.arguments, {
                artifactDir,
                signal: controller.signal,
                approve: async (description) => {
                  if (controller.signal.aborted) return false;
                  const decision = await requestApproval({ command: description, reason: "电脑操作助手下一步动作，截图将交给配置的视觉模型验证。", pattern: "control:computer_assistant:step" }, approvalHost);
                  return decision.approved && !controller.signal.aborted;
                },
              });
              result = controlled;
              // 截图既刷新右栏产物让用户看到同一屏，也通过下方统一通路回灌给模型
              if (controlled.name) {
                const state = useAppStore.getState();
                await state.loadArtifacts();
                if (isActiveThread(threadId)) {
                  await state.selectArtifact(controlled.name);
                  state.setRightTab("media");
                }
              }
            }
          }
        } else if (isVision) {
          // 视觉工具只读本地产物 / 抓取当前视图，没有本机副作用，因此不经过审批闸门
          result = await runVisionTool(artifactDir, tool, call.function.arguments);
        } else if (isCv) {
          // 本地 CV 同样只读产物、只在本机算，没有副作用，因此不经过审批闸门
          result = await runCvTool(artifactDir, tool, call.function.arguments);
          const overlayName = result.images?.[0]?.name;
          if (result.ok && overlayName) {
            // 画框图是新产物：刷新列表并（仅当前会话）切到「图片」tab，让用户立刻看到结果
            const state = useAppStore.getState();
            await state.loadArtifacts();
            if (isActiveThread(threadId)) {
              await state.selectArtifact(overlayName);
              state.setRightTab("media");
            }
          }
        } else if (isSsh) {
          // 项目绑定收口：模型可能照着上下文里的旧提示、或凭记忆点名一台没绑定到本项目的主机。
          // 这里硬拦截——连审批卡都不弹，否则用户面对一张写着陌生机器名的卡片，很容易误批
          const host = sshHosts.find((item) => item.id === sshCall?.hostId);
          if (!host) {
            result = {
              ok: false,
              output:
                `主机 ${sshCall?.hostId || "未指定"} 未绑定到当前项目，该远程操作已拒绝。` +
                "请改用系统提示中列出的主机 id；确需访问这台主机时，请在「项目管理」中编辑该项目并绑定它。",
            };
          } else {
            // 执行限制提示词在审批之前取：用户拒绝时也要把红线回灌，
            // 否则模型只看到一句「用户拒绝」，下一轮照样换个写法重试
            sshGuardHint = buildSshGuardHint(host);
            // 远程命令在真实服务器上执行，可能产生不可逆后果，
            // 不传静态 allow，让审批闸门按会话权限决定是否需要人工确认。
            const hostLabel = `${host.name}（${host.username}@${host.host}:${host.port}）`;
            const approval = await requestApproval(
              {
                command: [sshCall?.title, sshCall?.command].filter(Boolean).join(" ").trim(),
                reason: `该操作会在远程 Linux 主机 ${hostLabel} 上真实执行，可能产生不可逆的运维后果。`,
                pattern: `ssh:${host.id}:${tool}`,
              },
              approvalHost,
            );
            result = approval.approved
              ? await runSshTool(cachePath, tool, call.function.arguments)
              : {
                  ok: false,
                  output: approval.expired
                    ? "审批等待超时，该远程操作已跳过。"
                    : "用户拒绝执行该远程操作。",
                };
          }
        } else {
          result = { ok: false, output: `当前不支持的工具：${tool}` };
        }

        // 工具产出的图片统一回灌：控制类截图、视觉工具、CV 画框图都走这一条通路。
        // 模型不吃图就不塞：塞进去只会被服务端以「不支持图像输入」拒绝整轮请求。
        if (config.supportsImages) collectToolImages(result, pendingImages);
        // 回灌给模型的文本 = 执行结果 + 该主机的执行限制。卡片只看 output（保持原样），
        // 模型历史回放取 result（见 buildHistory），所以限制词写进 result 就能跨轮次、
        // 跨重开会话持续生效，而不会把这段提示混进用户看到的命令输出里
        const modelOutput =
          sshGuardHint.length > 0 ? `${result.output}\n\n${sshGuardHint}` : result.output;
        if (!controller.signal.aborted) {
          patch(itemId, (item) =>
            item.type === "tool_call"
              ? {
                  ...item,
                  status: result.ok ? "success" : "error",
                  output: preview(result.output),
                  durationMs: Date.now() - startedAt,
                  // 完整结果另存一份：output 只按展示需要截断，回填给模型要用原文
                  result: modelOutput,
                }
              : item,
          );
        }
        return { role: "tool", tool_call_id: call.id, content: modelOutput };
}
