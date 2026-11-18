import { create } from "zustand";
import { useAppStore } from "../app/state";
export type WorkflowTab = "workspace" | "review" | "memories" | "browser";
export type WorkflowDock = "pulls" | "browser";
const DOCKS: Partial<Record<WorkflowTab, WorkflowDock>> = { review: "pulls", browser: "browser" };
interface WorkflowUI { tab: WorkflowTab | null; docks: WorkflowDock[]; open: (tab: WorkflowTab | null) => void; closeDock: (tab: WorkflowDock) => void }
/** Contextual inspection stays in the right pane; only preferences use a settings dialog. */
export const useWorkflowUI = create<WorkflowUI>((set) => ({
  tab: null, docks: [],
  open: (tab) => {
    const dock = tab ? DOCKS[tab] : undefined;
    if (dock) { set((s) => ({ tab: null, docks: [...new Set([...s.docks, dock])] })); useAppStore.getState().setRightTab(dock); }
    else set({ tab });
  },
  closeDock: (tab) => set((s) => ({ docks: s.docks.filter((d) => d !== tab) })),
}));
