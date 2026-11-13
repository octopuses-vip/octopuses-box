/** agents 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import {
  scanAgents as fetchAgents,
  createAgent as persistAgent,
  updateAgent as persistAgentUpdate,
  deleteAgent as removeAgent,
} from "../../desktop/agents";

export const createAgentsSlice: StoreSlice<
  | "agents"
  | "agentStatus"
  | "agentError"
  | "agentMutationStatus"
  | "agentMutationError"
  | "loadAgents"
  | "createAgent"
  | "updateAgent"
  | "deleteAgent"
> = (set, get) => ({
  agents: [],

  agentStatus: "idle",

  agentError: null,

  agentMutationStatus: "idle",

  agentMutationError: null,

  loadAgents: async () => {
    set({ agentStatus: "loading", agentError: null });
    try {
      const agents = await fetchAgents(get().cachePath);
      set({ agents, agentStatus: "ready" });
    } catch (error) {
      set({ agentStatus: "error", agentError: error instanceof Error ? error.message : String(error) });
    }
  },

  createAgent: async (input) => {
    set({ agentMutationStatus: "loading", agentMutationError: null });
    try {
      const agents = await persistAgent(get().cachePath, input);
      set({ agents, agentMutationStatus: "ready" });
    } catch (error) {
      set({ agentMutationStatus: "error", agentMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  updateAgent: async (input) => {
    set({ agentMutationStatus: "loading", agentMutationError: null });
    try {
      const agents = await persistAgentUpdate(get().cachePath, input);
      set({ agents, agentMutationStatus: "ready" });
    } catch (error) {
      set({ agentMutationStatus: "error", agentMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  deleteAgent: async (id) => {
    set({ agentMutationStatus: "loading", agentMutationError: null });
    try {
      const agents = await removeAgent(get().cachePath, id);
      set({ agents, agentMutationStatus: "ready" });
    } catch (error) {
      set({ agentMutationStatus: "error", agentMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
});
