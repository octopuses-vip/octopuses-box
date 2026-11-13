import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORE_PERSIST_KEY } from "../persist";
import type { AppStore } from "../storeTypes";
import { migratePersistedState, selectPersistedState, STORE_PERSIST_VERSION } from "./persistence";
import { createAccountSlice } from "./slices/account";
import { createUpdatesSlice } from "./slices/updates";
import { createPreferencesSlice } from "./slices/preferences";
import { createProjectsSlice } from "./slices/projects";
import { createSessionsSlice } from "./slices/sessions";
import { createLayoutSlice } from "./slices/layout";
import { createModelsSlice } from "./slices/models";
import { createAppearanceSlice } from "./slices/appearance";
import { createGitSlice } from "./slices/git";
import { createContextSlice } from "./slices/context";
import { createSkillsSlice } from "./slices/skills";
import { createAgentsSlice } from "./slices/agents";
import { createMcpSlice } from "./slices/mcp";
import { createSshSlice } from "./slices/ssh";
import { createParallelSlice } from "./slices/parallel";
import { createUsageSlice } from "./slices/usage";
import { createAutomationsSlice } from "./slices/automations";
import { createArtifactsSlice } from "./slices/artifacts";
import { createNoticesSlice } from "./slices/notices";

/** 唯一的 Store 实例；此文件只负责组合与持久化配置。 */
export const useAppStore = create<AppStore>()(
  persist(
    (...args) => ({
      ...createAccountSlice(...args),
      ...createUpdatesSlice(...args),
      ...createPreferencesSlice(...args),
      ...createProjectsSlice(...args),
      ...createSessionsSlice(...args),
      ...createLayoutSlice(...args),
      ...createModelsSlice(...args),
      ...createAppearanceSlice(...args),
      ...createGitSlice(...args),
      ...createContextSlice(...args),
      ...createSkillsSlice(...args),
      ...createAgentsSlice(...args),
      ...createMcpSlice(...args),
      ...createSshSlice(...args),
      ...createParallelSlice(...args),
      ...createUsageSlice(...args),
      ...createAutomationsSlice(...args),
      ...createArtifactsSlice(...args),
      ...createNoticesSlice(...args),
    }),
    {
      name: STORE_PERSIST_KEY,
      version: STORE_PERSIST_VERSION,
      migrate: migratePersistedState,
      partialize: selectPersistedState,
    },
  ),
);
