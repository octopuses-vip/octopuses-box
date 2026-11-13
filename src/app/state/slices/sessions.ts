/** sessions 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { DEFAULT_PERMISSION_MODE } from "../../../approval/permission";
import { fromStoredConversation } from "../../../cache/sessionDb";
import { loadStoredSession, restoreStoredSessions } from "../../../cache/sessionRepository";
import { prepareRegeneration } from "../../../conversation/answerVersions";
import { isStandaloneThread, STANDALONE_PROJECT_ID } from "../../../project/projects";
import { readCacheFile } from "../../desktop/cache";
import { createGitWorktree, removeGitWorktree } from "../../desktop/git";
import { nextId } from "../../ids";
import { type Thread, type Message } from "../../types";
import { parseCachedProjects, PROJECTS_FILE, persistProjects, resolveProjectId } from "../projects";
import {
  loadingSessions,
  loadLegacyConversations,
  NEW_SESSION_TITLE,
  NEW_TASK_TITLE,
  userMessage,
} from "../sessions";

export const createSessionsSlice: StoreSlice<
  | "threads"
  | "activeThreadId"
  | "messages"
  | "threadRunStates"
  | "setThreadRunState"
  | "sessionsRestored"
  | "sessionsRestoring"
  | "sessionLoadErrors"
  | "sessionNotices"
  | "ensureThreadLoaded"
  | "sessionsRestoreError"
  | "restoreSessions"
  | "openThread"
  | "newChat"
  | "newTaskInProject"
  | "createThread"
  | "startAssistantReply"
  | "patchItem"
  | "rewindThreadTo"
  | "renameThread"
  | "deleteThread"
  | "setThreadWorkspace"
  | "setThreadPermissionMode"
  | "setThreadAgent"
  | "setThreadExecutionContext"
  | "setThreadContextSummary"
  | "createThreadWorktree"
  | "removeThreadWorktree"
  | "addReviewComment"
  | "resolveReviewComment"
  | "deleteReviewComment"
> = (set, get) => ({
  threads: [],

  activeThreadId: "",

  messages: {},

  threadRunStates: {},

  setThreadRunState: (threadId, state) =>
    set((current) => ({
      threadRunStates: { ...current.threadRunStates, [threadId]: state },
    })),

  sessionsRestored: false,

  sessionsRestoring: false,

  sessionLoadErrors: {},

  sessionNotices: {},

  ensureThreadLoaded: (id) => {
    const state = get(), scope = state.cachePath;
    if (!scope || !state.threads.some((t) => t.id === id)) return Promise.reject(new Error("会话不可用"));
    if (state.messages[id] !== undefined) return Promise.resolve();
    const key = JSON.stringify([scope, id]);
    const pending = loadingSessions.get(key);
    if (pending) return pending;
    set((s) => ({ sessionLoadErrors: { ...s.sessionLoadErrors, [id]: undefined } }));
    /** 函数级说明（开发者 Jan）：执行 task 的单一职责，并返回可供调用方继续处理的结果。 */
    const task = (async () => {
      try {
        const record = await loadStoredSession(scope, id);
        if (!record) throw new Error("会话记录不存在");
        const messages = fromStoredConversation(record).messages;
        if (get().cachePath === scope && get().threads.some((t) => t.id === id) && get().messages[id] === undefined) set((s) => ({ messages: { ...s.messages, [id]: messages } }));
      } catch (error) {
        if (get().cachePath === scope) set((s) => ({ sessionLoadErrors: { ...s.sessionLoadErrors, [id]: error instanceof Error ? error.message : String(error) } }));
        throw error;
      } finally { loadingSessions.delete(key); }
    })();
    loadingSessions.set(key, task); return task;
  },

  sessionsRestoreError: null,

  restoreSessions: async () => {
    if (get().sessionsRestored || get().sessionsRestoring || !get().cachePath) return;
    const scope = get().cachePath!;
    set({ sessionsRestoreError: null, sessionsRestoring: true });
    try {
      const cachePath = get().cachePath;
      if (!cachePath) return;
      // 启动时确保会话库存在（不存在则创建建表）
      const cachedProjects = parseCachedProjects(await readCacheFile(cachePath, PROJECTS_FILE));
      if (Array.isArray(cachedProjects)) set({ projects: cachedProjects });
      else if (cachedProjects === undefined) persistProjects(cachePath, get().projects);
      const conversations = await restoreStoredSessions(cachePath, () => loadLegacyConversations(cachePath), true);
      if (get().cachePath !== scope) return;
      // 按创建时间倒序（新的在前，与新建会话插到列表头部一致）；同一批导入的时间戳各不相同，顺序稳定
      const ordered = [...conversations].sort((left, right) => right.createdAt - left.createdAt);
      const threads: Thread[] = [];
      const messages: Record<string, Message[]> = {};
      for (const conversation of ordered) {
        const restored = fromStoredConversation(conversation);
        threads.push(restored.thread);
      }
      // 库里没有任何会话时保持空态：无当前会话，也不强行指向某个项目
      const active = threads[0];
      const sessionLoadErrors: Record<string, string | undefined> = {};
      if (active) {
        try {
          const record = await loadStoredSession(cachePath, active.id);
          if (record) messages[active.id] = fromStoredConversation(record).messages;
          else sessionLoadErrors[active.id] = "会话正文不存在";
        } catch (error) {
          sessionLoadErrors[active.id] = error instanceof Error ? error.message : String(error);
        }
      }
      if (get().cachePath !== scope) return;
      const projects = get().projects;
      // 独立会话本就没有归属，保持空；其余会话可能挂在已被删除的项目下，收敛到仍然存在的项目
      const activeProjectId =
        active && !isStandaloneThread(active)
          ? resolveProjectId(projects, active.projectId)
          : STANDALONE_PROJECT_ID;
      set({
        threads,
        messages,
        activeThreadId: active?.id ?? "",
        activeProjectId,
        sessionsRestored: true,
        sessionLoadErrors,
      });
    } catch (error) {
      if (get().cachePath === scope) set({ sessionsRestoreError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (get().cachePath === scope) set({ sessionsRestoring: false });
    }
  },

  openThread: (id) => {
    const thread = get().threads.find((item) => item.id === id);
    if (!thread) return;
    set({
      activeThreadId: id,
      activeProjectId: thread.projectId,
      view: "chats",
      // 正文按需读取；缺失消息数组不能视为一条空会话。
      // 右栏只反映当前会话的真实产出，切换会话时清空并重新按需读取
      diffFiles: [],
      gitDiffStatus: "idle",
      gitDiffError: null,
      gitInfo: null,
      gitStatus: "idle",
      gitActionResult: null,
      gitActionError: null,
      // 图纸同样只属于当前会话：先清空再按新会话的工作目录重读，避免串味
      workspaceImports: [],
      activeDrawing: null,
      // 产物目录按会话定位（项目 `output/` 或缓存 `outputs/<日期>/`），
      // 换会话就是换目录，旧列表必须先清掉；重读由右栏按目录变化统一触发
      artifacts: [],
      artifactStatus: "idle",
      artifactError: null,
      activeArtifact: null,
    });
    void get().loadWorkspaceImports();
    void get().ensureThreadLoaded(id).catch(() => { });
  },

  newChat: () => {
    // 会话是独立临时的上下文：没有项目也要能开，因此直接建一条无归属的会话
    get().createThread(NEW_SESSION_TITLE, STANDALONE_PROJECT_ID, true);
  },

  newTaskInProject: (projectId) => {
    // 任务是项目内的会话：项目被删掉时不再接受新建，避免建出孤儿任务
    if (!get().projects.some((project) => project.id === projectId)) return;
    get().createThread(NEW_TASK_TITLE, projectId, true);
  },

  createThread: (
    title,
    projectId,
    focus,
    agentId = null,
    parentThreadId = null,
    permissionMode = null,
  ) => {
    if (!get().sessionsRestored || get().sessionsRestoreError) return "";
    const thread: Thread = {
      id: nextId("thread"),
      // 自动化任务的会话以任务名作标题，长了截断避免撑爆左栏
      title: title.trim().length > 0 ? title.trim().slice(0, 32) : NEW_SESSION_TITLE,
      projectId,
      // 创建时间只在建立时定一次，之后不再变：独立会话的产物目录按这一天的日期分层
      createdAt: Math.floor(Date.now() / 1000),
      updatedAtLabel: "刚刚",
      contextEntries: [],
      // 新会话还没有检索过任何来源，右栏「来源」tab 待首次检索后再出现
      sources: [],
      executionContext: "local",
      // 新建会话一律先不带目录：项目下的任务用项目目录，独立会话等用户自己挑
      workspacePath: null,
      worktreePath: null,
      branch: null,
      // 权限档位不跨重启保留：新会话一律从默认档位开始。唯一的例外是子代理派生——
      // 那里显式带上父会话当时的有效档位，否则「主任务收紧到每次询问、委派出去反而放松成
      // 只读自动」的倒挂无法避免；Agent 声明的档位上限仍会在闸门里再收窄一次，不会因此放开权限
      permissionMode: permissionMode ?? DEFAULT_PERMISSION_MODE,
      reviewComments: [],
      agentId,
      parentThreadId,
      // 新会话天然未压缩：没有摘要，也没有被覆盖的消息
      contextSummary: "",
      contextCoveredCount: 0,
    };
    set((state) => ({
      threads: [thread, ...state.threads],
      messages: { ...state.messages, [thread.id]: [] },
      // focus 为 false（定时触发）时只在后台准备好会话，不打断用户正在看的界面；
      // 需要展示时同时把项目切过去，否则新会话不在左栏当前项目的可见范围里
      ...(focus
        ? {
          activeThreadId: thread.id,
          activeProjectId: projectId,
          view: "chats" as const,
          diffFiles: [],
        }
        : {}),
    }));
    return thread.id;
  },

  startAssistantReply: (threadId, prompt, attachments, regenerateFrom) => {
    if (!get().threads.some((thread) => thread.id === threadId)) throw new Error("会话已删除，无法继续发送");
    const assistantId = nextId("msg");
    // 只发附件时用附件名兜底，避免会话标题为空
    const titleSource = prompt.trim().length > 0 ? prompt : attachments[0]?.name ?? NEW_SESSION_TITLE;
    set((state) => {
      const original = state.messages[threadId] ?? [];
      const regeneration = regenerateFrom ? prepareRegeneration(original, regenerateFrom) : null;
      const existing = regeneration?.prefix ?? original;
      const user = userMessage(prompt, attachments);
      if (regeneration) user.answerVersions = regeneration.versions;
      const thread = state.threads.find((item) => item.id === threadId);
      const nextThreads = thread
        ? state.threads.map((item) =>
          item.id === threadId
            ? {
              ...item,
              title: existing.length === 0 ? titleSource.slice(0, 32) : item.title,
              updatedAtLabel: "刚刚",
            }
            : item,
        )
        : state.threads;
      return {
        threads: nextThreads,
        messages: {
          ...state.messages,
          [threadId]: [
            ...existing,
            user,
            { id: assistantId, role: "assistant", items: [] },
          ],
        },
      };
    });
    return assistantId;
  },

  patchItem: (threadId, messageId, itemId, updater) =>
    set((state) => {
      const list = state.messages[threadId];
      if (!list) return state;
      const next = list.map((message) => {
        if (message.id !== messageId) return message;
        return {
          ...message,
          items: message.items.map((item) => (item.id === itemId ? updater(item) : item)),
        };
      });
      return { messages: { ...state.messages, [threadId]: next } };
    }),

  rewindThreadTo: (threadId, messageId) =>
    set((state) => {
      const list = state.messages[threadId];
      if (!list) return state;
      const index = list.findIndex((message) => message.id === messageId);
      // 找不到这条消息时不动：宁可什么都没发生，也不能把会话裁错位置
      if (index < 0) return state;
      // 允许裁成空数组：重跑第一轮时正是这种情形，随后重新运行会补回同一条提问
      return { messages: { ...state.messages, [threadId]: list.slice(0, index) } };
    }),

  renameThread: (id, title) => {
    const value = title.trim();
    if (value.length === 0) return;
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === id ? { ...thread, title: value.slice(0, 32) } : thread,
      ),
    }));
  },

  deleteThread: (id) =>
    set((state) => {
      const threads = state.threads.filter((thread) => thread.id !== id);
      const messages = { ...state.messages };
      delete messages[id];
      if (state.activeThreadId !== id) return { threads, messages };
      // 删的是当前会话：切到同项目下最近的一条；同项目下没有了就落到列表首条
      const fallback =
        threads.find((thread) => thread.projectId === state.activeProjectId) ?? threads[0];
      return {
        threads,
        messages,
        activeThreadId: fallback?.id ?? "",
        activeProjectId: fallback?.projectId ?? state.activeProjectId,
        diffFiles: [],
      };
    }),

  /**
         * 指定 / 更改 / 清除会话自带的工作目录（开发者 Jan）。
         *
         * 目录是这条会话的工程根，换掉之后旧的差异与 git 状态都不再对得上，一并清空
         * 再按新目录重读。检索来源（`Thread.sources`）是会话自身的产物、与目录无关，故不清空。
         * 工作目录不在这里另写一套优先级，统一交给 `effectiveWorkspacePath`。
         */
  setThreadWorkspace: (id, path) => {
    const state = get();
    const threads = state.threads.map((thread) =>
      thread.id === id ? { ...thread, workspacePath: path } : thread,
    );
    if (state.activeThreadId !== id) {
      set({ threads });
      return;
    }
    set({
      threads,
      diffFiles: [],
      gitInfo: null,
      gitDiffStatus: "idle",
      gitDiffError: null,
      // 目录换了，`imports/` 也跟着换一份：清空选中并重新读取
      workspaceImports: [],
      activeDrawing: null,
      // 项目会话的产物目录跟着工作区走，同样要清空重读
      artifacts: [],
      artifactStatus: "idle",
      artifactError: null,
      activeArtifact: null,
    });
    // 新目录可能是另一个 git 仓库，仓库信息必须重新探测，而不是沿用旧目录的结果
    void get().refreshGit();
    void get().loadWorkspaceImports();
  },

  setThreadPermissionMode: (mode) =>
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === state.activeThreadId ? { ...thread, permissionMode: mode } : thread,
      ),
    })),

  setThreadAgent: (agentId) =>
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === state.activeThreadId ? { ...thread, agentId } : thread,
      ),
    })),

  setThreadExecutionContext: (id, context, worktreePath, branch) =>
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === id
          ? {
            ...thread,
            executionContext: context,
            worktreePath:
              worktreePath === undefined ? thread.worktreePath : worktreePath,
            branch: branch === undefined ? thread.branch : branch,
          }
          : thread,
      ),
      diffFiles: [],
      gitInfo: null,
      gitStatus: "idle",
      gitActionResult: null,
      gitActionError: null,
      gitDiffStatus: "idle",
      gitDiffError: null,
    })),

  setThreadContextSummary: (threadId, summary, coveredCount) =>
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
            ...thread,
            contextSummary: summary,
            contextCoveredCount:
              Number.isFinite(coveredCount) && coveredCount > 0
                ? Math.floor(coveredCount)
                : 0,
          }
          : thread,
      ),
    })),

  createThreadWorktree: async () => {
    try {
      const state = get();
      const thread = state.threads.find((item) => item.id === state.activeThreadId);
      const project = state.projects.find((item) => item.id === thread?.projectId);
      if (!thread || !project?.path || !state.cachePath) {
        throw new Error("项目目录或缓存目录不可用。");
      }
      const created = await createGitWorktree({
        cachePath: state.cachePath,
        projectId: project.id,
        projectPath: project.path,
        threadId: thread.id,
        title: thread.title,
      });
      get().setThreadExecutionContext(thread.id, "worktree", created.path, created.branch);
      set({ gitActionResult: created.result, gitActionError: null });
      await Promise.all([get().refreshGit(), get().loadGitDiff()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ gitActionError: message });
      throw error;
    }
  },

  removeThreadWorktree: async (force) => {
    try {
      const state = get();
      const thread = state.threads.find((item) => item.id === state.activeThreadId);
      const project = state.projects.find((item) => item.id === thread?.projectId);
      if (!thread?.worktreePath || !project?.path || !state.cachePath) {
        throw new Error("当前会话没有可移除的 worktree。");
      }
      const result = await removeGitWorktree({
        cachePath: state.cachePath,
        projectId: project.id,
        projectPath: project.path,
        worktreePath: thread.worktreePath,
        force,
      });
      get().setThreadExecutionContext(thread.id, "local", null, null);
      set({ gitActionResult: result, gitActionError: null });
      await Promise.all([get().refreshGit(), get().loadGitDiff()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ gitActionError: message });
      throw error;
    }
  },

  addReviewComment: (input) =>
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === state.activeThreadId
          ? {
            ...thread,
            reviewComments: [
              ...thread.reviewComments,
              {
                ...input,
                id: nextId("review"),
                threadId: thread.id,
                resolved: false,
                createdAt: Date.now(),
              },
            ],
          }
          : thread,
      ),
    })),

  resolveReviewComment: (id, resolved) =>
    set((state) => ({
      threads: state.threads.map((thread) => ({
        ...thread,
        reviewComments: thread.reviewComments.map((comment) =>
          comment.id === id ? { ...comment, resolved } : comment,
        ),
      })),
    })),

  deleteReviewComment: (id) =>
    set((state) => ({
      threads: state.threads.map((thread) => ({
        ...thread,
        reviewComments: thread.reviewComments.filter((comment) => comment.id !== id),
      })),
    }))
});
