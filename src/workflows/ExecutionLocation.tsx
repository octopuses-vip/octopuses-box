import { useEffect, useRef } from "react";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";
import { useWorkflowUI } from "./store";
import { WorkspacePanel } from "./WorkspacePanel";

/** Keep the execution location beside the conversation title, with an anchored chooser. */
export function ExecutionLocation({ path }: { path: string | null }) {
  const element = useRef<HTMLDivElement>(null); const { tab, open } = useWorkflowUI();
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId));
  const branch = useAppStore((s) => thread?.branch || s.gitInfo?.branch);
  const active = tab === "workspace";
  const worktree = thread?.executionContext === "worktree";
  const target = path ? branch || path.split(/[\\/]/).filter(Boolean).at(-1) : null;
  useEffect(() => {
    if (!active) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !element.current?.contains(event.target)) open(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") open(null); };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [active, open]);
  return <div className="execution-location" ref={element}>
    <button type="button" className="execution-location__trigger" aria-haspopup="dialog" aria-expanded={active} title={path ?? "运行位置"} onClick={() => open(active ? null : "workspace")}>
      <Icon name={worktree ? "branch" : "folder"} size={13} />
      <span>{worktree ? "Worktree" : "本地"}</span>
      {target && <span className="execution-location__branch">{target}</span>}
      <Icon name="chevron-down" size={11} />
    </button>
    {active && <div className="execution-location__popover" role="dialog" aria-label="工作目录"><div className="popover-heading">运行位置</div><WorkspacePanel /></div>}
  </div>;
}
