import { useMemo, useState } from "react";

import type { ClarificationQuestion, QuestionAnswers } from "../../app/types";
import { Icon } from "../../components/Icon";

interface QuestionCardProps {
  /** 本轮要一次确认的 1-3 个独立问题 */
  questions: ClarificationQuestion[];
  /** 已提交的答案，未回答为 null */
  answers: QuestionAnswers | null;
  /** 运行中或已回答时禁用操作 */
  disabled: boolean;
  onSubmit: (answers: QuestionAnswers) => void;
}

/** 自由输入选项的内部标识，不会写入消息或发送给模型 */
const OTHER = "__other__";

/** 需求确认卡片：逐题选择或填写「其他」，全部完成后统一提交 */
export function QuestionCard({ questions, answers, disabled, onSubmit }: QuestionCardProps) {
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    if (!answers) return {};
    return Object.fromEntries(
      Object.entries(answers).map(([id, values]) => [
        id,
        values[0] === "user_note" ? OTHER : values[0] ?? "",
      ]),
    );
  });
  const [custom, setCustom] = useState<Record<string, string>>(() => {
    if (!answers) return {};
    return Object.fromEntries(
      Object.entries(answers)
        .filter(([, values]) => values[0] === "user_note")
        .map(([id, values]) => [id, values.slice(1).join("\n")]),
    );
  });
  const answered = answers !== null;

  const resolved = useMemo<QuestionAnswers>(() => {
    if (answers) return answers;
    const next: QuestionAnswers = {};
    for (const question of questions) {
      const value = selected[question.id];
      if (value === OTHER) {
        const text = custom[question.id]?.trim();
        if (text) next[question.id] = ["user_note", text];
      } else if (value) {
        next[question.id] = [value];
      }
    }
    return next;
  }, [answers, custom, questions, selected]);

  const complete =
    questions.length > 0 &&
    questions.every((question) => resolved[question.id]?.length > 0);

  return (
    <div className="question-card">
      <div className="question-card__head">
        <span className="question-card__icon">
          <Icon name="info" size={14} />
        </span>
        <span className="question-card__title">需要你确认</span>
        <span className="spacer" />
        {answered ? <span className="question-card__meta">已回答</span> : null}
      </div>

      <div className="question-card__questions">
        {questions.map((question, index) => {
          const submitted = answers?.[question.id];
          const current = submitted
            ? submitted[0] === "user_note"
              ? OTHER
              : submitted[0]
            : selected[question.id] ?? "";
          const answerText = submitted
            ? submitted[0] === "user_note"
              ? submitted.slice(1).join("\n")
              : submitted.join("、")
            : "";
          return (
            <section className="question-card__question" key={question.id}>
              <div className="question-card__question-head">
                <span className="question-card__index">{index + 1}</span>
                <span className="question-card__header">{question.header}</span>
              </div>
              <div className="question-card__text">{question.question}</div>

              {answered ? (
                <div className="question-card__answer">{answerText}</div>
              ) : (
                <div className="question-card__options">
                  {question.options.map((option, optionIndex) => (
                    <button
                      type="button"
                      key={option.label}
                      disabled={disabled}
                      aria-pressed={current === option.label}
                      onClick={() =>
                        setSelected((previous) => ({ ...previous, [question.id]: option.label }))
                      }
                      className={
                        current === option.label
                          ? "question-option question-option--picked"
                          : "question-option"
                      }
                    >
                      <span className="question-option__label">
                        {option.label}
                        {optionIndex === 0 ? <span className="badge">推荐</span> : null}
                      </span>
                      <span className="question-option__description">{option.description}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={current === OTHER}
                    onClick={() =>
                      setSelected((previous) => ({ ...previous, [question.id]: OTHER }))
                    }
                    className={
                      current === OTHER
                        ? "question-option question-option--picked"
                        : "question-option"
                    }
                  >
                    <span className="question-option__label">其他</span>
                    <span className="question-option__description">输入不在建议中的答案。</span>
                  </button>
                  {current === OTHER ? (
                    <input
                      className="form__input question-card__custom"
                      autoFocus
                      value={custom[question.id] ?? ""}
                      placeholder="请输入你的答案"
                      disabled={disabled}
                      onChange={(event) =>
                        setCustom((previous) => ({
                          ...previous,
                          [question.id]: event.target.value,
                        }))
                      }
                    />
                  ) : null}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {!answered ? (
        <div className="question-card__foot">
          <span>请回答全部问题后继续</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={disabled || !complete}
            onClick={() => onSubmit(resolved)}
          >
            提交答案
          </button>
        </div>
      ) : null}
    </div>
  );
}
