
import { prepareArtifactDir } from "../app/desktop/artifacts";
import { isDesktopRuntime } from "../app/desktop/runtime";
import {
  permissionModeOf,
  type ApprovalHost,
} from "../approval/gate";
import { nextId } from "../app/ids";
import { artifactGitignoreEntry, effectiveArtifactDir } from "../app/state/artifacts";
import { effectiveWorkspacePath } from "../app/state/workspace";
import { filterDisabledTools, selectAgentById, selectModelConnectionByCode, selectProjectScopedMcpServers, selectProjectScopedSkills, selectProjectScopedSshHosts, selectThreadContextEntries } from "../app/storeSelectors";
import { useAppStore } from "../app/state";
import type {
  ExecutionDetails,
  MessageAttachment,
  RunStopReason,
  StreamItem,
} from "../app/types";
import { logCacheEvent } from "../cache/logger";
import { saveStoredConversation } from "../cache/sessionRepository";
import { toStoredConversation } from "../cache/sessionDb";
import { prepareRegeneration } from "../conversation/answerVersions";
import { buildContextMessage } from "../context/attach";
import {
  estimateChatMessageTokens,
  estimateChatMessagesTokens,
  planConversationPrune,
  planFoldCount,
  pruneConversationForEmergency,
  requestContextSummary,
  truncateToolOutput,
} from "../context/compact";
import { buildProjectRulesMessage } from "../context/rules";
import { resolveToolFilter } from "../agents/toolWhitelist";
import {
  streamChatCompletion,
  effortToReasoning,
  type ChatContentPart,
  type ChatMessage,
  type ChatTool,
  type ModelTraceSink,
  type ToolCall,
} from "../model/client";
import { closeModelTraces, createModelTrace } from "../model/trace";
import { createConversationPreparer, filterToolHint } from "../tools/conversationHints";
import { applyExecutionEvent, finishExecution } from "../conversation/executionDetails";
import {
  buildMcpBindings,
  buildMcpToolHint,
} from "../mcp/tool";
import {
  buildBoundSkillsHint,
  buildSkillHint,
  buildSkillInstruction,
  buildSkillToolWarning,
  parseSkillInvocation,
  type SkillToolScope,
} from "../skills/invoke";
import { READ_SKILL_TOOL, READ_SKILL_TOOL_NAME } from "../skills/tool";
import { ASK_USER_TOOL, ASK_USER_TOOL_NAME, buildAskUserHint } from "../tools/askUser";
import { CLIENT_TOOL_NAMES, buildMountedToolsHint } from "../tools/catalog";
import {
  buildControlHint,
  controlToolsForPlatform,
} from "../tools/control";
import {
  IMAGE_GEN_TOOL,
  buildImageGenHint,
} from "../tools/imageGen";
import {
  WRITE_FILE_TOOL,
  buildWriteFileHint,
} from "../tools/writeFile";
import { WEB_SEARCH_TOOL, buildWebSearchHint } from "../tools/webSearch";
import { KNOWLEDGE_SEARCH_TOOL, buildKnowledgeSearchHint } from "../tools/knowledge";
import { prefetchKnowledgeContext } from "../knowledge/retrieval";
import {
  READ_URL_TOOL,
  buildReadUrlHint,
} from "../tools/readUrl";
import {
  VISION_TOOLS,
  buildVisionToolsHint,
} from "../tools/vision";
import {
  CV_TOOLS,
  buildCvToolsHint,
} from "../tools/cv";
import {
  WORKSPACE_TOOLS,
  buildWorkspaceToolsHint,
} from "../tools/workspace";
import {
  SSH_TOOLS,
  buildSshToolsHint,
} from "../tools/ssh";
import {
  MAX_SUBAGENT_DEPTH,
  RUN_SUBAGENT_TOOL,
  RUN_SUBAGENT_TOOL_NAME,
  buildSubagentHint,
  threadDepth,
} from "../tools/subagent";

/**
 * 一次运行里最多保留几张截图回灌给模型：截图体积大，无限累积会撑爆上下文
 */
import { runToolCall } from "./agentToolCall";
import { AgentExecutionResult, AgentExecutor, buildHistory, describeStopReason, hasProducedArtifact, persistRunSnapshot, runSlot, waitForAutomationApproval, waitForCommandApproval, awaitWithAbort, pushItemInto, createApprovalMirror, subagentApprovalMirrors } from "./useAgentRunShared";
/** Agent 单轮执行器：组装上下文、调用模型并处理工具结果（开发者 Jan）。 */
export function createAgentExecutor(
  persistFinish: (threadId: string, prompt: string, status: "done" | "aborted", reason: RunStopReason) => void,
): AgentExecutor {
  const execute = async (
      threadId: string,
      prompt: string,
      attachments: MessageAttachment[],
      regenerateFrom?: string,
    ): Promise<AgentExecutionResult> => {
      try { await useAppStore.getState().ensureThreadLoaded(threadId); }
      catch (error) { return { outcome: "failed", reason: "error", message: `读取会话失败：${String(error)}` }; }
      const store = useAppStore.getState();
      // 会话绑定的 Agent：为空即普通会话，三个收口（模型 / 系统提示 / 工具集）都退回默认行为
      const thread = store.threads.find((item) => item.id === threadId) ?? null;
      if (!thread || !store.sessionsRestored || store.sessionsRestoreError) return { outcome: "aborted", reason: "userInterrupted", message: "会话不可用" };
      const controller = runSlot(threadId).abort!;
      const historyMessages = regenerateFrom ? prepareRegeneration(store.messages[threadId] ?? [], regenerateFrom).prefix : store.messages[threadId];
      const agent = selectAgentById(store, thread?.agentId ?? null);
      // 模型收口：Agent 指定了模型且命中授权列表时才覆写，否则沿用会话当前连接
      const requestedModel = agent?.model || store.modelConfig?.modelId || null;
      const agentConnection = agent?.model ? selectModelConnectionByCode(store, agent.model) : null;
      const config = agentConnection ?? store.modelConfig;
      const fallbackReason = agent?.model && !agentConnection
        ? "Agent 指定模型不可用，回退到会话模型"
        : thread.agentId && !agent ? "绑定的 Agent 不可用，使用 default" : null;
      const cachePath = store.cachePath;
      const workspacePath = effectiveWorkspacePath(store, threadId);
      // 产物落盘目录：项目会话进项目根下的 `output/`，临时会话进缓存区的 `outputs/<会话创建日>/`。
      // 目录不存在时由 Rust 侧写入前建出来，这里只负责项目会话首次落盘时顺带补一行 `.gitignore`
      const artifactDir = effectiveArtifactDir(store, threadId);
      const gitignore = artifactGitignoreEntry(store, threadId);
      if (artifactDir) {
        // 建目录 + 写 gitignore 都是幂等的，失败不影响本轮运行（最坏情况是产物没被忽略）
        void prepareArtifactDir(artifactDir, gitignore?.file, gitignore?.entry).catch(() => undefined);
      }
      // 会话绑定的项目：项目级绑定（MCP / 技能 / 远程主机白名单）与项目提示词都以此为准；
      // 独立会话（projectId 为空）取不到项目，退回「全部已启用」，不受项目绑定约束
      const project = store.projects.find((item) => item.id === thread?.projectId) ?? null;
      // 技能：启用后给模型一个 read_skill 工具，模型先读技能目录再决定用哪个技能；
      // 用户显式调用时直接把该技能完整说明注入，无需模型自行查找。
      // 按项目收窄（严格白名单）：全局已启用 ∩ 项目绑定，项目存在且未绑定即一个都不用
      const enabledSkills = selectProjectScopedSkills(store, thread?.projectId ?? "");
      // MCP：启用服务的工具由启动时拉取并缓存在 store，运行期直接挂成模型工具。
      // 同样按项目收窄（严格白名单），项目未绑定即不挂载任何 MCP 工具
      const mcpBindings = buildMcpBindings(
        selectProjectScopedMcpServers(store, thread?.projectId ?? ""),
        store.mcpTools,
      );
      // 远程主机（SSH）：只有启用了主机才把 SSH 工具挂给模型；无可用主机时不挂，
      // 免得模型对着空主机列表反复尝试必然失败的远程调用。同样按项目收窄，未绑定即一个都不用
      const sshHosts = selectProjectScopedSshHosts(store, thread?.projectId ?? "");
      // 追问闸门：只有本轮第 0 轮、且本会话此前没写出过产物时才提供 ask_user ——
      // 执行到一半被打断、以及先产出产物再回头追问，都会让用户无所适从。
      // 子代理会话（由 run_subagent 派生）一律不挂 ask_user：委派出去的任务无人值守，
      // 需要确认时应由主代理在父会话层面提问，而不是把问题抛给一个没有用户在场的子会话。
      const isSubagentThread = Boolean(thread?.parentThreadId);
      const askUserAllowed = !isSubagentThread && !hasProducedArtifact(store.messages[threadId]);
      // 子代理委派：只有在嵌套深度上限内才挂出 run_subagent，避免无限派生
      const subagentDepth = threadDepth(store.threads, threadId);
      const canSpawnSubagent = subagentDepth < MAX_SUBAGENT_DEPTH;
      // 产物、图像、联网与浏览器/电脑自动化工具恒定可用；选中本地项目后额外开放真实工程工具
      // 图像工具恒定挂出：网关没有图像渠道时由工具本身返回可读的不可用提示，而不是静默省略
      // 自动化工具按平台过滤：非 macOS 不挂 AppleScript / 截图 / 坐标点击，否则模型会反复调用必然失败的工具
      // 用户在「工具」页停用的内置工具最后统一摘除（开发者 Jan）：只影响内置工具，
      // MCP 工具走各自页面的启停，不受这份清单约束
      const availableTools: ChatTool[] = filterDisabledTools(store, [
        WRITE_FILE_TOOL,
        IMAGE_GEN_TOOL,
        WEB_SEARCH_TOOL,
        READ_URL_TOOL,
        ...controlToolsForPlatform(),
      ]);
      // 视觉工具只在模型真的能读图时才挂出：否则抓到的画面回灌过去会被服务端拒绝
      const visionEnabled = config?.supportsImages ?? false;
      if (visionEnabled) availableTools.push(...VISION_TOOLS);
      // 本地 CV 与本机算力相关、与模型无关，因此恒定挂出：OCR 只回文本，检测的文本结果同样可用
      availableTools.push(...CV_TOOLS);
      if (workspacePath) availableTools.push(...WORKSPACE_TOOLS);
      // 本地知识库是只读能力：桌面运行且有缓存目录时挂载，工具内部再检查模型和索引状态。
      if (cachePath && isDesktopRuntime()) availableTools.push(KNOWLEDGE_SEARCH_TOOL);
      if (askUserAllowed) availableTools.unshift(ASK_USER_TOOL);
      if (enabledSkills.length > 0) availableTools.push(READ_SKILL_TOOL);
      for (const binding of mcpBindings) availableTools.push(binding.chatTool);
      if (sshHosts.length > 0) availableTools.push(...SSH_TOOLS);
      // 子代理：深度未达上限时才挂出，且必挂在工具表最前，便于模型优先考虑委派重活
      if (canSpawnSubagent) availableTools.unshift(RUN_SUBAGENT_TOOL);
      // 停用清单对后续 push 的内置工具（视觉 / CV / 工程 / 知识库 / ask_user / read_skill /
      // run_subagent / SSH）同样生效（开发者 Jan）：在白名单收口前再过滤一次，保证清单完整
      const enabledTools = filterDisabledTools(store, availableTools);
      // 工具集收口：绑定 Agent 且声明了白名单时收敛工具表；空声明或未绑定则保持全量
      const toolFilter = resolveToolFilter(agent?.tools);
      const tools = toolFilter
        ? enabledTools.filter((tool) => toolFilter(tool.function.name))
        : enabledTools;
      // 第 0 轮之外的工具表：收回 ask_user，迫使模型先推进任务而不是反复确认
      const followUpTools = tools.filter(
        (tool) => tool.function.name !== ASK_USER_TOOL_NAME,
      );
      // 提示词必须与本轮真正挂出的工具表一致（开发者 Jan）：挂载条件（有没有项目目录、模型是否
      // 支持视觉、是不是 macOS）之外，Agent 白名单还会把工具表再收窄一次。只看挂载条件就会把
      // 已被摘掉的工具写进 system——模型照着调只会收到「当前不支持的工具」，或者干脆回一句
      // 「我这边没有直接的检索工具」，再去委派一个工具表完全相同的子代理绕路。
      let skillToolScope: SkillToolScope;
      const invocation = parseSkillInvocation(prompt, enabledSkills);
      const prepareConversation = createConversationPreparer((roundTools) => {
      const mountedNames = new Set(roundTools.map((tool) => tool.function.name));
      const mountedAny = (list: ChatTool[]) =>
        list.some((tool) => mountedNames.has(tool.function.name));
      // 客户端所有可能挂出的工具名：内置工具全集 + 本轮动态挂出的 MCP 工具。
      // 供技能正文的工具名校验区分「有这个工具但本轮调不动」与「压根没这个工具」
      const knownToolNames = new Set([
        ...CLIENT_TOOL_NAMES,
        ...availableTools.map((tool) => tool.function.name),
      ]);
      skillToolScope = { mounted: mountedNames, known: knownToolNames };
      const toolHints = [
        // 清单放在最前：其余每条类别提示都只讲「这类工具怎么用」，先给模型划出「本轮到底有什么」的边界
        roundTools.length > 0 ? buildMountedToolsHint(roundTools) : "本轮没有可调用的工具，请根据已有信息给出结论，不要发起工具调用。",
        buildAskUserHint(mountedNames.has(ASK_USER_TOOL_NAME)),
        mountedAny([WRITE_FILE_TOOL]) ? buildWriteFileHint() : "",
        mountedAny([IMAGE_GEN_TOOL]) ? buildImageGenHint() : "",
        mountedAny([WEB_SEARCH_TOOL]) ? buildWebSearchHint() : "",
        mountedAny([KNOWLEDGE_SEARCH_TOOL]) ? buildKnowledgeSearchHint() : "",
        mountedAny([READ_URL_TOOL]) ? buildReadUrlHint() : "",
        mountedAny(controlToolsForPlatform()) ? buildControlHint() : "",
        buildWorkspaceToolsHint(mountedAny(WORKSPACE_TOOLS)),
        buildVisionToolsHint(mountedAny(VISION_TOOLS)),
        mountedAny(CV_TOOLS) ? buildCvToolsHint() : "",
        buildSubagentHint(mountedNames.has(RUN_SUBAGENT_TOOL_NAME)),
      ];
      for (let index = 2; index < toolHints.length; index += 1) {
        toolHints[index] = filterToolHint(toolHints[index], mountedNames, knownToolNames);
      }
      if (mountedNames.has(READ_SKILL_TOOL_NAME)) toolHints.push(buildBoundSkillsHint(enabledSkills));
      if (mountedNames.has(READ_SKILL_TOOL_NAME)) toolHints.push(buildSkillHint());
      // MCP 工具名是启动时从服务端拉取的，白名单也能只摘掉其中一部分：只把真挂上的列给模型
      const mountedMcpBindings = mcpBindings.filter((binding) =>
        mountedNames.has(binding.chatTool.function.name),
      );
      if (mountedMcpBindings.length > 0) toolHints.push(buildMcpToolHint(mountedMcpBindings));
      if (mountedAny(SSH_TOOLS)) toolHints.push(buildSshToolsHint(sshHosts));
      if (invocation) {
        toolHints.push(buildSkillInstruction(invocation.skill,
          buildSkillToolWarning(invocation.skill.body, skillToolScope), mountedNames.has(READ_SKILL_TOOL_NAME)));
      }
      return toolHints.filter(Boolean).join("\n");
      });
      // 网关只接受「单条 system 且位于最前」：两段以上 role: "system" 会直接 400
      // （System message must be at the beginning.）。因此这里先收集各段文本，
      // 用空行分隔后合并成唯一一条 system，而不是逐段 push 成多条。
      const systemParts: string[] = [];
      // 项目规则（AGENTS.md）由客户端自动发现，放在最前面，作为本工作区的最高层约定
      const rulesMessage = await buildProjectRulesMessage(workspacePath);
      if (rulesMessage) systemParts.push(rulesMessage);
      // 项目提示词：用户在创建/编辑项目时填写，作为该项目的专属约定注入，
      // 位于项目规则之后、Agent persona 之前；未填写时不注入
      const projectPrompt = project?.prompt?.trim() ?? "";
      if (projectPrompt.length > 0) systemParts.push(projectPrompt);
      // 系统提示收口：Agent 的 persona（AGENT.md 正文）追加在项目规则之后、工具说明之前，
      // 作为该 Agent 的角色设定；未绑定 Agent 或未写 persona 时不注入
      const agentPersona = agent?.systemAppend?.trim() ?? "";
      if (agentPersona.length > 0) systemParts.push(agentPersona);
      // 摘要注入位置：persona 之后、工具提示之前——历史摘要属于「角色与历史」层，
      // 不该被工具说明淹没；组装时按这个下标插进 systemParts
      const summaryInsertIndex = systemParts.length;

      // 附加上下文要现场读盘（文件 / 目录 / 网址），因此在这里等待解析完成再发请求；
      // 取的是本次运行所属会话自己的附加项，别的会话附加了什么与本轮无关
      const contextMessage = await buildContextMessage(
        selectThreadContextEntries(store, threadId),
        workspacePath,
        {
          dir: workspacePath,
          enabled: store.sandboxEnabled,
          allowNetwork: store.sandboxAllowNetwork,
        },
      );
      if (contextMessage) systemParts.push(contextMessage);

      // 显式调用时把调用标记从发给模型的内容里去掉，只保留任务描述
      const effectivePrompt = invocation ? invocation.rest : prompt;
      // 自动检索（开发者 Jan）：把「查不查知识库」从模型自觉改成客户端前置。
      // 子代理会话跳过——它的任务通常由主代理拆好，再查一次只会重复消耗本地算力与上下文。
      const knowledgeContext = isSubagentThread
        ? ""
        : await prefetchKnowledgeContext({
            cachePath,
            threadId,
            query: effectivePrompt,
            signal: controller.signal,
          });
      if (knowledgeContext) systemParts.push(knowledgeContext);
      // 上下文要在插入本轮消息之前取，避免把空的占位回复也发给模型。
      // 摘要已覆盖的前 N 条消息不再进入上下文，由注入 system 的滚动摘要代替
      const coveredCount = Math.min(
        thread?.contextCoveredCount ?? 0,
        historyMessages?.length ?? 0,
      );
      let { history, boundaries } = buildHistory(
        historyMessages,
        effectivePrompt,
        attachments,
        coveredCount,
      );
      let summaryText = coveredCount > 0 ? (thread?.contextSummary ?? "").trim() : "";
      // 网关只接受单条 system：摘要按 persona 后的下标插进 systemParts，合并成唯一一条
      const assembleConversation = (chatHistory: ChatMessage[]): ChatMessage[] => {
        const parts = [...systemParts];
        if (summaryText.length > 0) {
          parts.splice(summaryInsertIndex, 0, `【会话历史摘要】\n${summaryText}`);
        }
        const merged = parts.filter((part) => part.trim().length > 0).join("\n\n");
        return merged.length > 0 ? [{ role: "system", content: merged }, ...chatHistory] : chatHistory;
      };
      let conversation = prepareConversation(assembleConversation(history), tools);

      const runId = nextId("run");
      const traceContext = {
        scope: "agent" as const, threadId, runId,
        agentId: agent?.id ?? "default", agentName: agent?.name ?? "default",
        requestedModel: requestedModel ?? undefined, fallbackReason: fallbackReason ?? undefined,
        projectId: thread.projectId,
        model: config?.modelId,
      };
      let execution: ExecutionDetails = {
        runId, agentId: traceContext.agentId, agentName: traceContext.agentName,
        selectedAgentId: thread.agentId, requestedModel, actualModel: config?.modelId ?? null,
        fallbackReason, projectId: thread.projectId,
        outcome: "running", tools: [],
      };
      let publishExecution = () => {};
/** 函数级说明（开发者 Jan）：执行 finish 的单一职责，并返回可供调用方继续处理的结果。 */
      const finish = (id: string, text: string, status: "done" | "aborted", reason: RunStopReason) => {
        execution = finishExecution(execution, reason);
        publishExecution();
        persistFinish(id, text, status, reason);
      };
      const runTrace = createModelTrace({ ...traceContext, round: null });
      runTrace({ kind: "event", name: "run.start", data: {
        tools: tools.map((tool) => tool.function.name),
        followUpTools: followUpTools.map((tool) => tool.function.name),
        skillIds: enabledSkills.map((skill) => skill.id),
        permissionMode: permissionModeOf(threadId),
        reasoningEffort: effortToReasoning(store.effort),
        limits: { rounds: store.maxToolRounds, durationSecs: store.maxRunDurationSecs, tokens: store.maxRunTokens },
      } });
      try {
      // 开始时间由调度槽位在入队执行时写入，同一会话内的多轮共用同一个起点
      const startedAt = runSlot(threadId).startedAt || Date.now();
      persistRunSnapshot(threadId, prompt, "running", startedAt);
      logCacheEvent("agent.run.start", threadId);

      controller.signal.throwIfAborted();
      const messageId = store.startAssistantReply(threadId, prompt, attachments, regenerateFrom);
      const executionItemId = nextId("item");
      pushItemInto(threadId, messageId, { id: executionItemId, type: "execution_details", details: execution });
      publishExecution = () => {
        const state = useAppStore.getState();
        if (state.cachePath !== cachePath || !state.threads.some((item) => item.id === threadId)) return;
        state.patchItem(threadId, messageId, executionItemId, (item) => item.type === "execution_details" ? { ...item, details: execution } : item);
      };
      // 工具卡片状态随模型流同步刷新执行详情，其余事件只写转储
      const observeTrace = (sink: ModelTraceSink): ModelTraceSink => (event) => {
        sink(event);
        const next = applyExecutionEvent(execution, event);
        if (next !== execution) { execution = next; publishExecution(); }
      };

      const valid = () => !controller.signal.aborted && useAppStore.getState().cachePath === cachePath && useAppStore.getState().threads.some((t) => t.id === threadId);
/** 函数级说明（开发者 Jan）：执行 push 的单一职责，并返回可供调用方继续处理的结果。 */
      const push = (item: StreamItem) => { if (valid()) pushItemInto(threadId, messageId, item); };

      const patch = (itemId: string, updater: (item: StreamItem) => StreamItem) => {
        if (valid()) useAppStore.getState().patchItem(threadId, messageId, itemId, updater);
      };

/** 函数级说明（开发者 Jan）：执行 fail 的单一职责，并返回可供调用方继续处理的结果。 */
      const fail = (detail: string): AgentExecutionResult => {
        push({ id: nextId("item"), type: "text", text: detail, streaming: false });
        finish(threadId, prompt, "done", "error");
        logCacheEvent("agent.run.error", detail);
        return { outcome: "failed", reason: "error", message: detail };
      };

      try {
        controller.signal.throwIfAborted();
        const latest = useAppStore.getState();
        await saveStoredConversation(cachePath, toStoredConversation(latest.threads.find((t) => t.id === threadId) ?? thread, latest.messages[threadId] ?? []));
        controller.signal.throwIfAborted();
      } catch (error) {
        if (controller.signal.aborted) return { outcome: "aborted", reason: "userInterrupted", message: "" };
        return fail(`消息尚未保存，已暂停请求模型：${error instanceof Error ? error.message : String(error)}。请先重试保存。`);
      }
      if (!config) {
        return fail("未获取到模型连接信息，请在设置页「本地模型配置」里检查 models.json 后重试。");
      }

      // 请求与用量记录统一用「模型标识」：`store.model` 只是本地条目的选择键，不是网关认识的模型名
      const model = config.modelId;

      // 上下文自动压缩：估算总量超过阈值就把最旧的若干条消息折叠进滚动摘要（开发者 Jan）。
      // 触发点放在请求循环之前：model / config / controller / push 都已就绪，摘要请求与本次
      // 运行共用同一个中断信号——用户点停止，摘要请求也一并中止。阈值 0 表示关闭该功能。
      const compactThreshold = store.contextCompactThresholdTokens;
      if (compactThreshold > 0) {
        const totalTokens = estimateChatMessagesTokens(conversation);
        // 保留预算取阈值的 60%：压缩后要给本轮回复与后续工具往返留余量，
        // 避免压完正好贴着阈值、下一轮又立刻触发压缩
        const fold =
          totalTokens > compactThreshold
            ? planFoldCount(
                boundaries,
                history.map(estimateChatMessageTokens),
                Math.floor(compactThreshold * 0.6),
              )
            : 0;
        if (fold > 0) {
          try {
            const summary = await requestContextSummary({
              url: config.url,
              key: config.key,
              model,
              previousSummary: summaryText,
              folded: history.slice(0, boundaries[fold]),
              signal: controller.signal,
            });
            if (summary.trim().length > 0) {
              const nextCovered = coveredCount + fold;
              useAppStore.getState().setThreadContextSummary(threadId, summary.trim(), nextCovered);
              summaryText = summary.trim();
              // 用新覆盖数重建上下文：被折叠的消息退出，摘要换成本次生成的版本
              const rebuilt = buildHistory(
                historyMessages,
                effectivePrompt,
                attachments,
                nextCovered,
              );
              history = rebuilt.history;
              boundaries = rebuilt.boundaries;
              conversation = prepareConversation(assembleConversation(history), tools);
              push({
                id: nextId("item"),
                type: "notice",
                tone: "info",
                text: `上下文超过压缩阈值（${compactThreshold} token），已自动压缩：最旧的 ${fold} 条消息折叠进摘要。`,
              });
              logCacheEvent(
                "agent.context.compact",
                `thread=${threadId} folded=${fold} covered=${nextCovered}`,
              );
            } else {
              // 摘要为空按「无有效输出」处理：本轮照常不压缩发请求，不因此打断会话
              logCacheEvent("agent.context.compact.skip", "摘要输出为空，跳过本次压缩");
            }
          } catch (error) {
            if (controller.signal.aborted) {
              finish(threadId, prompt, "aborted", "userInterrupted");
              logCacheEvent("agent.run.aborted", threadId);
              return { outcome: "aborted", reason: "userInterrupted", message: "" };
            }
            // 压缩失败不阻断本轮：照常发请求，真超了窗口由网关返回可读错误
            logCacheEvent(
              "agent.context.compact.error",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }

      // 每轮的内容块 id 与开关状态；放在循环外以便异常时统一收尾
      let reasoningId = nextId("item");
      let answerId = nextId("item");
      let reasoningOpen = false;
      let answerOpen = false;
      let producedAny = false;
      /**
       * 待回灌的截图。
       *
       * 截图的 base64 不写进 tool 角色的文本里（体积大且 tool role 的数组 content 支持度未知），
       * 而是攒在下一条请求的**用户侧**多模态片段上，复用与「用户粘贴图片」完全相同的通路。
       */
      const pendingImages: ChatContentPart[] = [];
      const renderedCheckpoints = new Set<string>();
      /** 审批闸门的运行期接口：卡片渲染与等待复用本轮的 push / patch / 中断控制器 */
      const mirrorRootId = subagentApprovalMirrors.get(threadId) ?? null;
      const approvalHost: ApprovalHost = {
        threadId,
        push,
        patch,
        // 本轮跑的是子会话：人工审批卡片同时镜像进最外层可见会话，否则卡片落在看不见的子会话里，
        // 没人能点选，子代理会一直挂在等待上
        ...(mirrorRootId ? { mirror: createApprovalMirror(threadId, mirrorRootId) } : {}),
        wait: (itemId) => {
          // 自动化来源没有人在场，等待必须带上限，否则 run 不结束、Rust 侧 in-flight 永不释放
          const runSource = runSlot(threadId).active?.source ?? "user";
          return runSource === "automation"
            ? waitForAutomationApproval(itemId, controller.signal)
            : waitForCommandApproval(itemId, controller.signal);
        },
      };
      /** 本轮是否已成功把追问抛给用户；为 true 时本轮立即结束 */
      let askPending = false;
      /**
       * 服务端返回的 token 用量累计。
       *
       * 一次运行可能因为工具调用产生多轮请求，每轮都会重发上下文，因此这里按轮累加而不是
       * 只取最后一轮；服务端不返回用量时 `usageRounds` 保持 0，界面上就不展示，不做本地估算。
       */
      const runUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
      let usageRounds = 0;
      const threadProjectId =
        store.threads.find((item) => item.id === threadId)?.projectId ?? "";

      /** 把本轮运行的用量推到会话里并落库；没有服务端数据时什么都不做 */
      const flushUsage = async () => {
        if (usageRounds === 0) return;
        push({ id: nextId("item"), type: "usage", model, usage: { ...runUsage }, rounds: usageRounds });
        await useAppStore.getState().recordRunUsage({
          id: runId,
          conversationId: threadId,
          projectId: threadProjectId,
          model,
          createdAt: Math.floor(startedAt / 1000),
          ...runUsage,
        });
      };

      /** 收尾当前轮未完成的思考块与正文块（中断与失败都要去掉进行中标记） */
      const closeBlocks = () => {
        const state = useAppStore.getState();
        if (state.cachePath !== cachePath || !state.threads.some((t) => t.id === threadId)) return;
        if (reasoningOpen) {
          state.patchItem(threadId, messageId, reasoningId, (item) => (item.type === "reasoning" ? { ...item, done: true } : item));
        }
        if (answerOpen) {
          state.patchItem(threadId, messageId, answerId, (item) => (item.type === "text" ? { ...item, streaming: false } : item));
        }
      };

      /** 执行一次工具调用，渲染工具卡片并把结果回填到上下文 */
      const executeToolCall = async (call: ToolCall): Promise<ChatMessage> => {
        const state = { producedAny, askPending };
        const result = await runToolCall(call, {
          controller, valid, push, state, canSpawnSubagent, threadId, threadProjectId, thread, execute,
          patch, mcpBindings, cachePath, skillToolScope, artifactDir, config, store,
          approvalHost, workspacePath, renderedCheckpoints, sshHosts, pendingImages, runId, model,
          nextId,
        });
        producedAny = state.producedAny;
        askPending = state.askPending;
        // 工具输出源头截断（对齐 Codex tool_output_token_limit 思路）：读大文件 / 大 diff 的
        // 结果在进入对话之前就按上限留首尾，撑爆窗口的事后压缩远比源头截断昂贵。
        // 只处理纯文本结果；占位失败文本等短内容原样通过，数组内容（截图回灌）不经此路。
        if (typeof result.content === "string") {
          return { ...result, content: truncateToolOutput(result.content) };
        }
        return result;
      };

      const maxToolRounds = store.maxToolRounds;
      const maxRunDurationSecs = store.maxRunDurationSecs;
      const maxRunTokens = store.maxRunTokens;
      const limits = { rounds: maxToolRounds, durationSecs: maxRunDurationSecs, tokens: maxRunTokens };
      /** 模型请求失败后的自动重试次数：0 表示关闭重试，失败立即终止任务 */
      const maxModelRetries = Math.max(0, Math.floor(store.modelRetryCount ?? 0));
      /** 本次运行的结束原因；被上限截停或出错时在下方改写 */
      let stopReason: RunStopReason = "completed";

      try {
        for (let round = 0; ; round += 1) {
          // 预算检查与 CLI 的 LoopPolicy 同构：时长 / token 用尽即停止本次运行并说明原因。
          // 旧版到第 4 轮就不再挂工具并静默记为成功，用户只看到会话莫名其妙停下。
          // 两个上限的 0 都表示不限，因此 0 时整条检查跳过，不能落成「立刻超预算」
          if (maxRunDurationSecs > 0 && Date.now() - startedAt >= maxRunDurationSecs * 1000) {
            stopReason = "timeBudget";
            break;
          }
          if (maxRunTokens !== null && runUsage.totalTokens >= maxRunTokens) {
            stopReason = "tokenBudget";
            break;
          }
          // 达到轮数上限后不再提供工具，迫使模型给出最终结论；轮数不限时永远不进入强制结论轮
          const lastRound = maxToolRounds > 0 && round >= maxToolRounds;
          reasoningId = nextId("item");
          answerId = nextId("item");
          reasoningOpen = false;
          answerOpen = false;
          let roundText = "";
          const roundTools = lastRound ? [] : round === 0 ? tools : followUpTools;
          conversation = prepareConversation(conversation, roundTools);

          // 上一轮若有截图，作为独立的用户侧消息带上：模型据此「看」到最新画面再决定下一步
          if (pendingImages.length > 0) {
            conversation.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text: "以下是工具最新产出的画面（屏幕/网页截图、3D 视图或检测画框图），请根据画面判断当前状态并决定下一步操作。",
                },
                ...pendingImages,
              ],
            });
            pendingImages.length = 0;
          }

          // 每轮发送前的巡检压缩（对齐 Codex auto_compact_limit 思路）：运行开始时那段压缩
          // 覆盖不到运行中追加的工具输出，超窗 400 往往就是它们撑出来的。这里按同一阈值做
          // 就地「摘要 + 折叠」：先给将被丢弃的区间生成摘要（失败退化为无摘要折叠，不打断
          // 运行），再按协议配对单元原地替换。轮 0 已由运行开始的压缩覆盖，不重复检查。
          if (round > 0 && compactThreshold > 0) {
            const totalTokens = estimateChatMessagesTokens(conversation);
            if (totalTokens > compactThreshold) {
              // 保留预算与运行开始保持同一口径：阈值的 60%
              const keepBudget = Math.floor(compactThreshold * 0.6);
              const plan = planConversationPrune(conversation, keepBudget);
              if (plan) {
                const folded = conversation.slice(plan.dropFrom, plan.dropUntil);
                let midSummary = "";
                try {
                  midSummary = await requestContextSummary({
                    url: config.url,
                    key: config.key,
                    model,
                    previousSummary: summaryText,
                    folded,
                    signal: controller.signal,
                  });
                } catch (error) {
                  if (controller.signal.aborted) {
                    finish(threadId, prompt, "aborted", "userInterrupted");
                    logCacheEvent("agent.run.aborted", threadId);
                    return { outcome: "aborted", reason: "userInterrupted", message: "" };
                  }
                  // 摘要请求失败不阻断运行：退化为无摘要的紧急折叠
                  logCacheEvent(
                    "agent.context.compact.error",
                    error instanceof Error ? error.message : String(error),
                  );
                }
                const pruned = pruneConversationForEmergency(conversation, keepBudget, midSummary);
                if (pruned > 0) {
                  push({
                    id: nextId("item"),
                    type: "notice",
                    tone: "info",
                    text: `上下文逼近压缩阈值（${compactThreshold} token），已就地压缩：较早的 ${pruned} 条消息${midSummary.trim().length > 0 ? "折叠进摘要" : "被省略"}，本轮继续。`,
                  });
                  logCacheEvent(
                    "agent.context.compact.midrun",
                    `thread=${threadId} round=${round} pruned=${pruned}`,
                  );
                }
              }
            }
          }

          // 模型请求自动重试：网络抖动、网关瞬时 5xx 这类失败不直接终止任务，
          // 按指数退避（1s → 2s → 4s…上限 8s）重新发起。用户主动停止（abort）不重试；
          // 每次重试前把本轮已流出的半截内容原地清空，避免重拉后文本叠加重影。
          const sleepWithAbort = (ms: number) =>
            new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                reject(controller.signal.reason);
              };
              const timer = setTimeout(() => {
                controller.signal.removeEventListener("abort", onAbort);
                resolve();
              }, ms);
              controller.signal.addEventListener("abort", onAbort, { once: true });
            });
          const sendRound = () =>
            streamChatCompletion({
              url: config.url,
              key: config.key,
              model,
              reasoningEffort: effortToReasoning(store.effort),
              messages: conversation,
              tools: lastRound ? undefined : roundTools,
              signal: controller.signal,
              // 转储按轮创建：同一 runId 写进同一个文件，轮次记进每一行便于对齐
              trace: observeTrace(createModelTrace({ ...traceContext, round })),
              onDelta: ({ reasoning, content }) => {
                if (reasoning.length > 0) {
                  if (!reasoningOpen) {
                    reasoningOpen = true;
                    push({ id: reasoningId, type: "reasoning", text: "", done: false });
                  }
                  producedAny = true;
                  patch(reasoningId, (item) =>
                    item.type === "reasoning" ? { ...item, text: item.text + reasoning } : item,
                  );
                }
                if (content.length > 0) {
                  if (!answerOpen) {
                    answerOpen = true;
                    // 正文开始输出，说明思考阶段已结束
                    if (reasoningOpen) {
                      patch(reasoningId, (item) =>
                        item.type === "reasoning" ? { ...item, done: true } : item,
                      );
                    }
                    push({ id: answerId, type: "text", text: "", streaming: true });
                  }
                  producedAny = true;
                  roundText += content;
                  patch(answerId, (item) =>
                    item.type === "text" ? { ...item, text: item.text + content } : item,
                  );
                }
              },
            });
          let result: Awaited<ReturnType<typeof sendRound>>;
          let retryAttempt = 0;
          /** 上下文超窗的就地精简次数：给上限防止「精简 → 仍超 → 再精简」无限循环 */
          let contextRescues = 0;
          /** 清空本轮已流出的半截内容：重试 / 精简重发前都要做，避免文本重影 */
          const clearPartialRound = () => {
            if (reasoningOpen) {
              patch(reasoningId, (item) =>
                item.type === "reasoning" ? { ...item, text: "", done: false } : item,
              );
            }
            if (answerOpen) {
              patch(answerId, (item) =>
                item.type === "text" ? { ...item, text: "", streaming: true } : item,
              );
            }
            roundText = "";
          };
          for (;;) {
            try {
              result = await sendRound();
              break;
            } catch (error) {
              if (controller.signal.aborted) throw error;
              const detail = error instanceof Error ? error.message : String(error);
              // 上下文超窗是确定性错误，盲重试永远不会成功：先就地精简再重发。
              // 精简不消耗普通重试次数，但本身有上限；压缩功能关闭时没有预算可用，直接落失败。
              const contextBlown = /context_length_exceeded|exceeds the context|context window/i.test(detail);
              if (contextBlown && compactThreshold > 0 && contextRescues < 2) {
                contextRescues += 1;
                const pruned = pruneConversationForEmergency(
                  conversation,
                  Math.floor(compactThreshold * 0.6),
                );
                if (pruned > 0) {
                  push({
                    id: nextId("item"),
                    type: "notice",
                    tone: "warn",
                    text: `上下文超出模型窗口，已就地精简：省略更早的 ${pruned} 条消息，正在重试。`,
                  });
                  clearPartialRound();
                  continue;
                }
              }
              if (retryAttempt >= maxModelRetries) throw error;
              retryAttempt += 1;
              push({
                id: nextId("item"),
                type: "notice",
                tone: "warn",
                text: `模型请求失败，自动重试（第 ${retryAttempt}/${maxModelRetries} 次）：${detail}`,
              });
              clearPartialRound();
              await sleepWithAbort(Math.min(1000 * 2 ** (retryAttempt - 1), 8000));
            }
          }

          closeBlocks();
          if (result.usage) {
            usageRounds += 1;
            runUsage.promptTokens += result.usage.promptTokens;
            runUsage.completionTokens += result.usage.completionTokens;
            runUsage.reasoningTokens += result.usage.reasoningTokens;
            runUsage.totalTokens += result.usage.totalTokens;
          }
          if (controller.signal.aborted) {
            finish(threadId, prompt, "aborted", "userInterrupted");
            logCacheEvent("agent.run.aborted", threadId);
            return { outcome: "aborted", reason: "userInterrupted", message: "" };
          }
          // 进入强制结论轮说明模型一路都还在要工具：这次运行是被轮数上限截停的
          if (lastRound) {
            stopReason = "maxRounds";
            break;
          }
          if (result.toolCalls.length === 0) break;

          // 需求确认优先：本轮若包含 ask_user，只处理追问、同轮其他工具一律不执行；
          // 追问成功后本轮立即结束，等用户回答后再开启新一轮（回答会作为新的用户消息进来）
          const askCall = result.toolCalls.find(
            (call) => call.function.name.trim() === ASK_USER_TOOL_NAME,
          );
          if (askCall) {
            const answer = await executeToolCall(askCall);
            if (askPending) break;
            // 追问参数不合法：不结束本轮，把可读错误回填给模型让它自行纠错
            conversation.push({
              role: "assistant",
              content: roundText.length > 0 ? roundText : null,
              tool_calls: [askCall],
            });
            conversation.push(answer);
            if (controller.signal.aborted) {
              finish(threadId, prompt, "aborted", "userInterrupted");
              logCacheEvent("agent.run.aborted", threadId);
              return { outcome: "aborted", reason: "userInterrupted", message: "" };
            }
            continue;
          }

          // 记下模型这一轮的说明与工具调用，再逐个执行并把结果作为 tool 消息回填
          conversation.push({
            role: "assistant",
            content: roundText.length > 0 ? roundText : null,
            tool_calls: result.toolCalls,
          });
          for (const call of result.toolCalls) {
            // 与中断赛跑：工具调用发出去就不一定收得回（run_shell / MCP / 浏览器操作只能等它回来），
            // 用户点停止时必须立刻收尾，不能被一条慢命令或挂死的调用钉在「运行中」
            conversation.push(await awaitWithAbort(executeToolCall(call), controller.signal));
          }
          if (controller.signal.aborted) {
            finish(threadId, prompt, "aborted", "userInterrupted");
            logCacheEvent("agent.run.aborted", threadId);
            return { outcome: "aborted", reason: "userInterrupted", message: "" };
          }
        }

        // 被上限截停：明确记一条提示并把本次运行记为失败，而不是当作成功静默收尾
        if (stopReason !== "completed") {
          const message = describeStopReason(stopReason, limits);
          push({ id: nextId("item"), type: "notice", tone: "warn", text: message });
          finish(threadId, prompt, "done", stopReason);
          logCacheEvent("agent.run.stopped", `${stopReason}: ${message}`);
          return { outcome: "failed", reason: stopReason, message };
        }

        if (!producedAny) {
          return fail("模型没有返回任何内容，请重试。");
        }
        finish(threadId, prompt, "done", "completed");
        logCacheEvent("agent.run.done", threadId);
        return { outcome: "success", reason: "completed", message: "" };
      } catch (error) {
        closeBlocks();
        if (controller.signal.aborted) {
          finish(threadId, prompt, "aborted", "userInterrupted");
          logCacheEvent("agent.run.aborted", threadId);
          return { outcome: "aborted", reason: "userInterrupted", message: "" };
        }
        const detail = error instanceof Error ? error.message : String(error);
        // 上下文超窗走到这里说明精简也救不回来（或压缩功能被关闭）：给出可操作的指引而不是裸报错
        if (/context_length_exceeded|exceeds the context|context window/i.test(detail)) {
          return fail(
            "上下文超出模型窗口，自动精简后仍放不下：最近一轮的工具输出可能过大。可调低「设置 → 运行 → 压缩阈值」让它更早压缩，或为本任务换用上下文更大的模型。",
          );
        }
        const retried = maxModelRetries > 0 ? `（已自动重试 ${maxModelRetries} 次仍失败）` : "（自动重试已关闭，可在设置 → 运行中开启）";
        return fail(`模型请求失败${retried}：${detail}`);
      } finally {
        // 中断与失败也照常结算：已完成的服务端轮次是真实消耗，统计不能吞掉
        await flushUsage().catch(() => {});
        const slot = runSlot(threadId);
        if (slot.abort === controller) slot.abort = null;
      }
      } finally {
        if (execution.outcome === "running") {
          execution = finishExecution(execution, controller.signal.aborted ? "userInterrupted" : "error");
          publishExecution();
        }
        runTrace({ kind: "event", name: "run.finish", data: { aborted: execution.outcome === "aborted", outcome: execution.outcome, stopReason: execution.stopReason } });
        runTrace({ kind: "done", reason: execution.stopReason, completed: execution.outcome === "success" });
        await closeModelTraces(runId);
      }
  };
  return execute;
}

