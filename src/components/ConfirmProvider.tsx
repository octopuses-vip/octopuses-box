import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * 全局确认弹窗（开发者 Jan）。
 *
 * 原先各处用 `window.confirm` 做二次确认，但 Tauri 的 WebView2 默认关闭脚本对话框，
 * 该调用不会弹出任何界面、直接返回，等于确认环节整个失效。这里改为应用内自绘模态框：
 * 复用现有的 `.overlay` / `.modal` 样式，跟随主题配色，浏览器调试环境同样可用。
 */

/** 确认弹窗的可配置项 */
export interface ConfirmOptions {
  /** 标题，缺省为「确认操作」 */
  title?: string;
  /** 正文：说明这次操作的后果 */
  message: string;
  /** 确认按钮文案，缺省为「确认」 */
  confirmText?: string;
  /** 取消按钮文案，缺省为「取消」 */
  cancelText?: string;
  /** 危险操作（删除等）：确认按钮标红，并把初始焦点放在「取消」上防误触 */
  danger?: boolean;
}

/** 打开确认弹窗并等待用户选择；true 表示确认，false 表示取消 */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

/** 多选弹窗里的一个动作：点它即以该 `value` 兑现 */
export interface ChooseAction<T extends string> {
  /** 按钮文案 */
  label: string;
  /** 选中后交回调用方的值 */
  value: T;
  /** 按钮样式，缺省 `ghost`；要主推的那个用 `primary` */
  variant?: "primary" | "ghost" | "danger";
  /** 悬停说明：解释这个选择的后果 */
  title?: string;
}

/** 多选弹窗的可配置项 */
export interface ChooseOptions<T extends string> {
  /** 标题，缺省为「请选择」 */
  title?: string;
  /** 正文：说明这次选择在分什么叉 */
  message: string;
  /**
   * 可选动作，按给出顺序渲染（都在右侧）。
   *
   * **把更安全的那个放在前面**：第一个动作拿初始焦点，回车即落在它身上，
   * 与 `danger` 把焦点放到「取消」是同一个取舍——别让误触直接选中有破坏性的那个。
   */
  actions: ChooseAction<T>[];
  /** 取消按钮文案，缺省为「取消」 */
  cancelText?: string;
}

/** 打开多选弹窗并等待用户选择；返回所选动作的 `value`，取消 / 关掉为 null */
export type ChooseFn = <T extends string>(options: ChooseOptions<T>) => Promise<T | null>;

/** 当前未决的弹窗：两键确认与多选共用一套遮罩 / 卡片，只是底部按钮不同 */
type PendingRequest =
  | { kind: "confirm"; options: ConfirmOptions }
  | { kind: "choose"; options: ChooseOptions<string> };

const DEFAULT_TITLE = "确认操作";
const DEFAULT_CONFIRM_TEXT = "确认";
const DEFAULT_CANCEL_TEXT = "取消";
const DEFAULT_CHOOSE_TITLE = "请选择";

const ConfirmContext = createContext<ConfirmFn | null>(null);
const ChooseContext = createContext<ChooseFn | null>(null);

/**
 * 确认弹窗容器：在应用最顶层挂载一次，内部用 useConfirm / useChoose 取用（开发者 Jan）。
 *
 * 两种形态共用同一个未决槽位（而不是各挂一套弹窗）：同一时刻只能有一个弹窗这件事，
 * 由容器统一保证，调用方不必自己防叠层。
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  /** 当前未决请求的兑现函数；`null` = 用户关掉 / 取消，布尔 = 确认结果，字符串 = 多选结果 */
  const resolverRef = useRef<((result: boolean | string | null) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // 同一时刻只呈现一个弹窗：上一次未决请求按取消收尾，避免叠层
      resolverRef.current?.(null);
      resolverRef.current = (result) => resolve(result === true);
      setPending({ kind: "confirm", options });
    });
  }, []);

  const choose = useCallback(
    <T extends string>(options: ChooseOptions<T>) =>
      new Promise<T | null>((resolve) => {
        resolverRef.current?.(null);
        resolverRef.current = (result) =>
          resolve(typeof result === "string" ? (result as T) : null);
        setPending({ kind: "choose", options });
      }),
    [],
  );

  /** 兑现未决请求；`null` 表示取消 / Esc / 点遮罩 */
  const settle = useCallback((result: boolean | string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(result);
  }, []);

  // Esc 关掉当前弹窗，行为与点遮罩、点「取消」一致
  useEffect(() => {
    if (!pending) return;
/** 函数级说明（开发者 Jan）：执行 onKeyDown 的单一职责，并返回可供调用方继续处理的结果。 */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") settle(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, settle]);

  const title = pending
    ? pending.kind === "confirm"
      ? pending.options.title ?? DEFAULT_TITLE
      : pending.options.title ?? DEFAULT_CHOOSE_TITLE
    : DEFAULT_TITLE;
  const message = pending?.options.message ?? "";
  const cancelText = pending?.options.cancelText ?? DEFAULT_CANCEL_TEXT;
  const isDanger = pending?.kind === "confirm" && pending.options.danger === true;

  return (
    <ConfirmContext.Provider value={confirm}>
      <ChooseContext.Provider value={choose}>
        {children}
        {pending ? (
          <div className="overlay overlay--center" onMouseDown={() => settle(null)}>
            <div
              className="modal modal--confirm"
              role="dialog"
              aria-modal="true"
              aria-label={title}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="modal__head">
                <span className="modal__title">{title}</span>
              </div>
              <div className="modal__body modal__body--plain">{message}</div>
              <div className="modal__foot">
                <button
                  type="button"
                  className="btn btn--ghost"
                  /* 焦点只交给一个按钮（开发者 Jan）： dangerous 给「取消」，多选给第一个动作 */
                  autoFocus={isDanger}
                  onClick={() => settle(null)}
                >
                  {cancelText}
                </button>
                {pending.kind === "confirm" ? (
                  <button
                    type="button"
                    className={isDanger ? "btn btn--danger" : "btn btn--primary"}
                    autoFocus={!isDanger}
                    onClick={() => settle(true)}
                  >
                    {pending.options.confirmText ?? DEFAULT_CONFIRM_TEXT}
                  </button>
                ) : (
                  pending.options.actions.map((action, index) => (
                    <button
                      key={action.value}
                      type="button"
                      className={
                        action.variant === "primary"
                          ? "btn btn--primary"
                          : action.variant === "danger"
                            ? "btn btn--danger"
                            : "btn btn--ghost"
                      }
                      /* 首个动作接走焦点（开发者 Jan）：调用方把更安全的那个放前面，
                         与 danger 时焦点落在「取消」同一个道理——别让误触直接选中有破坏性的那个 */
                      autoFocus={index === 0}
                      title={action.title}
                      onClick={() => settle(action.value)}
                    >
                      {action.label}
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}
      </ChooseContext.Provider>
    </ConfirmContext.Provider>
  );
}

/** 取用全局确认弹窗；只能在 ConfirmProvider 内调用（开发者 Jan） */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm 必须在 ConfirmProvider 内使用");
  return confirm;
}

/** 取用全局多选弹窗；只能在 ConfirmProvider 内调用（开发者 Jan） */
export function useChoose(): ChooseFn {
  const choose = useContext(ChooseContext);
  if (!choose) throw new Error("useChoose 必须在 ConfirmProvider 内使用");
  return choose;
}
