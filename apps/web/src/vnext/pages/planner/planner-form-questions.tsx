import { useEffect, useId, type Dispatch, type SetStateAction } from 'react';
import {
  plannerVisibleFormAnswers,
  plannerVisibleFormQuestions,
  type PlannerFormQuestion,
} from '@capiro/strategy-verifier';

export type PlannerFormAnswers = Record<string, unknown>;
export type PlannerFormFiles = Record<string, File[]>;
const LIMIT = 25 * 1024 * 1024;

export function plannerFormSubmissionError(
  fields: PlannerFormQuestion[],
  answers: PlannerFormAnswers,
  files: PlannerFormFiles,
) {
  const visible = plannerVisibleFormQuestions(fields, answers);
  const uploads = visible.flatMap((field) =>
    field.type === 'attachment' ? (files[field.id] ?? []) : [],
  );
  if (uploads.length > 10 || uploads.reduce((sum, file) => sum + file.size, 0) > LIMIT)
    return 'Choose up to ten files totaling 25 MB or less.';
  if (uploads.some((file) => !file.size)) return 'Choose a nonempty attachment.';
  for (const field of visible) {
    const value = field.type === 'attachment' ? files[field.id] : answers[field.id];
    if (
      field.required &&
      (value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && !value.length))
    )
      return `${field.label} is required.`;
    if (field.type === 'attachment' && !field.multiple && (files[field.id]?.length ?? 0) > 1)
      return `${field.label} accepts one file.`;
  }
  return null;
}

export function plannerFormSubmissionBody(
  fields: PlannerFormQuestion[],
  answers: PlannerFormAnswers,
  files: PlannerFormFiles = {},
): PlannerFormAnswers | FormData {
  const values = plannerVisibleFormAnswers(fields, answers);
  for (const field of fields.filter((question) => question.type === 'attachment'))
    delete values[field.id];
  const uploads = plannerVisibleFormQuestions(fields, answers).flatMap((field) =>
    field.type === 'attachment'
      ? (files[field.id] ?? []).map((file) => ({ id: field.id, file }))
      : [],
  );
  if (!uploads.length) return values;
  const body = new FormData();
  body.append('answers', JSON.stringify(values));
  for (const upload of uploads) body.append(upload.id, upload.file, upload.file.name);
  return body;
}

export function PlannerFormQuestions({
  fields,
  answers,
  setAnswers,
  files,
  setFiles,
  preview = false,
}: {
  fields: PlannerFormQuestion[];
  answers: PlannerFormAnswers;
  setAnswers: Dispatch<SetStateAction<PlannerFormAnswers>>;
  files: PlannerFormFiles;
  setFiles: Dispatch<SetStateAction<PlannerFormFiles>>;
  preview?: boolean;
}) {
  const prefix = useId();
  useEffect(() => {
    const visible = new Set(plannerVisibleFormQuestions(fields, answers).map((field) => field.id));
    setFiles((old) =>
      Object.keys(old).some((id) => !visible.has(id))
        ? Object.fromEntries(Object.entries(old).filter(([id]) => visible.has(id)))
        : old,
    );
  }, [fields, answers, setFiles]);
  return (
    <div className="planner-form-questions">
      {plannerVisibleFormQuestions(fields, answers).map((field) => {
        const label = `${field.label}${field.required ? ' *' : ''}`;
        const describedBy = field.description ? `${prefix}-${field.id}-help` : undefined;
        const required = field.required && !preview;
        const maxLength = Math.min(
          field.maxLength ?? 50_000,
          'taskField' in field && field.taskField === 'name'
            ? 500
            : 'taskField' in field && field.taskField === 'custom'
              ? 5000
              : 50_000,
        );
        const change = (value: unknown) => setAnswers((old) => ({ ...old, [field.id]: value }));
        const description = field.description && (
          <p id={describedBy} className="planner-muted">
            {field.description}
          </p>
        );
        if (field.type === 'multi_select') {
          const selected = Array.isArray(answers[field.id]) ? (answers[field.id] as string[]) : [];
          return (
            <fieldset
              className="planner-form-choices"
              key={field.id}
              aria-describedby={describedBy}
            >
              <legend>{label}</legend>
              {description}
              {field.options.map((option) => (
                <label key={option}>
                  <input
                    type="checkbox"
                    checked={selected.includes(option)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setAnswers((old) => {
                        const values = Array.isArray(old[field.id])
                          ? (old[field.id] as string[])
                          : [];
                        return {
                          ...old,
                          [field.id]: field.options.filter((choice) =>
                            choice === option ? checked : values.includes(choice),
                          ),
                        };
                      });
                    }}
                  />{' '}
                  {option}
                </label>
              ))}
            </fieldset>
          );
        }
        return (
          <div className="planner-field" key={field.id}>
            <label htmlFor={`${prefix}-${field.id}`}>{label}</label>
            {description}
            {field.type === 'paragraph' ? (
              <textarea
                id={`${prefix}-${field.id}`}
                rows={4}
                required={required}
                aria-describedby={describedBy}
                maxLength={maxLength}
                value={String(answers[field.id] ?? '')}
                onChange={(event) => change(event.currentTarget.value)}
              />
            ) : field.type === 'select' ? (
              <select
                id={`${prefix}-${field.id}`}
                required={required}
                aria-describedby={describedBy}
                value={String(answers[field.id] ?? '')}
                onChange={(event) => change(event.currentTarget.value)}
              >
                <option value="">Choose…</option>
                {field.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.type === 'attachment' ? (
              <>
                <input
                  id={`${prefix}-${field.id}`}
                  type="file"
                  multiple={field.multiple}
                  required={required}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    const chosen = Array.from(event.currentTarget.files ?? []);
                    setFiles((old) => ({ ...old, [field.id]: chosen }));
                  }}
                />
                <small className="planner-muted">
                  {field.multiple ? 'Choose one or more files.' : 'Choose one file.'} Up to ten
                  files and 25 MB per response.
                </small>
              </>
            ) : (
              <input
                id={`${prefix}-${field.id}`}
                required={required}
                aria-describedby={describedBy}
                type={
                  field.type === 'number'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : field.type === 'email'
                        ? 'email'
                        : 'text'
                }
                step={field.type === 'number' ? 'any' : undefined}
                maxLength={maxLength}
                value={String(answers[field.id] ?? '')}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  change(field.type === 'number' ? (value === '' ? null : Number(value)) : value);
                }}
                onChange={() => {}}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
