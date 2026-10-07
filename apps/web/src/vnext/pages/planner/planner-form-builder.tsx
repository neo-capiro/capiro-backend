import { useState } from 'react';
import { ArrowUp, ArrowDown, Plus, Trash2 } from 'lucide-react';
import {
  PLANNER_STATUS_LABELS,
  type PlannerBootstrap,
  type PlannerFormData,
  type PlannerFormField,
  type PlannerProjectData,
} from '@capiro/strategy-verifier';
import { PlannerFormQuestions, type PlannerFormFiles } from './planner-form-questions.js';

const TYPES: Record<PlannerFormField['type'], string> = {
  text: 'Short text',
  paragraph: 'Long text',
  email: 'Email',
  date: 'Date',
  number: 'Number',
  select: 'Single choice',
  multi_select: 'Multiple choice',
  attachment: 'Attachment',
};
const TARGETS = {
  name: 'Task name',
  description: 'Description',
  startOn: 'Start date',
  dueOn: 'Due date',
  priority: 'Priority',
  estimateMinutes: 'Estimated minutes',
} as const;
const TARGET_TYPES = {
  name: 'text',
  description: 'paragraph',
  startOn: 'date',
  dueOn: 'date',
  priority: 'select',
  estimateMinutes: 'number',
} as const;
function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <label className="planner-field">
      <span>{name}</span>
      {children}
    </label>
  );
}
function choice(field: PlannerFormField) {
  return ['select', 'multi_select'].includes(field.type);
}
function depths(fields: PlannerFormField[]) {
  const result = new Map<string, number>();
  for (const field of fields)
    result.set(field.id, field.showWhen ? (result.get(field.showWhen.questionId) ?? 100) + 1 : 0);
  return result;
}
function ordered(fields: PlannerFormField[]) {
  const seen = new Set<string>();
  return fields.every((field) => {
    const valid = !field.showWhen || seen.has(field.showWhen.questionId);
    seen.add(field.id);
    return valid;
  });
}
export function plannerDuplicateFormData(config: PlannerFormData): PlannerFormData {
  const ids = new Map(config.fields.map((field) => [field.id, crypto.randomUUID()]));
  return {
    ...structuredClone(config),
    fields: config.fields.map((field) => ({
      ...structuredClone(field),
      id: ids.get(field.id)!,
      ...(field.showWhen
        ? { showWhen: { ...field.showWhen, questionId: ids.get(field.showWhen.questionId)! } }
        : {}),
    })),
    ...(config.titleFieldId ? { titleFieldId: ids.get(config.titleFieldId)! } : {}),
  };
}

export function PlannerFormBuilder({
  form,
  edit: save,
  project,
  people,
}: {
  form: PlannerFormData;
  edit: (patch: Record<string, unknown>) => void;
  project?: PlannerProjectData;
  people: PlannerBootstrap['people'];
}) {
  const [preview, setPreview] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, unknown>>({});
  const [previewFiles, setPreviewFiles] = useState<PlannerFormFiles>({});
  const levels = depths(form.fields);
  const titleId =
    form.titleFieldId === undefined
      ? (form.fields.find((field) => field.taskField === 'name')?.id ?? '')
      : (form.titleFieldId ?? '');
  const edit = (changes: Record<string, unknown>) =>
    save({
      ...(form.titleFieldId === undefined ? { titleFieldId: titleId || null } : {}),
      ...changes,
    });
  const patch = (id: string, changes: Partial<PlannerFormField>) =>
    edit({
      fields: form.fields.map((field) => (field.id === id ? { ...field, ...changes } : field)),
    });
  const move = (index: number, offset: number) => {
    const fields = [...form.fields];
    [fields[index], fields[index + offset]] = [fields[index + offset]!, fields[index]!];
    return fields;
  };
  return (
    <>
      <div className="planner-form-builder-toolbar">
        <h3>Questions</h3>
        <button
          type="button"
          onClick={() => {
            setPreview((old) => !old);
            setPreviewAnswers({});
            setPreviewFiles({});
          }}
        >
          {preview ? 'Edit questions' : 'Preview form'}
        </button>
      </div>
      {preview ? (
        <section className="planner-form-preview" aria-label="Form preview">
          <p className="planner-muted">
            Try your questions and branches here. Preview responses are not submitted.
          </p>
          <PlannerFormQuestions
            fields={form.fields}
            answers={previewAnswers}
            setAnswers={setPreviewAnswers}
            files={previewFiles}
            setFiles={setPreviewFiles}
            preview
          />
        </section>
      ) : (
        <>
          {form.fields.map((field, index) => {
            const parents = form.fields
              .slice(0, index)
              .filter((parent) => choice(parent) && (levels.get(parent.id) ?? 0) < 5);
            const parent = form.fields.find(
              (candidate) => candidate.id === field.showWhen?.questionId,
            );
            const hasChildren = form.fields.some(
              (candidate) => candidate.showWhen?.questionId === field.id,
            );
            const mapping =
              field.taskField === 'custom'
                ? `custom:${field.customFieldId}`
                : (field.taskField ?? '');
            const inUse = (target: string) =>
              form.fields.some(
                (other) =>
                  other.id !== field.id &&
                  (other.taskField === 'custom'
                    ? `custom:${other.customFieldId}`
                    : (other.taskField ?? '')) === target,
              );
            return (
              <fieldset className="planner-form-question" key={field.id}>
                <legend>
                  Question {index + 1}
                  {field.showWhen ? ` · Branch level ${levels.get(field.id)}` : ''}
                </legend>
                <div className="planner-head-actions">
                  <button
                    type="button"
                    aria-label={`Move question ${index + 1} up`}
                    disabled={!index || !ordered(move(index, -1))}
                    onClick={() => edit({ fields: move(index, -1) })}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move question ${index + 1} down`}
                    disabled={index === form.fields.length - 1 || !ordered(move(index, 1))}
                    onClick={() => edit({ fields: move(index, 1) })}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove question ${index + 1}`}
                    disabled={hasChildren || form.fields.length === 1}
                    onClick={() =>
                      edit({
                        fields: form.fields.filter((candidate) => candidate.id !== field.id),
                        ...(titleId === field.id ? { titleFieldId: null } : {}),
                      })
                    }
                  >
                    <Trash2 size={15} /> Remove
                  </button>
                </div>
                {hasChildren && (
                  <small className="planner-muted">
                    Remove or reconnect its branches before removing this question.
                  </small>
                )}
                <Field name={`Question ${index + 1}`}>
                  <input
                    required
                    maxLength={200}
                    value={field.label}
                    onChange={(event) => patch(field.id, { label: event.target.value })}
                  />
                </Field>
                <Field name="Question description">
                  <textarea
                    rows={2}
                    maxLength={5000}
                    value={field.description ?? ''}
                    onChange={(event) => patch(field.id, { description: event.target.value })}
                  />
                </Field>
                <div className="planner-form-grid">
                  <Field name="Question type">
                    <select
                      value={field.type}
                      onChange={(event) => {
                        const type = event.target.value as PlannerFormField['type'];
                        patch(field.id, {
                          type,
                          taskField: type === 'attachment' ? 'attachments' : null,
                          customFieldId: undefined,
                          multiple: undefined,
                          maxLength: undefined,
                          options: ['select', 'multi_select'].includes(type)
                            ? field.options.length
                              ? field.options
                              : ['Option 1', 'Option 2']
                            : [],
                        });
                        if (type === 'attachment' && titleId === field.id)
                          edit({ titleFieldId: null });
                      }}
                    >
                      {Object.entries(TYPES).map(([type, label]) => (
                        <option
                          key={type}
                          value={type}
                          disabled={hasChildren && !['select', 'multi_select'].includes(type)}
                        >
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field name="Save answer to">
                    <select
                      value={mapping}
                      disabled={field.type === 'attachment'}
                      onChange={(event) => {
                        const target = event.target.value;
                        if (target.startsWith('custom:')) {
                          const custom = project?.fields.find(
                            (candidate) => candidate.id === target.slice(7),
                          );
                          if (custom)
                            patch(field.id, {
                              taskField: 'custom',
                              customFieldId: custom.id,
                              type: custom.type,
                              options: [...custom.options],
                              multiple: undefined,
                              maxLength: undefined,
                            });
                        } else if (!target)
                          patch(field.id, { taskField: null, customFieldId: undefined });
                        else {
                          const taskField = target as keyof typeof TARGETS;
                          patch(field.id, {
                            taskField,
                            customFieldId: undefined,
                            type: TARGET_TYPES[taskField],
                            options:
                              taskField === 'priority' ? ['none', 'low', 'medium', 'high'] : [],
                            multiple: undefined,
                            maxLength: undefined,
                          });
                        }
                      }}
                    >
                      <option value="">Answers in description only</option>
                      {field.type === 'attachment' && (
                        <option value="attachments">Task attachments</option>
                      )}
                      {Object.entries(TARGETS).map(([target, label]) => (
                        <option
                          key={target}
                          value={target}
                          disabled={
                            inUse(target) ||
                            (hasChildren &&
                              TARGET_TYPES[target as keyof typeof TARGET_TYPES] !== 'select')
                          }
                        >
                          {label}
                        </option>
                      ))}
                      {project?.fields.map((custom) => (
                        <option
                          key={custom.id}
                          value={`custom:${custom.id}`}
                          disabled={
                            inUse(`custom:${custom.id}`) ||
                            (hasChildren && !['select', 'multi_select'].includes(custom.type))
                          }
                        >
                          Custom field: {custom.name}
                        </option>
                      ))}
                      {field.taskField === 'custom' &&
                        !project?.fields.some((custom) => custom.id === field.customFieldId) && (
                          <option value={mapping}>
                            Unavailable custom field — choose a new mapping
                          </option>
                        )}
                    </select>
                  </Field>
                </div>
                {choice(field) && (
                  <Field name="Choices (one per line)">
                    <textarea
                      required
                      rows={3}
                      maxLength={20_100}
                      value={field.options.join('\n')}
                      onChange={(event) =>
                        patch(field.id, { options: event.target.value.split('\n') })
                      }
                    />
                  </Field>
                )}
                <label className="planner-check">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(event) => patch(field.id, { required: event.target.checked })}
                  />{' '}
                  Required question
                </label>
                {field.type === 'attachment' && (
                  <label className="planner-check">
                    <input
                      type="checkbox"
                      checked={field.multiple ?? false}
                      onChange={(event) => patch(field.id, { multiple: event.target.checked })}
                    />{' '}
                    Allow multiple files
                  </label>
                )}
                {['text', 'paragraph', 'email'].includes(field.type) && (
                  <Field name="Maximum characters">
                    <input
                      type="number"
                      min={1}
                      max={
                        field.taskField === 'name'
                          ? 500
                          : field.taskField === 'custom'
                            ? 5000
                            : 50_000
                      }
                      value={field.maxLength ?? ''}
                      placeholder="Default limit"
                      onChange={(event) =>
                        patch(field.id, {
                          maxLength: event.target.value ? Number(event.target.value) : undefined,
                        })
                      }
                    />
                  </Field>
                )}
                <Field name="Show this question">
                  <select
                    value={field.showWhen?.questionId ?? ''}
                    onChange={(event) => {
                      const selected = parents.find(
                        (candidate) => candidate.id === event.target.value,
                      );
                      patch(field.id, {
                        showWhen: selected
                          ? { questionId: selected.id, values: [selected.options[0]!] }
                          : undefined,
                      });
                    }}
                  >
                    <option value="">Always</option>
                    {parents.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        When: {candidate.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {field.showWhen && (
                  <fieldset className="planner-form-choices">
                    <legend>When the answer includes any of</legend>
                    {parent?.options.map((option) => (
                      <label key={option}>
                        <input
                          type="checkbox"
                          checked={field.showWhen!.values.includes(option)}
                          onChange={(event) =>
                            patch(field.id, {
                              showWhen: {
                                questionId: parent.id,
                                values: parent.options.filter((value) =>
                                  value === option
                                    ? event.target.checked
                                    : field.showWhen!.values.includes(value),
                                ),
                              },
                            })
                          }
                        />{' '}
                        {option}
                      </label>
                    ))}
                    {!field.showWhen.values.length && (
                      <p className="planner-error">Choose at least one response.</p>
                    )}
                    {field.showWhen.values.some((value) => !parent?.options.includes(value)) && (
                      <p className="planner-error">
                        A parent choice was removed. Update this branch before saving.
                      </p>
                    )}
                  </fieldset>
                )}
              </fieldset>
            );
          })}
          <button
            type="button"
            disabled={form.fields.length >= 100}
            onClick={() =>
              edit({
                fields: [
                  ...form.fields,
                  {
                    id: crypto.randomUUID(),
                    label: 'New question',
                    type: 'text',
                    taskField: null,
                    required: false,
                    options: [],
                  },
                ],
                ...(form.titleFieldId === undefined ? { titleFieldId: titleId || null } : {}),
              })
            }
          >
            <Plus size={15} /> Add question
          </button>
        </>
      )}
      <h3>Submission settings</h3>
      <Field name="Task title">
        <select
          value={titleId}
          onChange={(event) => edit({ titleFieldId: event.target.value || null })}
        >
          <option value="">Use form name</option>
          {form.fields
            .filter((field) => field.type !== 'attachment')
            .map((field) => (
              <option key={field.id} value={field.id}>
                {field.label}
              </option>
            ))}
        </select>
      </Field>
      <Field name="Task section">
        <select
          value={form.sectionId === undefined ? '__first' : (form.sectionId ?? '')}
          onChange={(event) =>
            edit({
              sectionId:
                event.target.value === '__first'
                  ? (project?.sections[0]?.id ?? null)
                  : event.target.value || null,
            })
          }
        >
          <option value="__first">First project section</option>
          <option value="">No section</option>
          {project?.sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.name}
            </option>
          ))}
          {form.sectionId &&
            !project?.sections.some((section) => section.id === form.sectionId) && (
              <option value={form.sectionId}>Unavailable section — choose a new section</option>
            )}
        </select>
      </Field>
      <div className="planner-form-grid">
        <Field name="Default assignee">
          <select
            value={form.defaults.assigneeId ?? ''}
            onChange={(event) =>
              edit({ defaults: { ...form.defaults, assigneeId: event.target.value || null } })
            }
          >
            <option value="">Unassigned</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Default status">
          <select
            value={form.defaults.status}
            onChange={(event) =>
              edit({ defaults: { ...form.defaults, status: event.target.value } })
            }
          >
            {Object.entries(PLANNER_STATUS_LABELS).map(([status, label]) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Default priority">
          <select
            value={form.defaults.priority}
            onChange={(event) =>
              edit({ defaults: { ...form.defaults, priority: event.target.value } })
            }
          >
            {['none', 'low', 'medium', 'high'].map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Default estimate (minutes)">
          <input
            type="number"
            min={0}
            max={100_000}
            value={form.defaults.estimateMinutes}
            onChange={(event) =>
              edit({ defaults: { ...form.defaults, estimateMinutes: Number(event.target.value) } })
            }
          />
        </Field>
      </div>
      <label className="planner-check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => edit({ enabled: event.target.checked })}
        />{' '}
        Accepting submissions
      </label>
      <label className="planner-check">
        <input
          type="checkbox"
          checked={form.copyAnswersToDescription ?? false}
          onChange={(event) => edit({ copyAnswersToDescription: event.target.checked })}
        />{' '}
        Copy all visible answers to the task description
      </label>
      {!form.copyAnswersToDescription && form.fields.some((field) => field.taskField === null) && (
        <p className="planner-muted">
          Unmapped answers are not retained when copying answers is turned off.
        </p>
      )}
      <label className="planner-check">
        <input
          type="checkbox"
          checked={form.addSubmitterAsCollaborator ?? false}
          onChange={(event) => edit({ addSubmitterAsCollaborator: event.target.checked })}
        />{' '}
        Add signed-in submitters as task collaborators
      </label>
      <Field name="Form access">
        <select
          value={form.audience ?? 'public'}
          onChange={(event) => edit({ audience: event.target.value })}
        >
          <option value="organization">Signed-in project members</option>
          <option value="public">Anyone with the link</option>
        </select>
      </Field>
      <p className="planner-muted">
        Signed-in submissions require access to this project. Public links are created separately.
        Choosing signed-in access revokes an existing public link.
      </p>
      <Field name="Confirmation message">
        <textarea
          rows={3}
          maxLength={5000}
          value={form.confirmationMessage ?? ''}
          placeholder="Your response has been sent to the team."
          onChange={(event) => edit({ confirmationMessage: event.target.value })}
        />
      </Field>
      <label className="planner-check">
        <input
          type="checkbox"
          checked={form.allowAnotherSubmission ?? false}
          onChange={(event) => edit({ allowAnotherSubmission: event.target.checked })}
        />{' '}
        Let submitters send another response
      </label>
    </>
  );
}
