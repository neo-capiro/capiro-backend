import { useState } from 'react';
import { ExperimentOutlined } from '@ant-design/icons';

/**
 * A question can be plain free-text (Deep Research's original shape — just
 * the prompt string) or carry fixed choices (`{question, choices, multiSelect}`).
 * Choice-bearing questions render checkboxes/radios instead of a textarea;
 * everything else about the form (layout, Skip, submit) is shared.
 */
export type ResearchClarifyQuestion =
  | string
  | { question: string; choices?: string[]; multiSelect?: boolean };

interface ResearchClarifyFormProps {
  questions: ResearchClarifyQuestion[];
  disabled?: boolean;
  /** Hidden when the caller has no meaningful "proceed without answering" — durable
   * Hermes clarifications must always be answered, so approval-style callers omit this. */
  allowSkip?: boolean;
  submitLabel?: string;
  headline?: string;
  onSubmit: (answers: Record<string, string>, skipped: boolean) => void;
}

function questionText(q: ResearchClarifyQuestion): string {
  return typeof q === 'string' ? q : q.question;
}
function questionChoices(q: ResearchClarifyQuestion): string[] {
  return typeof q === 'string' ? [] : (q.choices ?? []);
}
function questionMultiSelect(q: ResearchClarifyQuestion): boolean {
  return typeof q === 'string' ? false : Boolean(q.multiSelect) && questionChoices(q).length > 0;
}

/**
 * Inline clarifying-questions form rendered inside the Meri chat (Claude-style):
 * one field per question, a primary action, and (when `allowSkip`) a "Skip"
 * affordance that lets Meri proceed with its own assumptions. Answers are keyed
 * by question index to match the backend's clarify contract.
 */
export function ResearchClarifyForm({
  questions,
  disabled,
  allowSkip = true,
  submitLabel = 'Run deep research',
  headline = 'A few quick questions before I dig in',
  onSubmit,
}: ResearchClarifyFormProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const setSingleChoice = (key: string, value: string) => {
    setSelections((prev) => ({ ...prev, [key]: [value] }));
  };
  const toggleChoice = (key: string, value: string) => {
    setSelections((prev) => {
      const current = prev[key] ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, [key]: next };
    });
  };

  const submit = () => {
    if (disabled) return;
    const merged: Record<string, string> = { ...answers };
    for (const [key, values] of Object.entries(selections)) {
      if (values.length) merged[key] = values.join(', ');
    }
    onSubmit(merged, false);
  };

  return (
    <div className="chat-clarify">
      <div className="chat-clarify-head">
        <ExperimentOutlined />
        <span>{headline}</span>
      </div>
      <div className="chat-clarify-fields">
        {questions.map((q, i) => {
          const key = String(i);
          const choices = questionChoices(q);
          const multiSelect = questionMultiSelect(q);
          return (
            <div className="chat-clarify-field" key={i}>
              <label className="chat-clarify-q" htmlFor={choices.length ? undefined : `clarify-${i}`}>
                {questionText(q)}
              </label>
              {choices.length > 0 ? (
                <div className="chat-clarify-choices" role={multiSelect ? 'group' : 'radiogroup'}>
                  {choices.map((choice) => {
                    const selected = (selections[key] ?? []).includes(choice);
                    return (
                      <label className="chat-clarify-choice" key={choice}>
                        <input
                          type={multiSelect ? 'checkbox' : 'radio'}
                          name={`clarify-${i}`}
                          checked={selected}
                          disabled={disabled}
                          onChange={() =>
                            multiSelect ? toggleChoice(key, choice) : setSingleChoice(key, choice)
                          }
                        />
                        {choice}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  id={`clarify-${i}`}
                  className="chat-clarify-input"
                  rows={1}
                  disabled={disabled}
                  value={answers[key] ?? ''}
                  placeholder="Optional"
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                  }}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="chat-clarify-actions">
        <button type="button" className="chat-clarify-run" disabled={disabled} onClick={submit}>
          {submitLabel}
        </button>
        {allowSkip ? (
          <button
            type="button"
            className="chat-clarify-skip"
            disabled={disabled}
            onClick={() => onSubmit({}, true)}
          >
            Skip — use your best judgment
          </button>
        ) : null}
      </div>
    </div>
  );
}
