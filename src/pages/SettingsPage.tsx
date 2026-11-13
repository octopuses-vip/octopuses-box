import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ComputerSettings } from "../computer/ComputerSettings";

import { clearCache, initCacheDir, readCacheInfo, type CacheInfo } from "../app/desktop/cache";
import { pickDirectory, revealLocalFile } from "../app/desktop/system";
import { pruneAutomationAgents } from "../app/desktop/automation";
import { APP_NAME, APP_VERSION } from "../app/meta";
import { supportsBackgroundAgents, supportsKernelSandbox } from "../app/platform";
import { useAppStore } from "../app/state";
import { selectActiveThread } from "../app/storeSelectors";
import { SCHEME_OPTIONS, THEME_PRESETS } from "../app/theme";
import { DEFAULT_PERMISSION_MODE, permissionModeOption } from "../approval/permission";
import { logCacheEvent } from "../cache/logger";
import { useTheme } from "../hooks/useTheme";
import { LOCAL_MODELS_FILE, LOCAL_MODELS_TEMPLATE } from "../model/localModels";
import {
  describeVisionSource,
  resolveSupportsImages,
  visionSourceOf,
} from "../model/visionCapability";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Segmented } from "../components/Segmented";

/** 把字节数格式化成人读的大小（开发者 Jan）：用于缓存目录用量展示 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 读取「单次运行的上限」类数字输入，留空返回 null 表示不写入。
 *
 * 这几项里 0 是「不限」而不是空值，而清空输入框时 `Number("")` 正好等于 0——不拦一下的话，
 * 用户删掉内容再点走就会把上限悄悄关成不限。
 */
function readLimitInput(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

const SETTINGS_CATEGORIES = [
  { id: "appearance", label: "外观", description: "选择配色主题与明暗模式，让界面更适合你的阅读习惯。" },
  { id: "models", label: "模型与连接", description: "维护本地模型文件与默认模型。" },
  { id: "permissions", label: "权限与安全", description: "设置命令审批、沙箱与自动批准规则。" },
  { id: "runtime", label: "运行与上下文", description: "调整运行上限、上下文压缩和后台定时。" },
  { id: "storage", label: "存储与缓存", description: "查看本地存储用量，管理缓存目录与临时文件。" },
  { id: "advanced", label: "高级与调试", description: "查看模型调用记录等调试信息。" },
  { id: "about", label: "关于", description: "查看应用版本。" },
] as const;

type SettingsCategory = typeof SETTINGS_CATEGORIES[number]["id"];

/** 只挂载当前分类；表单草稿留在父组件，切换分类不会丢失未保存内容。 */
function SettingsGroup({ category, active, children }: {
  category: SettingsCategory;
  active: SettingsCategory;
  children: ReactNode;
}) {
  return category === active ? <>{children}</> : null;
}

/** 设置页：模型、工作区、缓存路径与账号信息 */
export function SettingsPage() {
  const [category, setCategory] = useState<SettingsCategory>("appearance");
  const currentCategory = SETTINGS_CATEGORIES.find((item) => item.id === category)!;
  // 订阅 platform 只为了让平台落定后重渲染，从而按平台隐藏不可用的能力区块
  useAppStore((state) => state.platform);
  const { themeId, schemePreference, resolvedScheme, setThemeId, setSchemePreference } = useTheme();
  const model = useAppStore((state) => state.model);
  const modelOptions = useAppStore((state) => state.modelOptions);
  const modelConfigStatus = useAppStore((state) => state.modelConfigStatus);
  const modelConfigError = useAppStore((state) => state.modelConfigError);
  const loadModelConfig = useAppStore((state) => state.loadModelConfig);
  const setModel = useAppStore((state) => state.setModel);
  const cachePath = useAppStore((state) => state.cachePath);
  const setCachePath = useAppStore((state) => state.setCachePath);
  const trustReadOnlyCommands = useAppStore((state) => state.trustReadOnlyCommands);
  const setTrustReadOnlyCommands = useAppStore((state) => state.setTrustReadOnlyCommands);
  const sandboxEnabled = useAppStore((state) => state.sandboxEnabled);
  const setSandboxEnabled = useAppStore((state) => state.setSandboxEnabled);
  const sandboxAllowNetwork = useAppStore((state) => state.sandboxAllowNetwork);
  const setSandboxAllowNetwork = useAppStore((state) => state.setSandboxAllowNetwork);
  // 权限档位是会话级的，这里只做展示；真正的切换入口在输入框里模型右侧的选择器
  const permissionModeLabel = useAppStore((state) =>
    permissionModeOption(selectActiveThread(state)?.permissionMode ?? DEFAULT_PERMISSION_MODE).label,
  );
  const autoApprovalDenylist = useAppStore((state) => state.autoApprovalDenylist);
  const clearAutoApprovalDenylist = useAppStore((state) => state.clearAutoApprovalDenylist);
  const disableAllAutomations = useAppStore((state) => state.disableAllAutomations);
  const remoteModels = useAppStore((state) => state.remoteModels);
  const imageInputEnabled = useAppStore((state) => state.imageInputEnabled);
  const setImageInputEnabled = useAppStore((state) => state.setImageInputEnabled);
  const modelTraceEnabled = useAppStore((state) => state.modelTraceEnabled);
  const setModelTraceEnabled = useAppStore((state) => state.setModelTraceEnabled);
  const maxToolRounds = useAppStore((state) => state.maxToolRounds);
  const setMaxToolRounds = useAppStore((state) => state.setMaxToolRounds);
  const maxRunDurationSecs = useAppStore((state) => state.maxRunDurationSecs);
  const setMaxRunDurationSecs = useAppStore((state) => state.setMaxRunDurationSecs);
  const maxRunTokens = useAppStore((state) => state.maxRunTokens);
  const setMaxRunTokens = useAppStore((state) => state.setMaxRunTokens);
  const modelRetryCount = useAppStore((state) => state.modelRetryCount);
  const setModelRetryCount = useAppStore((state) => state.setModelRetryCount);
  const contextCompactThresholdTokens = useAppStore(
    (state) => state.contextCompactThresholdTokens,
  );
  const setContextCompactThresholdTokens = useAppStore(
    (state) => state.setContextCompactThresholdTokens,
  );
  /** 正在移除全部后台定时项 */
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const saveLocalModels = useAppStore((state) => state.saveLocalModels);
  const readLocalModelsText = useAppStore((state) => state.readLocalModelsText);
  /** 本地模型 JSON 草稿；null 表示还没从文件读回来，用模板预填 */
  const [localDraft, setLocalDraft] = useState<string | null>(null);
  /** 正在保存本地模型配置 */
  const [localBusy, setLocalBusy] = useState(false);
  /** 保存本地模型配置留下的校验错误，逐条展示 */
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  /** 本次保存成功后的反馈文案 */
  const [localSavedAt, setLocalSavedAt] = useState<string | null>(null);
  /** 本地模型文件是否已存在：不存在时说明「下面这份是模板」 */
  const [localFileExists, setLocalFileExists] = useState(true);

  /** 当前选中模型的原始记录，用于判断图片能力来自文件声明还是本地开关 */
  const currentRemoteModel = remoteModels.find((item) => item.code === model);
  /** 图片能力来源：文件声明（只读）还是本地手动开关 */
  const visionSource = visionSourceOf(currentRemoteModel);
  /** 当前是否真的支持图片输入（文件声明优先，缺失时看手动开关） */
  const supportsImages = resolveSupportsImages(currentRemoteModel, imageInputEnabled);

  /**
   * 把缓存目录下的 models.json 读回编辑框（开发者 Jan）。
   *
   * 文件不存在时预填模板而不是留空：用户照着改一条就能跑起来，
   * 同时把「这份是模板」的状态记下来，避免用户以为已经存过一份。
   */
  const reloadLocalDraft = useCallback(async () => {
    const text = await readLocalModelsText();
    setLocalFileExists(text !== null);
    setLocalDraft(text ?? LOCAL_MODELS_TEMPLATE);
    setLocalErrors([]);
    setLocalSavedAt(null);
  }, [readLocalModelsText]);

  // 进入设置页或换了缓存目录时读一次，之后编辑框归用户管，不再自动覆盖草稿
  useEffect(() => {
    if (!cachePath) return;
    void reloadLocalDraft();
  }, [cachePath, reloadLocalDraft]);

  /** 保存本地模型配置：校验错误逐条回显，通过则立刻按新列表重载模型 */
  const saveLocal = async () => {
    setLocalBusy(true);
    const errors = await saveLocalModels(localDraft ?? "");
    setLocalErrors(errors);
    if (errors.length === 0) {
      setLocalFileExists(true);
      setLocalSavedAt("已保存，模型列表已按新配置重新加载。");
    }
    setLocalBusy(false);
  };

  /** 在文件管理器里定位到 models.json，方便用户用顺手的外部编辑器改 */
  const revealModelsFile = async () => {
    if (!cachePath) return;
    try {
      const revealed = await revealLocalFile(`${cachePath}/${LOCAL_MODELS_FILE}`);
      if (!revealed) {
        setLocalErrors([`浏览器预览环境无法打开文件管理器，请到 ${cachePath} 下手动编辑 ${LOCAL_MODELS_FILE}。`]);
      }
    } catch (err) {
      setLocalErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  const refreshCache = useCallback(async () => {
    if (!cachePath) return;
    try {
      setCacheInfo(await readCacheInfo(cachePath));
      setCacheError(null);
    } catch (err) {
      setCacheError(err instanceof Error ? err.message : String(err));
    }
  }, [cachePath]);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

/** 函数级说明（开发者 Jan）：执行 chooseCacheDir 的单一职责，并返回可供调用方继续处理的结果。 */
  const chooseCacheDir = async () => {
    const selected = await pickDirectory("选择缓存目录");
    if (!selected) {
      setCacheError("当前环境不支持原生目录选择，可在桌面应用中使用该按钮。");
      return;
    }
    setCacheBusy(true);
    try {
      const info = await initCacheDir(selected);
      setCachePath(info.path);
      setCacheInfo(info);
      setCacheError(null);
      logCacheEvent("cache.relocate", info.path);
    } catch (err) {
      setCacheError(err instanceof Error ? err.message : String(err));
    } finally {
      setCacheBusy(false);
    }
  };

/** 函数级说明（开发者 Jan）：执行 clearTempCache 的单一职责，并返回可供调用方继续处理的结果。 */
  const clearTempCache = async () => {
    if (!cachePath) return;
    setCacheBusy(true);
    try {
      setCacheInfo(await clearCache(cachePath, "temp"));
      setCacheError(null);
      logCacheEvent("cache.clear", "temp");
    } catch (err) {
      setCacheError(err instanceof Error ? err.message : String(err));
    } finally {
      setCacheBusy(false);
    }
  };

  /** 日常任务的后台定时项会写进系统 LaunchAgents，这里给用户一个可逆的出口 */
  const removeAllAgents = async () => {
    setAgentBusy(true);
    try {
      const removed = await pruneAutomationAgents([]);
      disableAllAutomations();
      setAgentMessage(
        removed.length > 0
          ? `已移除 ${removed.length} 个后台定时项，日常任务全部停用。`
          : "没有需要清理的后台定时项，日常任务已全部停用。",
      );
    } catch (err) {
      setAgentMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAgentBusy(false);
    }
  };

  /** 标签页键盘导航：左右方向键切换、Home/End 跳首尾，并把焦点同步到新激活的标签 */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const ids = SETTINGS_CATEGORIES.map((item) => item.id);
    const current = ids.indexOf(category);
    const next =
      event.key === "ArrowLeft"
        ? (current + ids.length - 1) % ids.length
        : event.key === "ArrowRight"
          ? (current + 1) % ids.length
          : event.key === "Home"
            ? 0
            : ids.length - 1;
    const nextId = ids[next];
    setCategory(nextId);
    document.getElementById(`settings-tab-${nextId}`)?.focus();
  };

  return (
    <div className="page settings-page">
      <div className="page__inner">
        <header className="settings-header">
          <p className="page__desc">按分类调整你的工作环境。</p>
        </header>

        <div className="settings-navigation">
          <p className="settings-navigation__description">{currentCategory.description}</p>
          <div className="settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={handleTabKeyDown}>
            {SETTINGS_CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`settings-tab-${item.id}`}
                // 激活标签参与 Tab 序列，其余用 roving tabindex，方向键才是标签间的导航
                tabIndex={item.id === category ? 0 : -1}
                aria-selected={item.id === category}
                aria-controls="settings-content"
                className={
                  item.id === category
                    ? "settings-tabs__tab settings-tabs__tab--active"
                    : "settings-tabs__tab"
                }
                onClick={() => setCategory(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <section
          id="settings-content"
          className="settings-content"
          role="tabpanel"
          aria-label={currentCategory.label}
        >
        <SettingsGroup category="appearance" active={category}>

        <div className="page__section">
          <div className="page__section-label">配色主题</div>
          <div className="theme-grid" role="radiogroup" aria-label="配色主题">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={preset.id === themeId}
                // 卡片自带主题属性：卡内的 var(--bg-0) 等会解析成该主题自己的颜色，
                // 于是色卡预览不需要在 TypeScript 里抄任何色值（开发者 Jan）
                data-theme={preset.id}
                data-scheme={resolvedScheme}
                className={preset.id === themeId ? "theme-card theme-card--active" : "theme-card"}
                onClick={() => setThemeId(preset.id)}
              >
                <span className="theme-card__swatches" aria-hidden="true">
                  <span className="theme-card__swatch theme-card__swatch--bg" />
                  <span className="theme-card__swatch theme-card__swatch--surface" />
                  <span className="theme-card__swatch theme-card__swatch--accent" />
                  <span className="theme-card__swatch theme-card__swatch--info" />
                </span>
                <span className="theme-card__label">{preset.label}</span>
                <span className="theme-card__desc">{preset.description}</span>
              </button>
            ))}
          </div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">明暗模式</span>
              <span className="list-row__desc">
                选「跟随系统」时随操作系统的深浅色设置实时切换；选浅色或深色则固定不变。
              </span>
            </span>
            <Segmented
              ariaLabel="明暗模式"
              options={SCHEME_OPTIONS}
              value={schemePreference}
              onChange={setSchemePreference}
            />
          </div>
        </div>

        </SettingsGroup>

        <SettingsGroup category="models" active={category}>

        <div className="page__section">
          <div className="page__section-label">本地模型配置</div>
          <div className="path-box">
            <Icon name="folder" size={13} />
            <span className="mono">{cachePath ? `${cachePath}/${LOCAL_MODELS_FILE}` : "尚未配置缓存目录"}</span>
          </div>
          <textarea
            className="form__textarea form__textarea--code"
            style={{ marginTop: 8, width: "100%" }}
            rows={12}
            spellCheck={false}
            aria-label="本地模型配置 JSON"
            value={localDraft ?? LOCAL_MODELS_TEMPLATE}
            onChange={(event) => {
              setLocalDraft(event.target.value);
              setLocalErrors([]);
              setLocalSavedAt(null);
            }}
          />
          <p className="page__desc" style={{ marginTop: 8 }}>
            顶层是数组，每项至少要有 <span className="mono">code</span>（调用时用的模型名）与{" "}
            <span className="mono">baseUrl</span>（OpenAI 兼容协议的基础地址，须以 http:// 或 https:// 开头）；{" "}
            <span className="mono">name</span> / <span className="mono">provider</span> /{" "}
            <span className="mono">apiKey</span> / <span className="mono">description</span> 可留空，{" "}
            <span className="mono">supportsImages</span> 写 true 表示支持图片输入。
            {!localFileExists ? " 当前文件还不存在，下面是一份模板，改好后点「保存」即可生成。" : ""}
          </p>
          {localErrors.length > 0 ? (
            <div className="page__desc" style={{ marginTop: 8 }}>
              {localErrors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          ) : null}
          {localSavedAt ? (
            <p className="page__desc" style={{ marginTop: 8 }}>
              {localSavedAt}
            </p>
          ) : null}
          <div className="login__actions" style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              size="sm"
              disabled={!cachePath || localBusy}
              onClick={() => void saveLocal()}
            >
              {localBusy ? "正在保存…" : "保存"}
            </Button>
            <Button variant="ghost" size="sm" disabled={localBusy} onClick={() => void reloadLocalDraft()}>
              放弃修改并重新读取
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!cachePath}
              onClick={() => void revealModelsFile()}
            >
              在文件管理器中显示
            </Button>
          </div>
        </div>

        <div className="page__section">
          <div className="page__section-label">默认模型</div>
          <Segmented
            ariaLabel="默认模型"
            options={modelOptions.map((option) => ({ value: option.id, label: option.label }))}
            value={model}
            onChange={setModel}
          />
          <p className="page__desc" style={{ marginTop: 8 }}>
            {modelOptions.find((option) => option.id === model)?.description}
          </p>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">允许图片输入</span>
              <span className="list-row__desc">{describeVisionSource(visionSource, supportsImages)}</span>
            </span>
            <button
              type="button"
              className={supportsImages ? "btn btn--sm" : "btn btn--ghost btn--sm"}
              aria-pressed={supportsImages}
              // 能力由后台下发时本开关不参与判定，置灰只作状态展示
              disabled={visionSource === "remote"}
              onClick={() => setImageInputEnabled(!imageInputEnabled)}
            >
              {supportsImages ? "已开启" : "已关闭"}
            </button>
          </div>
          {/* 常驻显示：本地文件可能被外部编辑器改过，用户需要能主动重新读一次 */}
          <div className="login__actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn--sm"
              disabled={modelConfigStatus === "loading"}
              onClick={() => void loadModelConfig()}
            >
              {modelConfigStatus === "loading" ? "正在读取…" : "重新读取本地文件"}
            </button>
          </div>
          {modelConfigError ? (
            <p className="page__desc" style={{ marginTop: 8 }}>
              模型列表读取失败：{modelConfigError}
            </p>
          ) : null}
        </div>

        </SettingsGroup>

        <SettingsGroup category="permissions" active={category}>
        <div className="page__section">
          <div className="page__section-label">命令审批</div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">自动信任只读与验证命令</span>
              <span className="list-row__desc">
                开启后自动执行后端白名单中的测试、构建和只读 Git 命令；未知命令仍需审批，危险命令始终拒绝。
              </span>
            </span>
            <button
              type="button"
              className={trustReadOnlyCommands ? "btn btn--sm" : "btn btn--ghost btn--sm"}
              aria-pressed={trustReadOnlyCommands}
              onClick={() => setTrustReadOnlyCommands(!trustReadOnlyCommands)}
            >
              {trustReadOnlyCommands ? "已开启" : "已关闭"}
            </button>
          </div>
          {supportsKernelSandbox() ? (
            <>
              <div className="list-row">
                <span className="list-row__main">
                  <span className="list-row__title">内核级沙箱（macOS Seatbelt）</span>
                  <span className="list-row__desc">
                    开启后模型触发的命令由系统内核强制限制写入范围：只允许写当前项目目录与工具链缓存，
                    越界写入会被拦下并回填可读原因。系统未提供 sandbox-exec 时自动降级为不限制。
                  </span>
                </span>
                <button
                  type="button"
                  className={sandboxEnabled ? "btn btn--sm" : "btn btn--ghost btn--sm"}
                  aria-pressed={sandboxEnabled}
                  onClick={() => setSandboxEnabled(!sandboxEnabled)}
                >
                  {sandboxEnabled ? "已开启" : "已关闭"}
                </button>
              </div>
              <div className="list-row">
                <span className="list-row__main">
                  <span className="list-row__title">允许沙箱内命令联网</span>
                  <span className="list-row__desc">
                    关闭后沙箱内的命令无法访问网络，会打断依赖安装与联网检索；仅在需要完全断网验证时关闭。
                  </span>
                </span>
                <button
                  type="button"
                  className={sandboxAllowNetwork ? "btn btn--sm" : "btn btn--ghost btn--sm"}
                  aria-pressed={sandboxAllowNetwork}
                  onClick={() => setSandboxAllowNetwork(!sandboxAllowNetwork)}
                >
                  {sandboxAllowNetwork ? "已开启" : "已关闭"}
                </button>
              </div>
            </>
          ) : null}
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">命令执行权限</span>
              <span className="list-row__desc">
                档位按会话生效，在输入框里模型右侧的权限选择器中调整。当前会话：{permissionModeLabel}。
                「每次询问」与「只读自动」仅自动执行静态白名单内的命令，其余需要确认；
                「全部自动」除危险命令与已撤销的命令外一律直接执行。
              </span>
            </span>
            <span className="muted">{permissionModeLabel}</span>
          </div>
          {autoApprovalDenylist.length > 0 ? (
            <div className="list-row">
              <span className="list-row__main">
                <span className="list-row__title">已撤销自动批准的命令</span>
                <span className="list-row__desc">{autoApprovalDenylist.join("、")}</span>
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={clearAutoApprovalDenylist}>
                清空撤销记录
              </button>
            </div>
          ) : null}
        </div>

        </SettingsGroup>

        <SettingsGroup category="runtime" active={category}>
        <ComputerSettings />
        <div className="page__section">
          <div className="page__section-label">单次运行的上限</div>
          <p className="page__desc">
            一次请求可能因为工具调用产生多轮往返。达到任一项上限时会停止本次运行、在会话里给出提示，
            并把该次运行记为未完成；调大上限可让更长的任务跑完。轮数与时长填 0 都表示不限，
            但两者同时为 0 时本次运行将没有任何自动停止条件，只能手动停止。
          </p>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">工具调用轮数上限</span>
              <span className="list-row__desc">
                达到后不再向模型提供工具，强制它给出结论。与命令行版的 max_iterations 对齐，默认 10
                轮；填 0 表示不限轮数。
              </span>
            </span>
            <input
              className="form__input"
              style={{ width: 88 }}
              type="number"
              min={0}
              value={maxToolRounds}
              aria-label="工具调用轮数上限"
              onChange={(event) => {
                const next = readLimitInput(event.target.value);
                if (next !== null) setMaxToolRounds(next);
              }}
            />
          </div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">单次运行时长上限（分钟）</span>
              <span className="list-row__desc">
                从本次运行开始计时，超时即停止。与命令行版的 max_duration_secs 对齐，默认 30
                分钟；填 0 表示不限时长。
              </span>
            </span>
            <input
              className="form__input"
              style={{ width: 88 }}
              type="number"
              min={0}
              value={Math.round(maxRunDurationSecs / 60)}
              aria-label="单次运行时长上限（分钟）"
              onChange={(event) => {
                const next = readLimitInput(event.target.value);
                if (next !== null) setMaxRunDurationSecs(next * 60);
              }}
            />
          </div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">单次运行 token 上限</span>
              <span className="list-row__desc">
                按服务端返回的累计用量判定；填 0 表示不限。与命令行版的 max_total_tokens 对齐。
              </span>
            </span>
            <input
              className="form__input"
              style={{ width: 120 }}
              type="number"
              min={0}
              value={maxRunTokens ?? 0}
              aria-label="单次运行 token 上限"
              onChange={(event) => {
                const next = readLimitInput(event.target.value);
                if (next !== null) setMaxRunTokens(next);
              }}
            />
          </div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">模型请求重试次数</span>
              <span className="list-row__desc">
                模型请求失败（网络中断、服务端瞬时错误）时自动按指数退避重试，重试耗尽才停止任务，
                尽量不让一次抖动打断整轮运行；重试过程会在会话里逐次提示。默认 3 次；填 0
                表示关闭重试、失败立即停止。
              </span>
            </span>
            <input
              className="form__input"
              style={{ width: 88 }}
              type="number"
              min={0}
              max={20}
              value={modelRetryCount}
              aria-label="模型请求重试次数"
              onChange={(event) => {
                const next = readLimitInput(event.target.value);
                if (next !== null) setModelRetryCount(next);
              }}
            />
          </div>
        </div>

        <div className="page__section">
          <div className="page__section-label">上下文自动压缩</div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">压缩阈值（token）</span>
              <span className="list-row__desc">
                每次发起请求前估算整段上下文，超过该阈值就把最旧的若干条消息折叠进一段滚动摘要，
                让请求保持在模型的上下文窗口内；摘要会随会话保存。默认 100000，
                大致对应 128k~200k 窗口模型的安全区间；填 0 表示关闭自动压缩。
              </span>
            </span>
            <input
              className="form__input"
              style={{ width: 120 }}
              type="number"
              min={0}
              value={contextCompactThresholdTokens}
              aria-label="上下文自动压缩阈值（token）"
              onChange={(event) => {
                const next = readLimitInput(event.target.value);
                if (next !== null) setContextCompactThresholdTokens(next);
              }}
            />
          </div>
        </div>

        {supportsBackgroundAgents() ? (
          <div className="page__section">
            <div className="page__section-label">后台定时</div>
            <div className="list-row">
              <span className="list-row__main">
                <span className="list-row__title">移除全部后台定时项</span>
                <span className="list-row__desc">
                  启用中的日常任务会注册为系统后台定时项，应用关闭后仍会按时唤起执行。 该按钮会卸载全部定时项并停用所有日常任务，
                  可逆且不影响已产生的运行记录。
                </span>
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={agentBusy}
                onClick={() => void removeAllAgents()}
              >
                {agentBusy ? "正在移除…" : "移除全部"}
              </button>
            </div>
            {agentMessage ? (
              <p className="page__desc" style={{ marginTop: 8 }}>
                {agentMessage}
              </p>
            ) : null}
          </div>
        ) : null}

        </SettingsGroup>

        <SettingsGroup category="storage" active={category}>
        <div className="page__section">
          <div className="page__section-label">缓存路径</div>
          <div className="path-box">
            <Icon name="folder" size={13} />
            {cachePath ?? "尚未配置"}
          </div>
          {cacheInfo ? (
            <p className="page__desc" style={{ marginTop: 8 }}>
              共 {cacheInfo.totalFiles} 个文件 · 占用 {formatBytes(cacheInfo.totalBytes)} ·{" "}
              {cacheInfo.subdirs.map((item) => `${item.name} ${item.fileCount}`).join(" / ")}
            </p>
          ) : null}
          <div className="login__actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={cacheBusy}
              onClick={() => void chooseCacheDir()}
            >
              更换目录
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={cacheBusy}
              onClick={() => void clearTempCache()}
            >
              清空临时文件
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={cacheBusy}
              onClick={() => void refreshCache()}
            >
              刷新
            </button>
          </div>
          <p className="page__desc" style={{ marginTop: 8 }}>
            运行日志、会话记录、生成产物与运行时临时文件都写入该目录，清空临时文件不会影响会话记录。
          </p>
          {cacheError ? (
            <p className="page__desc" style={{ marginTop: 8 }}>
              {cacheError}
            </p>
          ) : null}
        </div>

        </SettingsGroup>

        <SettingsGroup category="advanced" active={category}>
        <div className="page__section">
          <div className="page__section-label">模型调用转储</div>
          <div className="list-row">
            <span className="list-row__main">
              <span className="list-row__title">记录发给模型的内容与返回原文</span>
              <span className="list-row__desc">
                开启后按运行写入缓存目录的 logs/model-trace/ 下，每行一条 JSON：请求体、原始
                SSE 分片、协议终态与 Agent、工具执行事件，用于排查模型实际收到的内容与执行路径。
                开关变化只影响后续运行；已启用转储的运行会继续记录至结束。
                常见凭据会隐藏，图片仅保留 MIME 与字节数；正文与工具结果仍会保留，不保证完全脱敏。
                会话中的「执行详情」默认折叠并随消息保存，不依赖此开关。
              </span>
            </span>
            <button
              type="button"
              className={modelTraceEnabled ? "btn btn--sm" : "btn btn--ghost btn--sm"}
              aria-pressed={modelTraceEnabled}
              onClick={() => setModelTraceEnabled(!modelTraceEnabled)}
            >
              {modelTraceEnabled ? "已开启" : "已关闭"}
            </button>
          </div>
          <p className="page__desc" style={{ marginTop: 8 }}>
            转储会随对话量增长，排查完建议关掉；已有记录保存在缓存目录的 logs/model-trace/
            下，删除该目录即可清理（「清空临时文件」不会动它）。
          </p>
        </div>

        </SettingsGroup>

        <SettingsGroup category="about" active={category}>
        <div className="page__section">
          <div className="page__section-label">关于</div>
          <div className="list-row">
            <Icon name="info" size={15} />
            <span className="list-row__main">
              <span className="list-row__title">
                {APP_NAME} 桌面 AI 客户端 {APP_VERSION}
              </span>
              <span className="list-row__desc">
                本地优先的 AI 工作终端，模型接入与数据都由你自己掌控。
              </span>
            </span>
          </div>
        </div>
        </SettingsGroup>
        </section>
      </div>
    </div>
  );
}
