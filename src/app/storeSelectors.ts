/** Zustand 只读选择器（开发者 Jan）。 */
import type { AppStore } from "./storeTypes";
import type { AgentItem, ContextEntry, Message, McpServer, RemoteModel, SkillItem, SourceItem, SshHost, Thread } from "./types";
import type { ModelConnection } from "./desktop/connectionTypes";
import type { ChatTool } from "../model/client";
import { resolveSupportsImages } from "../model/visionCapability";

/**
 * 由选中的授权模型派生当前连接信息（`modelConfig`）。
 *
 * 放在选择器文件而不是 store.ts：选择器与 store 是单向依赖
 * （store 引 selectors，selectors 不得反向 import store，否则成环）。
 * `visionModelId` 在 `/api/client/models` 里没有对应
 * 字段，因此留空，专用视觉模型留待后续，
 * 不做任何按模型 code 猜测的映射。
 *
 * `supportsImages` 走 `resolveSupportsImages`：接口下发优先，缺失时用手动开关。
 */
export function connectionFromModel(model: RemoteModel, manualImageInput: boolean): ModelConnection {
  return {
    url: model.baseUrl,
    key: model.apiKey,
    modelId: model.code,
    supportsImages: resolveSupportsImages(model, manualImageInput),
    visionModelId: "",
  };
}

/** 选择当前活动会话，供侧栏与消息区共享同一引用（开发者 Jan）。 */
export function selectActiveThread(state: AppStore): Thread | undefined {
  return state.threads.find((thread) => thread.id === state.activeThreadId);
}

/**
 * 空消息列表的共享常量（开发者 Jan）。
 *
 * 选择器会被 zustand v5 交给 `useSyncExternalStore` 比较引用：如果每次返回新数组，
 * 组件会被判定为「快照一直在变」而无限重渲染（React 报 `Maximum update depth exceeded`）。
 * 当前会话还没有消息、或根本没有选中任务时都走这个常量，保证引用稳定。
 */
export const EMPTY_MESSAGES: Message[] = [];

/**
 * 取当前会话的消息列表（开发者 Jan）。
 *
 * 未选中会话时返回共享的空数组常量，保证引用稳定：
 * zustand v5 用 useSyncExternalStore 比较快照引用，每次返回新数组会导致组件无限重渲染。
 */
export function selectActiveMessages(state: AppStore): Message[] {
  return state.messages[state.activeThreadId] ?? EMPTY_MESSAGES;
}

/**
 * 指定会话的附加上下文（引用稳定）。
 *
 * 附加上下文随会话存放，取用一律走这里：界面拿「当前会话」的用于展示，
 * 运行时拿「本次运行所属会话」的用于注入——定时任务在后台跑时两者并不相同，
 * 因此保留按 id 取的那一层，而不是只有「当前会话」一个入口。
 */
export const EMPTY_CONTEXT_ENTRIES: ContextEntry[] = [];

/**
 * 取指定会话的附加上下文（开发者 Jan）。
 *
 * 按 id 取而不是只提供「当前会话」入口：定时任务在后台运行时，
 * 本次运行所属的会话未必是界面上当前选中的那个，运行时必须能精确取到自己的那份。
 */
export function selectThreadContextEntries(state: AppStore, threadId: string): ContextEntry[] {
  const thread = state.threads.find((item) => item.id === threadId);
  return thread?.contextEntries ?? EMPTY_CONTEXT_ENTRIES;
}

/** 当前会话的附加上下文：供输入区展示已附加的项 */
export function selectActiveContextEntries(state: AppStore): ContextEntry[] {
  return selectThreadContextEntries(state, state.activeThreadId);
}

/**
 * 指定会话检索到的来源（引用稳定）。
 *
 * 与附加上下文同理：来源随会话存放，取用一律走这里——界面拿「当前会话」的用于展示，
 * 运行时按「本次运行所属会话」写入，定时任务在后台跑时两者并不相同，
 * 因此保留按 id 取的那一层，而不是只有「当前会话」一个入口。
 */
export const EMPTY_SOURCES: SourceItem[] = [];

/**
 * 取指定会话检索到的来源（开发者 Jan）。
 *
 * 与附加上下文同理按 id 取：界面展示用「当前会话」那份，
 * 运行时的写入则按「本次运行所属会话」，定时任务在后台跑时两者并不相同。
 */
export function selectThreadSources(state: AppStore, threadId: string): SourceItem[] {
  const thread = state.threads.find((item) => item.id === threadId);
  return thread?.sources ?? EMPTY_SOURCES;
}

/** 当前会话检索到的来源：供右栏「来源」tab 展示与顶栏判断是否显示该 tab */
export function selectActiveSources(state: AppStore): SourceItem[] {
  return selectThreadSources(state, state.activeThreadId);
}

/** 已启用的技能：供系统消息注入与斜杠菜单使用 */
export function selectEnabledSkills(state: AppStore): SkillItem[] {
  return state.skills.filter((skill) => !state.disabledSkillIds.includes(skill.id));
}

/**
 * 过滤掉用户停用的内置工具（开发者 Jan）。
 *
 * 在工具表挂载前统一收口：`disabledToolIds` 里存的是工具函数名，命中即摘掉。
 * 只作用于内置工具——MCP 工具在各自页面启停，名字空间也不会冲突（MCP 带 `mcp_` 前缀）。
 */
export function filterDisabledTools(state: AppStore, tools: ChatTool[]): ChatTool[] {
  if (state.disabledToolIds.length === 0) return tools;
  return tools.filter((tool) => !state.disabledToolIds.includes(tool.function.name));
}

/**
 * 按 id 取一个 Agent（开发者 Jan）；找不到返回 null。
 *
 * 会话或自动化绑定的 Agent 可能已被删除，运行收口与界面都必须容忍 null，退回普通会话行为。
 */
export function selectAgentById(state: AppStore, id: string | null): AgentItem | null {
  if (!id) return null;
  return state.agents.find((agent) => agent.id === id) ?? null;
}

/**
 * 按模型 code 派生连接信息（开发者 Jan）；没有对应授权模型时返回 null。
 *
 * Agent 指定了模型时由运行收口用它覆写会话连接：命中授权列表才切换，找不到就退回会话原连接，
 * 避免绑定了一个已被下线的模型后整轮运行无从发起。
 */
export function selectModelConnectionByCode(
  state: AppStore,
  code: string | null | undefined,
): ModelConnection | null {
  if (!code) return null;
  const model = state.remoteModels.find((item) => item.code === code);
  return model ? connectionFromModel(model, state.imageInputEnabled) : null;
}

/** 已启用的 MCP 服务：其工具会被包装成模型可调用的函数 */
export function selectEnabledMcpServers(state: AppStore): McpServer[] {
  return state.mcpServers.filter((server) => server.enabled);
}

/**
 * 某项目下实际可用的技能（开发者 Jan）：全局已启用 ∩ 项目绑定白名单。
 *
 * **严格白名单**：项目存在时，`skillIds` 为空即「本项目不使用任何技能」，返回空集合。
 * 旧语义是「空 = 全部已启用」，但那样用户一个都没勾，模型照样能读技能——绑定形同虚设。
 * 独立会话（`projectId` 为空串或项目已删）取不到项目，退回全部已启用技能：
 * 项目绑定只约束项目会话，不给无归属会话增加额外限制。
 * 绑定始终不会启用一个全局停用的技能——与 Agent 工具白名单一样「只收窄不放开」。
 */
export function selectProjectScopedSkills(state: AppStore, projectId: string): SkillItem[] {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return selectEnabledSkills(state);
  return selectEnabledSkills(state).filter((skill) => project.skillIds.includes(skill.id));
}

/**
 * 某项目下实际可用的 MCP 服务（开发者 Jan）：全局已启用 ∩ 项目绑定白名单，语义同上。
 *
 * `mcpIds` 为空即「本项目不使用任何 MCP」：不挂载工具、不写进系统提示。运行期同样安全——
 * 未挂载的工具在 `findMcpBinding` 里取不到绑定，模型凭旧上下文点名只会收到「不支持的工具」。
 */
export function selectProjectScopedMcpServers(state: AppStore, projectId: string): McpServer[] {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return selectEnabledMcpServers(state);
  return selectEnabledMcpServers(state).filter((server) => project.mcpIds.includes(server.id));
}

/** 已启用的远程主机：只有启用的主机才会把 SSH 工具挂给模型 */
export function selectEnabledSshHosts(state: AppStore): SshHost[] {
  return state.sshHosts.filter((host) => host.enabled);
}

/**
 * 某项目下实际可用的远程主机（开发者 Jan）：全局已启用 ∩ 项目绑定白名单，语义同 MCP / 技能。
 *
 * `sshHostIds` 为空即「本项目不使用任何远程主机」：SSH 工具不挂载，系统提示里也不列主机。
 * 独立会话（`projectId` 为空串）找不到项目，自然退回全部已启用主机。
 */
export function selectProjectScopedSshHosts(state: AppStore, projectId: string): SshHost[] {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return selectEnabledSshHosts(state);
  return selectEnabledSshHosts(state).filter((host) => project.sshHostIds.includes(host.id));
}

/** 把 token 数格式化成便于阅读的紧凑写法（1000 以上折成 k） */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

