import { ModePicker } from "../../tasks/ModePicker";
import { VoiceInput } from "../../audio/VoiceInput";
import { taskKey, useTaskStore } from "../../tasks/store";
import { useWorkflowUI } from "../../workflows/store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useAppStore } from "../../app/state";
import { shortcutHint } from "../../app/platform";
import { subscribeDropSink, restoreFiles } from "../../app/fileDrop";
import { pickFiles } from "../../app/desktop/system";
import { isDesktopRuntime } from "../../app/desktop/runtime";
import type { MessageAttachment, ThreadQueuedItem } from "../../app/types";
import type { AgentSubmitMode } from "../../hooks/useAgentRun";
import { Icon } from "../../components/Icon";
import { useChoose } from "../../components/ConfirmProvider";
import { attachmentMime, createAttachment, formatBytes } from "../../model/attachments";
import { type AttachmentBatch } from "../../model/attachmentDraft";
import { attachmentDraftFor, draftKey } from "../../model/conversationDrafts";
import { ContextChip } from "./ContextChip";
import { AgentPicker } from "./AgentPicker";
import { ComposerMorePicker } from "./ComposerMorePicker";
import { EffortSlider } from "./EffortSlider";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { SLASH_COMMANDS, type SlashItem } from "./commands";
import { AudioTranscriptionButton } from "../../audio/AudioTranscriptionButton";
import { isAudioFile, isNativeAudioFile } from "../../audio/files";
import { transcribeAudio, transcriptAttachment, transcriptionConnection } from "../../audio/transcription";

interface ComposerProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (
    prompt: string,
    attachments: MessageAttachment[],
    mode?: AgentSubmitMode,
  ) => void;
  onStop: () => void;
  isRunning: boolean;
  queuedCount: number;
  /** 排队中的请求列表（按入队顺序）：在输入框上方把每条的内容显示出来 */
  queuedItems: ThreadQueuedItem[];
  /** 撤销队列里尚未开跑的一条请求：排队中的请求没有运行句柄，停止按钮碰不到它 */
  onCancelQueued: (requestId: string) => void;
  /**
   * 外部请求把光标放进输入框的信号。
   *
   * 用单调递增的计数而不是布尔量：连续两次「追问」都要能再聚焦一次，布尔量第二次不会变化、
   * 也就不会再触发。约定 0 表示「还没有人请求过」，据此跳过首帧，避免一进界面就被抢走焦点。
   */
  focusSignal: number;
}

/** 粘贴：剪贴板里的图片与文件都通过 DataTransferItem 取 */
function filesFromClipboard(items: DataTransferItemList): File[] {
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * 输入区（开发者 Jan）：模型与思考强度选择、附加上下文、附件、斜杠命令与提交。
 *
 * 输入内容由上层持有（prompt / onPromptChange），这里只负责交互与提交动作，
 * 因为「追问引用」「斜杠命令」等入口都要能改写同一份输入。
 */
export function Composer({
  prompt,
  onPromptChange,
  onSubmit,
  onStop,
  isRunning,
  queuedCount,
  queuedItems,
  onCancelQueued,
  focusSignal,
}: ComposerProps) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [draft] = useState(() => { const s = useAppStore.getState(); return attachmentDraftFor(draftKey(s.cachePath, s.activeThreadId)); });
  const { attachments, pending, notice } = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const [dragging, setDragging] = useState(false);
  const [audioProgress, setAudioProgress] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 工具栏溢出收纳（开发者 Jan）：探针常驻渲染全部选择器并量出自然总宽，
  // 与工具栏可用宽度比较；放不下时把 Agent / 权限收进「更多」弹层，避免换行堆叠。
  const pickersRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [pickerLayout, setPickerLayout] = useState<"full" | "collapsed" | "compact">("full");
  useLayoutEffect(() => {
    const group = pickersRef.current;
    const probe = probeRef.current;
    if (!group || !probe) return;
    const check = () => {
      const availableWidth = group.clientWidth;
      if (availableWidth < 225) setPickerLayout("compact");
      else setPickerLayout(probe.getBoundingClientRect().width > availableWidth + 1 ? "collapsed" : "full");
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(group);
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // 订阅 platform 只为了让平台落定后重渲染，从而刷新底部快捷键文案
  useAppStore((state) => state.platform);

  const setRightTab = useAppStore((state) => state.setRightTab);
  const loadGitDiff = useAppStore((state) => state.loadGitDiff);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const newChat = useAppStore((state) => state.newChat);
  const setView = useAppStore((state) => state.setView);
  const model = useAppStore((state) => state.model);
  const modelOptions = useAppStore((state) => state.modelOptions);
  const skills = useAppStore((state) => state.skills);
  const disabledSkillIds = useAppStore((state) => state.disabledSkillIds);

  /** 运行中发送时的二选一弹框（排队 / 立即转向），取代原先输入框右侧的两枚按钮 */
  const choose = useChoose();

  const currentModel = modelOptions.find((option) => option.id === model) ?? modelOptions[0];
  const videoAvailable = useAppStore((s) => s.remoteModels.some((m) => m.code === s.videoModelCode) && !s.disabledToolIds.includes("generate_video"));
  const supportsImages = currentModel?.supportsImages ?? false;

  /** 斜杠菜单项：内置命令 + 已启用技能（技能选中后插入 `/技能名 ` 调用标记） */
  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [...SLASH_COMMANDS];
    for (const skill of skills) {
      if (disabledSkillIds.includes(skill.id)) continue;
      items.push({
        id: `skill:${skill.id}`,
        name: `/${skill.name}`,
        description: skill.description || "技能",
        kind: "skill",
      });
    }
    return items;
  }, [skills, disabledSkillIds]);

  /**
   * 读取粘贴/拖拽进来的文件；当前模型不支持图片或类型不合法时给出提示。
   *
   * 立即记录读取中的批次，原生路径还原、PDF 提取和 FileReader 全部完成后才允许发送。
   */
  const addFiles = useCallback(
    (batch: Promise<AttachmentBatch>) => {
      const audioState = useAppStore.getState();
      draft.add(batch, async (file) => {
        if (isAudioFile(file)) {
          try {
            const text = await transcribeAudio(file, transcriptionConnection(audioState.remoteModels, audioState.audioModelCode), undefined, (status) => {
              if (mountedRef.current) setAudioProgress(status);
            }, { cachePath: audioState.cachePath, scope: JSON.stringify([audioState.modelSource, audioState.endpoint, audioState.currentUser]) });
            return { ok: true, attachment: transcriptAttachment(file.name, text) };
          } finally { if (mountedRef.current) setAudioProgress(null); }
        }
        if (isNativeAudioFile(file)) return { ok: false, reason: "此本地文件不是支持的音视频格式" };
        if (attachmentMime(file).startsWith("image/") && !supportsImages && !videoAvailable) {
          return { ok: false, reason: `当前模型 ${currentModel?.label ?? model} 未开启图片输入，可在「设置 → 默认模型 → 允许图片输入」中开启` };
        }
        return createAttachment(file);
      });
    },
    [draft, currentModel, model, supportsImages, videoAvailable],
  );

/** 函数级说明（开发者 Jan）：执行 removeAttachment 的单一职责，并返回可供调用方继续处理的结果。 */
  const removeAttachment = (id: string) => {
    draft.remove(id);
  };

  /**
   * 最新一版的文件接收函数（开发者 Jan）。
   *
   * 拖放订阅只注册一次，而 `addFiles` 会随当前模型变化重建；用 ref 转发调用，
   * 避免每次重建都重新订阅，也避免订阅里拿到过期的模型判断。
   */
  const addFilesRef = useRef(addFiles);
  useEffect(() => {
    addFilesRef.current = addFiles;
  }, [addFiles]);

  // 统一拖放路由把「非图纸」文件派发到这里：桌面端与浏览器端因此共用同一条附件入口
  useEffect(() => {
    return subscribeDropSink((batch) => addFilesRef.current(batch));
  }, []);

/** 函数级说明（开发者 Jan）：执行 handlePaste 的单一职责，并返回可供调用方继续处理的结果。 */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(event.clipboardData.items);
    if (files.length === 0) return; // 纯文本粘贴交给默认行为
    event.preventDefault();
    addFiles(Promise.resolve({ files, failed: [] }));
  };

  // 只负责高亮：真正的文件处理在统一路由里，这里不再自己读 dataTransfer
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    setDragging(true);
  };

  /*
   * 直接落在输入框上时不会有 dragleave，得在这里把高亮收掉，
   * 否则拖完一次输入框会一直亮着「可放置」状态。文件本身已由统一路由处理，此处不再重复读取。
   */
  const handleDrop = () => setDragging(false);

  const slashQuery = prompt.startsWith("/") && !prompt.includes(" ") ? prompt.slice(1) : null;
  const slashMatches = useMemo(
    () =>
      slashQuery === null
        ? []
        : slashItems.filter((item) => item.name.slice(1).startsWith(slashQuery)),
    [slashQuery, slashItems],
  );
  const slashOpen = slashMatches.length > 0;

  useEffect(() => {
    setHighlight(0);
  }, [slashQuery]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [prompt]);

  // 外部请求聚焦（「追问」把引用填进输入框后）：放在上面的自适应高度之后，
  // 保证先把高度撑好再落光标，否则光标会短暂停在滚动条没跟上的位置。
  useEffect(() => {
    // 约定 0 表示还没有人请求过，跳过首帧，免得一进界面就抢焦点
    if (focusSignal === 0) return;
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    // 显式把光标放到末尾：引用块在前，用户接着往下写才是自然的位置
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, [focusSignal]);

  const canSend = prompt.trim().length > 0 || attachments.length > 0;

  /**
   * 发送当前输入（开发者 Jan）。
   *
   * 会话正在运行时不再默认「排队」，而是弹框让用户自己挑：排队（等这一轮结束）还是立即转向
   * （中断这一轮、插到队首）。原先这两个动作各占一枚按钮，谁都没被默认选中，用户只能从按钮文案里猜；
   * 收进一发一问之后，默认值不再由代码替用户决定，且输入框里能少两枚按钮。
   *
   * 取消（Esc / 点遮罩 / 点「取消」）时**原样保留**输入内容与附件——`canSend` 之后、清空之前就返回，
   * 用户改主意不必重打一遍。
   */
  const submit = async (mode?: AgentSubmitMode) => {
    const value = prompt.trim();
    if (submittingRef.current || (!canSend && draft.getSnapshot().pending === 0)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await draft.ready();
      if (!mountedRef.current || (!value && draft.getSnapshot().attachments.length === 0)) return;
      let resolved: AgentSubmitMode | null = mode ?? null;
      if (!resolved && isRunning) {
        resolved = await choose({
          title: "会话正在运行",
          message: "当前这一轮还在跑。排队：等它结束后按顺序执行这条；立即转向：中断这一轮，把这条插到队首立刻执行——已产生的消息与已写入的文件不会回滚。",
          actions: [
            {
              label: "排队",
              value: "queue",
              variant: "primary",
              title: "不打断当前这一轮，指令排到队尾，等它结束后按顺序执行",
            },
            {
              label: "立即转向",
              value: "steer",
              title: "中断当前这一轮，把这条指令插到队首立刻执行；已产生的消息与已写入的文件不会回滚",
            },
          ],
        });
        textareaRef.current?.focus();
        // 用户取消：输入与附件保持不动。
        if (!resolved) return;
      }
      // 排队确认期间也可能继续拖入附件，必须读取最新快照而不是点击发送时的旧闭包。
      await draft.ready();
      if (!mountedRef.current) return;
      const outgoing = draft.getSnapshot().attachments;
      onSubmit(value, outgoing, resolved ?? "run");
      draft.sent(outgoing);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

/** 函数级说明（开发者 Jan）：执行 runCommand 的单一职责，并返回可供调用方继续处理的结果。 */
  const runCommand = (id: string) => {
    onPromptChange("");
    switch (id) {
      case "plan": {
        const s = useAppStore.getState(); useTaskStore.getState().patch(taskKey(s.cachePath, s.activeThreadId), { mode: "plan" });
        onPromptChange("/plan "); break;
      }
      case "goal": onPromptChange("/goal "); break;
      case "memories": useWorkflowUI.getState().open("memories"); break;
      case "worktree": useWorkflowUI.getState().open("workspace"); break;
      case "review": useWorkflowUI.getState().open("review"); break;
      case "browser": useWorkflowUI.getState().open("browser"); break;
      case "video":
        onPromptChange("/video ");
        textareaRef.current?.focus();
        break;
      case "model":
        setRightTab("files");
        break;
      case "diff":
        // 真实读取项目目录上的 git diff，再打开差异 tab（读取结果与失败原因都在面板里）
        void loadGitDiff();
        setRightTab("diff");
        break;
      case "sources":
        setRightTab("sources");
        break;
      case "terminal":
        toggleTerminal();
        break;
      case "new":
        newChat();
        break;
      case "settings":
        setView("settings");
        break;
      default:
        break;
    }
  };

  /** 选中斜杠菜单项：内置命令立即执行，技能则插入 `/技能名 ` 调用标记并回到输入 */
  const selectSlashItem = (item: SlashItem) => {
    if (item.kind === "skill") {
      onPromptChange(`${item.name} `);
      textareaRef.current?.focus();
      return;
    }
    runCommand(item.id);
  };

/** 函数级说明（开发者 Jan）：执行 handleKeyDown 的单一职责，并返回可供调用方继续处理的结果。 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((prev) => (prev + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((prev) => (prev - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashItem(slashMatches[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onPromptChange("");
        return;
      }
    }

    // 发送走 Ctrl/⌘ + Enter，单独 Enter 保留为换行：长任务描述常需多行，默认换行更符合书写习惯
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
      return;
    }

    if (event.key === "Escape" && isRunning) {
      event.preventDefault();
      onStop();
    }
  };

  return (
    <div
      className="composer-wrap"
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="composer-inner">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="选择附件"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) addFiles(Promise.resolve({ files, failed: [] }));
            event.target.value = "";
          }}
        />
        {/*
          会话队列（开发者 Jan）：一个会话里排队的多条请求逐条显示在输入框上方，
          而不是只报一个「排队 N」的数字——用户要能看到接下来会跑什么。
          顺序即入队顺序（「立即转向」会插到最前），自动化来源单独打标。
        */}
        {queuedItems.length > 0 ? (
          <div className="queue-strip">
            <span className="queue-strip__title">排队中 {queuedItems.length} 条</span>
            {queuedItems.map((item) => (
              <span className="queue-strip__item" key={item.id} title={item.preview}>
                {item.source === "automation" ? <span className="badge">自动化</span> : null}
                <span className="queue-strip__text">{item.preview || "（仅附件）"}</span>
                {item.attachmentCount > 0 ? (
                  <span className="queue-strip__attach">
                    <Icon name="file" size={11} />
                    {item.attachmentCount}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="queue-strip__cancel"
                  aria-label="取消这条排队请求"
                  title="取消这条排队请求"
                  onClick={() => onCancelQueued(item.id)}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className={dragging ? "composer composer--drop" : focused ? "composer composer--focused" : "composer"}>
          {attachments.length > 0 ? (
            <div className="attach-strip">
              {attachments.map((item) => (
                <span className="attach-chip" key={item.id}>
                  {item.kind === "image" && item.dataUrl ? (
                    <img className="attach-chip__thumb" src={item.dataUrl} alt={item.name} />
                  ) : (
                    <Icon name="file" size={12} />
                  )}
                  <span className="attach-chip__name">{item.name}</span>
                  <span className="attach-chip__size">{formatBytes(item.size)}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${item.name}`}
                    onClick={() => removeAttachment(item.id)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {videoAvailable && !supportsImages && attachments.some((a) => a.kind === "image") && (
            <div className="attach-notice">图片可用作视频首帧。当前聊天模型仅读取附件名称。</div>
          )}
          {notice ? (
            <div className="attach-notice" role="alert">
              <Icon name="alert" size={12} />
              {notice}
            </div>
          ) : null}
          {pending > 0 ? <div className="attach-notice muted" role="status">{audioProgress || "正在读取或转写附件…"}</div> : null}
          {dragging ? (
            <div className="attach-notice">
              <Icon name="image" size={12} />
              松开鼠标即可添加图片、PDF、音频或文本文件（音频将上传转写）
            </div>
          ) : null}
          {slashOpen ? (
            <div className="menu" style={{ position: "static", margin: "10px 10px 0" }}>
              {slashMatches.map((item, index) => (
                <button
                  type="button"
                  className="menu__item"
                  key={item.id}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => selectSlashItem(item)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                    <span className="menu__item-title mono">{item.name}</span>
                    {item.kind === "skill" ? <span className="badge">技能</span> : null}
                    <span className="spacer" />
                    <span className="menu__item-desc">{item.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="composer__input"
            value={prompt}
            rows={1}
            readOnly={submitting}
            aria-label="消息内容"
            placeholder="输入消息，按 / 查看命令"
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {/* 思考强度收进模型旁的弹层；窄栏放不下时 Agent / 权限收进「更多」弹层而不是换行。 */}
          <div className="composer__row">
            <div className="composer__row-group composer__row-group--pickers" ref={pickersRef}>
              <div className="composer__model-group">
                <ModelPicker />
                <ModePicker />
                {pickerLayout !== "compact" && <EffortSlider />}
              </div>
              {pickerLayout !== "full" ? (
                <ComposerMorePicker includeEffort={pickerLayout === "compact"} />
              ) : (
                <>
                  <AgentPicker />
                  <PermissionPicker />
                </>
              )}
            </div>
            {/*
             * 溢出测量探针（开发者 Jan）：常驻渲染全部选择器（含被收纳的），绝对定位且不可见，
             * 只用于量出工具栏「铺开时的自然总宽」。探针独立于折叠状态，避免「收起后变窄 →
             * 判定放得下 → 展开又放不下」的抖动循环。
             */}
            <div className="composer__probe" ref={probeRef} aria-hidden="true">
              <div className="composer__model-group">
                <ModelPicker />
                <ModePicker />
                <EffortSlider />
              </div>
              <AgentPicker />
              <PermissionPicker />
            </div>
            <div className="composer__row-group composer__row-group--end">
              <VoiceInput onText={(text) => onPromptChange([prompt, text].filter(Boolean).join("\n"))} onTurn={(text) => onSubmit(text, [], "steer")} />
              <AudioTranscriptionButton onInsert={(text) => {
                onPromptChange(prompt ? `${prompt}\n\n${text}` : text);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }} />
              <ContextChip onAddAttachments={() => {
                if (!isDesktopRuntime()) { fileInputRef.current?.click(); return; }
                addFiles(pickFiles({ title: "选择附件" }).then((paths) => restoreFiles(paths.map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path, file: null })))));
              }} />
              {/* 发送按钮在运行期间也留着（开发者 Jan）：原先它被「立即转向 / 排队」两枚按钮替换掉，
                  现在这两枚撤了、改由弹框二选一，若仍把发送按钮藏起来，鼠标用户就没有任何发送入口了 */}
              <button
                type="button"
                className="send-btn"
                aria-label={submitting ? "正在准备发送" : "发送"}
                disabled={!canSend || pending > 0 || submitting}
                onClick={() => void submit()}
              >
                <Icon name="arrow-up" size={14} />
              </button>
              {isRunning ? (
                /* 显式无参调用（开发者 Jan）：直接写 onClick={onStop} 会把点击事件当作第一个参数传进去，
                    若回调恰好也接收参数，事件对象就会被误当成会话 id，导致停止失效 */
                <button
                  type="button"
                  className="send-btn send-btn--stop"
                  aria-label="停止运行"
                  onClick={() => onStop()}
                >
                  <Icon name="stop" size={12} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="composer-foot">
          <span className="composer-foot__shortcut"><kbd className="kbd">{shortcutHint("⏎")}</kbd> 发送</span>
          <span className="spacer" />
          <span aria-live="polite">
            {isRunning
              ? queuedCount > 0
                ? `运行中 · 排队 ${queuedCount}`
                : "运行中"
              : queuedCount > 0
                ? `排队 ${queuedCount}`
                : null}
          </span>
        </div>
      </div>
    </div>
  );
}
