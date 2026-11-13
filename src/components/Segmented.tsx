interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/**
 * 分段选择器（开发者 Jan）：单选语义，用 `role="radiogroup"` + `aria-checked` 交给读屏软件。
 *
 * 泛型参数让 `value` 与 `options` 的取值收敛到同一字面量联合，调用方传入非法取值会直接编译报错。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={
            option.value === value ? "segmented__item segmented__item--active" : "segmented__item"
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
