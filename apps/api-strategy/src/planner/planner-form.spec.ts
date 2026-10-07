import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  plannerVisibleFormQuestions,
  type PlannerFormData,
  type PlannerFormField,
} from '@capiro/strategy-verifier';
import {
  plannerFormTaskValues,
  plannerPublicForm,
  validatePlannerForm,
  validatePlannerFormProject,
} from './planner-form.js';
import { validateTask } from './planner.validation.js';

const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const field = (n: number, patch: Partial<PlannerFormField> = {}): PlannerFormField => ({
  id: id(n),
  label: `Question ${n}`,
  type: 'text',
  taskField: null,
  required: false,
  options: [],
  ...patch,
});
const config = (
  fields: PlannerFormField[],
  patch: Partial<PlannerFormData> = {},
): PlannerFormData => ({
  description: 'Synthetic form',
  enabled: true,
  fields,
  titleFieldId: null,
  defaults: { assigneeId: null, priority: 'none', status: 'todo', estimateMinutes: 0 },
  ...patch,
});
const project = {
  ...PLANNER_DEFAULT_PROJECT,
  fields: [
    {
      id: id(50),
      name: 'Request kind',
      type: 'multi_select' as const,
      options: ['Design', 'Engineering'],
    },
    { id: id(51), name: 'Budget', type: 'number' as const, options: [] },
  ],
};

describe('Planner rich form intake', () => {
  it('preserves long mapped descriptions while bounding a chosen question title to 500 characters', () => {
    const description = 'D'.repeat(1200);
    const values = plannerFormTaskValues(
      config([field(1, { taskField: 'description', type: 'paragraph' })], { titleFieldId: id(1) }),
      project,
      'Fallback',
      { [id(1)]: description },
    );
    expect(values.description).toBe(description);
    expect(values.name).toBe('D'.repeat(500));
  });
  it('maps visible multi-select and numeric responses to the current project and copies question answers', () => {
    const form = config(
      [
        field(1, {
          type: 'multi_select',
          taskField: 'custom',
          customFieldId: id(50),
          options: ['Design', 'Engineering'],
          required: true,
        }),
        field(2, {
          type: 'number',
          taskField: 'custom',
          customFieldId: id(51),
          showWhen: { questionId: id(1), values: ['Engineering'] },
        }),
      ],
      { copyAnswersToDescription: true, titleFieldId: id(1) },
    );
    validatePlannerForm(form);
    const values = plannerFormTaskValues(form, project, 'Default title', {
      [id(1)]: ['Design', 'Engineering'],
      [id(2)]: -12.5,
    });
    expect(values.name).toBe('Design, Engineering');
    expect(values.customValues).toEqual({ [id(50)]: ['Design', 'Engineering'], [id(51)]: -12.5 });
    expect(values.description).toContain('Question 2: -12.5');
    expect(validateTask({ ...PLANNER_DEFAULT_TASK, ...values }).name).toBe('Design, Engineering');
  });
  it('ignores hidden required answers and stale descendants after a parent response changes', () => {
    const fields = [
      field(1, { type: 'select', options: ['Design', 'Engineering'] }),
      field(2, {
        type: 'select',
        options: ['Urgent', 'Routine'],
        required: true,
        showWhen: { questionId: id(1), values: ['Engineering'] },
      }),
      field(3, { required: true, showWhen: { questionId: id(2), values: ['Urgent'] } }),
    ];
    const answers = { [id(1)]: 'Design', [id(2)]: 'Urgent', [id(3)]: { malicious: 'not text' } };
    expect(plannerVisibleFormQuestions(fields, answers).map((question) => question.id)).toEqual([
      id(1),
    ]);
    expect(plannerFormTaskValues(config(fields), project, 'Fallback title', answers)).toEqual({
      name: 'Fallback title',
      customValues: {},
    });
    expect(() =>
      plannerFormTaskValues(config(fields), project, 'Fallback', { [id(1)]: 'Engineering' }),
    ).toThrow('required');
  });
  it('supports five branch levels but rejects a sixth, cycles, forward parents, and invalid choices', () => {
    const fields = Array.from({ length: 6 }, (_, index) =>
      field(index + 1, {
        type: 'select',
        options: ['Yes', 'No'],
        ...(index ? { showWhen: { questionId: id(index), values: ['Yes'] } } : {}),
      }),
    );
    expect(validatePlannerForm(config(fields)).fields).toHaveLength(6);
    expect(() =>
      validatePlannerForm(
        config([...fields, field(7, { showWhen: { questionId: id(6), values: ['Yes'] } })]),
      ),
    ).toThrow('five');
    expect(() => validatePlannerForm(config([fields[1]!, fields[0]!]))).toThrow('earlier');
    expect(() =>
      validatePlannerForm(
        config([fields[0]!, field(2, { showWhen: { questionId: id(2), values: ['Yes'] } })]),
      ),
    ).toThrow('earlier');
    expect(() =>
      validatePlannerForm(
        config([fields[0]!, field(2, { showWhen: { questionId: id(1), values: ['Other'] } })]),
      ),
    ).toThrow('valid parent');
  });
  it('does not expose project field IDs, mapping targets, assignment, audience or internal settings publicly', () => {
    const form = config(
      [field(1, { type: 'number', taskField: 'custom', customFieldId: id(51) })],
      {
        confirmationMessage: 'Thank you',
        allowAnotherSubmission: true,
        audience: 'public',
        defaults: {
          assigneeId: 'private-member-id',
          priority: 'high',
          status: 'todo',
          estimateMinutes: 5,
        },
      },
    );
    const publicForm = plannerPublicForm('Shared intake', form);
    expect(publicForm.confirmationMessage).toBe('Thank you');
    expect(publicForm.allowAnotherSubmission).toBe(true);
    expect(JSON.stringify(publicForm)).not.toContain('customFieldId');
    expect(JSON.stringify(publicForm)).not.toContain(id(51));
    expect(JSON.stringify(publicForm)).not.toContain('private-member-id');
    expect(publicForm.fields[0]).not.toHaveProperty('taskField');
    expect(publicForm).not.toHaveProperty('audience');
  });
  it('rejects fields belonging to another project, changed field types/options, sections, and duplicate mappings', () => {
    const mapped = field(1, {
      type: 'multi_select',
      taskField: 'custom',
      customFieldId: id(50),
      options: ['Design'],
    });
    expect(() => validatePlannerFormProject(config([mapped]), { ...project, fields: [] })).toThrow(
      'unavailable',
    );
    expect(() =>
      validatePlannerFormProject(config([{ ...mapped, type: 'text' }]), project),
    ).toThrow('type');
    expect(() =>
      validatePlannerFormProject(config([{ ...mapped, options: ['Removed'] }]), project),
    ).toThrow('option');
    expect(() =>
      validatePlannerFormProject(config([mapped], { sectionId: id(99) }), project),
    ).toThrow('section');
    expect(() => validatePlannerForm(config([mapped, { ...mapped, id: id(2) }]))).toThrow(
      'Duplicate',
    );
  });
  it('validates current choices, dates, emails, duplicate multi-select answers, and unknown response keys', () => {
    for (const [question, answer] of [
      [field(1, { type: 'select', options: ['Yes'] }), 'Other'],
      [field(1, { type: 'multi_select', options: ['Yes'] }), ['Yes', 'Yes']],
      [field(1, { type: 'date' }), '2026-02-30'],
      [field(1, { type: 'email' }), 'not-an-email'],
      [field(1, { type: 'number' }), '5'],
    ] as const)
      expect(() =>
        plannerFormTaskValues(config([question]), project, 'Fallback', { [id(1)]: answer }),
      ).toThrow();
    expect(() =>
      plannerFormTaskValues(config([field(1)]), project, 'Fallback', { unknown: 'value' }),
    ).toThrow();
    expect(() => validatePlannerForm(config([field(1, { type: ['text'] as never })]))).toThrow();
  });
  it('requires actual attachment counts, enforces single-file questions, and ignores hidden file requirements', () => {
    const upload = field(2, {
      type: 'attachment',
      taskField: 'attachments',
      required: true,
      showWhen: { questionId: id(1), values: ['Yes'] },
    });
    const form = config([field(1, { type: 'select', options: ['Yes', 'No'] }), upload]);
    expect(() =>
      plannerFormTaskValues(form, project, 'Fallback', {
        [id(1)]: 'Yes',
        [id(2)]: [{ fileName: 'fake.json' }],
      }),
    ).toThrow('required');
    expect(() =>
      plannerFormTaskValues(form, project, 'Fallback', { [id(1)]: 'Yes' }, { [id(2)]: 2 }),
    ).toThrow('one file');
    expect(() =>
      plannerFormTaskValues(form, project, 'Fallback', { [id(1)]: 'Yes' }, { [id(2)]: 1 }),
    ).not.toThrow();
    expect(() => plannerFormTaskValues(form, project, 'Fallback', { [id(1)]: 'No' })).not.toThrow();
  });
});
