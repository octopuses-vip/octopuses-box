/** skills 状态与动作。跨域操作经 get() 访问完整契约。 */
import type { StoreSlice } from "../slice";
import { scanSkills, createSkill, updateSkill, deleteSkill, importSkill } from "../../desktop/skills";

export const createSkillsSlice: StoreSlice<
  | "skills"
  | "skillStatus"
  | "skillError"
  | "skillMutationStatus"
  | "skillMutationError"
  | "disabledSkillIds"
  | "disabledToolIds"
  | "loadSkills"
  | "toggleSkill"
  | "toggleTool"
  | "createSkill"
  | "updateSkill"
  | "deleteSkill"
  | "importSkill"
> = (set, get) => ({
  skills: [],

  skillStatus: "idle",

  skillError: null,

  skillMutationStatus: "idle",

  skillMutationError: null,

  disabledSkillIds: [],

  /** 已停用的内置工具名（开发者 Jan）：默认全开，与技能同一套启停范式 */
  disabledToolIds: [],

  loadSkills: async () => {
    set({ skillStatus: "loading", skillError: null });
    try {
      const skills = await scanSkills(get().cachePath);
      set({ skills, skillStatus: "ready" });
    } catch (error) {
      set({ skillStatus: "error", skillError: error instanceof Error ? error.message : String(error) });
    }
  },

  toggleSkill: (id) =>
    set((state) => ({
      disabledSkillIds: state.disabledSkillIds.includes(id)
        ? state.disabledSkillIds.filter((item) => item !== id)
        : [...state.disabledSkillIds, id],
    })),

  toggleTool: (name) =>
    set((state) => ({
      disabledToolIds: state.disabledToolIds.includes(name)
        ? state.disabledToolIds.filter((item) => item !== name)
        : [...state.disabledToolIds, name],
    })),

  createSkill: async (input) => {
    set({ skillMutationStatus: "loading", skillMutationError: null });
    try {
      const skills = await createSkill(get().cachePath, input);
      set({ skills, skillMutationStatus: "ready" });
    } catch (error) {
      set({ skillMutationStatus: "error", skillMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  updateSkill: async (input) => {
    set({ skillMutationStatus: "loading", skillMutationError: null });
    try {
      const skills = await updateSkill(get().cachePath, input);
      set((state) => ({
        skills,
        skillMutationStatus: "ready",
        disabledSkillIds: input.originalId === input.id
          ? state.disabledSkillIds
          : state.disabledSkillIds.filter((id) => id !== input.originalId),
      }));
    } catch (error) {
      set({ skillMutationStatus: "error", skillMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  deleteSkill: async (id) => {
    set({ skillMutationStatus: "loading", skillMutationError: null });
    try {
      const skills = await deleteSkill(get().cachePath, id);
      set((state) => ({ skills, skillMutationStatus: "ready", disabledSkillIds: state.disabledSkillIds.filter((item) => item !== id) }));
    } catch (error) {
      set({ skillMutationStatus: "error", skillMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  importSkill: async (input) => {
    set({ skillMutationStatus: "loading", skillMutationError: null });
    try {
      const skills = await importSkill(get().cachePath, input);
      set({ skills, skillMutationStatus: "ready" });
    } catch (error) {
      set({ skillMutationStatus: "error", skillMutationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
});
