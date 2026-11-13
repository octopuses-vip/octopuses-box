import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../app/state";
import { shortcutHint } from "../app/platform";
import { Icon, type IconName } from "../components/Icon";

interface PaletteCommand {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
}

/**
 * 命令清单。终端一项的 hint 是快捷键文案，随平台变化，故在组件内构造，
 * 不能停在模块级常量里（模块加载时平台尚未落定）。
 */
function buildCommands(): PaletteCommand[] {
  return [
    { id: "new", label: "新建会话", hint: "开启一个全新的会话", icon: "plus" },
    { id: "diff", label: "打开差异面板", hint: "右侧面板", icon: "diff" },
    { id: "sources", label: "查看来源", hint: "右侧面板", icon: "book" },
    { id: "files", label: "查看文件预览", hint: "右侧面板", icon: "file" },
    { id: "terminal", label: "切换集成终端", hint: shortcutHint("J"), icon: "terminal" },
    { id: "rightpanel", label: "切换右侧面板", hint: "", icon: "panel-right" },
    { id: "search", label: "搜索对话", hint: "", icon: "search" },
    { id: "knowledge", label: "打开知识库", hint: "文档、模型与训练数据", icon: "book" },
    { id: "automations", label: "自动化任务", hint: "", icon: "clock" },
    { id: "skills", label: "技能仓库", hint: "", icon: "sparkles" },
    { id: "settings", label: "设置", hint: "", icon: "settings" },
  ];
}

/** 命令面板（开发者 Jan）：⌘K 唤起，按输入模糊匹配命令并执行，覆盖新建会话、切页与面板操作 */
export function CommandPalette() {
  const open = useAppStore((state) => state.commandPaletteOpen);
  const setOpen = useAppStore((state) => state.setCommandPaletteOpen);
  const setView = useAppStore((state) => state.setView);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const loadGitDiff = useAppStore((state) => state.loadGitDiff);
  const toggleRightPanel = useAppStore((state) => state.toggleRightPanel);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const newChat = useAppStore((state) => state.newChat);
  const platform = useAppStore((state) => state.platform);

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 依赖 platform：平台落定后重算，把快捷键文案从 UA 初值切到权威值
  const commands = useMemo(() => buildCommands(), [platform]);

  const matches = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword.length === 0) return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(keyword) ||
        command.id.includes(keyword) ||
        command.hint.toLowerCase().includes(keyword),
    );
  }, [query, commands]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  if (!open) return null;

/** 函数级说明（开发者 Jan）：执行 runCommand 的单一职责，并返回可供调用方继续处理的结果。 */
  const runCommand = (id: string) => {
    switch (id) {
      case "new":
        newChat();
        break;
      case "diff":
        // 与 /diff 命令一致：真实读取项目目录上的 git diff 后打开差异 tab
        void loadGitDiff();
        setRightTab("diff");
        break;
      case "sources":
        setRightTab("sources");
        break;
      case "files":
        setRightTab("files");
        break;
      case "terminal":
        toggleTerminal();
        break;
      case "rightpanel":
        toggleRightPanel();
        break;
      case "search":
        setView("search");
        break;
      case "knowledge":
        setView("knowledge");
        break;
      case "automations":
        setView("automations");
        break;
      case "skills":
        setView("skills");
        break;
      case "settings":
        setView("settings");
        break;
      default:
        break;
    }
    setOpen(false);
  };

/** 函数级说明（开发者 Jan）：执行 handleKeyDown 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((prev) => (prev + 1) % Math.max(matches.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((prev) => (prev - 1 + matches.length) % Math.max(matches.length, 1));
      return;
    }
    if (event.key === "Enter" && matches.length > 0) {
      event.preventDefault();
      void runCommand(matches[Math.min(highlight, matches.length - 1)].id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder="输入命令名称…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="palette__list">
          {matches.map((command, index) => (
            <button
              type="button"
              key={command.id}
              className="palette__item"
              style={index === highlight ? { background: "var(--bg-hover)", color: "var(--text-1)" } : undefined}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => void runCommand(command.id)}
            >
              <Icon name={command.icon} size={14} />
              {command.label}
              {command.hint ? <span className="palette__hint">{command.hint}</span> : null}
            </button>
          ))}
          {matches.length === 0 ? (
            <div className="palette__item muted">没有匹配的命令</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
