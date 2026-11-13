import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isDesktopRuntime } from "../app/desktop/runtime";

export const useComputerSettings = create(persist(() => ({ enabled: false, modelCode: "", maxSteps: 12, allowedApps: "" }), {
  name: "octopuses-computer-use",
  merge: (saved, current) => {
    const value = saved as Partial<typeof current> | undefined;
    return { ...current, enabled: value?.enabled === true,
      modelCode: typeof value?.modelCode === "string" ? value.modelCode : "",
      allowedApps: typeof value?.allowedApps === "string" ? value.allowedApps : "",
      maxSteps: Number.isInteger(value?.maxSteps) && value!.maxSteps! >= 1 && value!.maxSteps! <= 50 ? value!.maxSteps! : 12 };
  },
}));
export const useComputerRun = create(() => ({ running: false, progress: "", log: [] as string[] }));
let active: AbortController | null = null;
/** 所有会话共享一把桌面锁，防止两项任务同时操作鼠标。 */
export function beginComputerRun(parent: AbortSignal) {
  if (active) throw new Error("另一项电脑操作正在运行，请先停止或等待完成");
  parent.throwIfAborted();
  const controller = new AbortController(); active = controller;
  controller.signal.addEventListener("abort", () => {
    if (isDesktopRuntime()) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("computer_cancel")).catch(() => {});
  }, { once: true });
  const abort = () => controller.abort(); parent.addEventListener("abort", abort, { once: true });
  useComputerRun.setState({ running: true, progress: "准备电脑操作", log: [] });
  return { signal: controller.signal, finish: () => {
    parent.removeEventListener("abort", abort); active = null;
    useComputerRun.setState({ running: false });
  } };
}
export function stopComputerRun() { active?.abort(); }

export function recordComputerStep(text: string) {
  useComputerRun.setState((state) => ({ progress: text, log: [...state.log, text].slice(-100) }));
}
