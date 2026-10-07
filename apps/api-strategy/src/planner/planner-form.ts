import {
  PLANNER_DEFAULT_TASK,
  plannerCalendarDate,
  plannerVisibleFormQuestions,
  type PlannerFormData,
  type PlannerFormField,
  type PlannerProjectData,
  type PlannerPublicForm,
  type PlannerTaskData,
} from '@capiro/strategy-verifier';
import {
  fail,
  keys,
  object,
  uuid,
  validateTask,
  validatePlannerFieldValue,
} from './planner.validation.js';

const TYPES = [
  'text',
  'paragraph',
  'email',
  'date',
  'number',
  'select',
  'multi_select',
  'attachment',
];
const TARGETS = [
  null,
  'name',
  'description',
  'startOn',
  'dueOn',
  'priority',
  'estimateMinutes',
  'custom',
  'attachments',
];
function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('Invalid form text');
}
function list(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Invalid form list');
  return value;
}
function unique(values: unknown[]) {
  if (new Set(values).size !== values.length) fail('Duplicate form values');
}

export function validatePlannerForm(raw: unknown): PlannerFormData {
  const config = object(raw);
  keys(config, [
    'description',
    'enabled',
    'fields',
    'defaults',
    'sectionId',
    'titleFieldId',
    'copyAnswersToDescription',
    'confirmationMessage',
    'allowAnotherSubmission',
    'addSubmitterAsCollaborator',
    'audience',
  ]);
  text(config.description, 50_000);
  if (typeof config.enabled !== 'boolean') fail('Expected a form enabled flag');
  const fields = list(config.fields);
  if (!fields.length) fail('Add at least one form question');
  const previous = new Map<string, { field: PlannerFormField; depth: number }>();
  for (const rawField of fields) {
    const field = object(rawField);
    keys(field, [
      'id',
      'label',
      'description',
      'type',
      'required',
      'options',
      'taskField',
      'customFieldId',
      'showWhen',
      'multiple',
      'maxLength',
    ]);
    uuid(field.id);
    text(field.label, 200, true);
    if (field.description !== undefined) text(field.description, 5000);
    if (
      typeof field.type !== 'string' ||
      !TYPES.includes(field.type) ||
      !(field.taskField === null || typeof field.taskField === 'string') ||
      !TARGETS.includes(field.taskField as string | null)
    )
      fail('Invalid form question type or mapping');
    if (typeof field.required !== 'boolean') fail('Expected a question required flag');
    const options = list(field.options);
    options.forEach((option) => text(option, 200, true));
    unique(options);
    if (
      ['select', 'multi_select'].includes(String(field.type)) ? !options.length : options.length > 0
    )
      fail('Choice questions require options; other questions cannot contain options');
    if (field.taskField === 'custom') uuid(field.customFieldId);
    else if (field.customFieldId !== undefined)
      fail('Only custom-field questions can reference a project field');
    if (field.taskField === 'name' && !['text', 'email'].includes(String(field.type)))
      fail('Task name mappings require text; choose another question in Task title settings');
    if (
      field.taskField === 'description' &&
      !['text', 'paragraph', 'email'].includes(String(field.type))
    )
      fail('Description mappings require a text question');
    if (['startOn', 'dueOn'].includes(String(field.taskField)) && field.type !== 'date')
      fail('Task dates require date questions');
    if (field.taskField === 'estimateMinutes' && field.type !== 'number')
      fail('Estimates require number questions');
    if (
      field.taskField === 'priority' &&
      (field.type !== 'select' ||
        options.some((option) => !['none', 'low', 'medium', 'high'].includes(String(option))))
    )
      fail('Invalid priority question');
    if ((field.type === 'attachment') !== (field.taskField === 'attachments'))
      fail('Attachment questions must map to task attachments');
    if (
      field.multiple !== undefined &&
      (field.type !== 'attachment' || typeof field.multiple !== 'boolean')
    )
      fail('Multiple files is an attachment setting');
    if (
      field.maxLength !== undefined &&
      (!['text', 'paragraph', 'email'].includes(String(field.type)) ||
        !Number.isInteger(field.maxLength) ||
        Number(field.maxLength) < 1 ||
        Number(field.maxLength) > 50_000)
    )
      fail('Invalid question text limit');
    let depth = 0;
    if (field.showWhen !== undefined) {
      const branch = object(field.showWhen);
      keys(branch, ['questionId', 'values']);
      uuid(branch.questionId);
      const parent = previous.get(String(branch.questionId));
      if (!parent || !['select', 'multi_select'].includes(parent.field.type))
        fail('A branch requires an earlier choice question');
      const values = list(branch.values);
      if (!values.length || values.some((value) => !parent.field.options.includes(String(value))))
        fail('A branch must select valid parent responses');
      values.forEach((value) => text(value, 200, true));
      unique(values);
      depth = parent.depth + 1;
      if (depth > 5) fail('Forms support up to five branch levels');
    }
    if (previous.has(String(field.id))) fail('Duplicate form questions');
    previous.set(String(field.id), { field: field as unknown as PlannerFormField, depth });
  }
  unique(
    fields
      .map((rawField) => object(rawField))
      .filter((field) => field.taskField !== null && field.taskField !== 'attachments')
      .map((field) =>
        field.taskField === 'custom' ? `custom:${field.customFieldId}` : field.taskField,
      ),
  );
  if (config.titleFieldId === undefined) {
    if (
      !fields.some((rawField) => {
        const field = object(rawField);
        return (
          field.taskField === 'name' && field.required === true && field.showWhen === undefined
        );
      })
    )
      fail('Forms require a task name question or a configured task title');
  } else if (config.titleFieldId !== null) {
    uuid(config.titleFieldId);
    const title = previous.get(String(config.titleFieldId));
    if (!title || title.field.type === 'attachment')
      fail('Choose a non-file question for the task title');
  }
  if (config.sectionId !== undefined && config.sectionId !== null) uuid(config.sectionId);
  for (const key of [
    'copyAnswersToDescription',
    'allowAnotherSubmission',
    'addSubmitterAsCollaborator',
  ])
    if (config[key] !== undefined && typeof config[key] !== 'boolean') fail('Invalid form setting');
  if (config.confirmationMessage !== undefined) text(config.confirmationMessage, 5000);
  if (
    config.audience !== undefined &&
    !['organization', 'public'].includes(String(config.audience))
  )
    fail('Invalid form audience');
  const defaults = object(config.defaults);
  keys(defaults, ['assigneeId', 'priority', 'status', 'estimateMinutes']);
  validateTask({ ...PLANNER_DEFAULT_TASK, name: 'Form default', ...defaults });
  return config as unknown as PlannerFormData;
}

export function validatePlannerFormProject(config: PlannerFormData, project: PlannerProjectData) {
  if (config.sectionId && !project.sections.some((section) => section.id === config.sectionId))
    fail('Form section must belong to its project');
  for (const question of config.fields.filter((field) => field.taskField === 'custom')) {
    const field = project.fields.find((candidate) => candidate.id === question.customFieldId);
    if (!field) fail('A mapped project field is unavailable');
    const types = field.type === 'text' ? ['text', 'paragraph', 'email'] : [field.type];
    if (!types.includes(question.type)) fail('Question type must match its project field');
    if (
      ['select', 'multi_select'].includes(field.type) &&
      question.options.some((option) => !field.options.includes(option))
    )
      fail('A mapped project field option is unavailable');
  }
}

export function plannerPublicForm(name: string, config: PlannerFormData): PlannerPublicForm {
  return {
    name,
    description: config.description,
    confirmationMessage: config.confirmationMessage,
    allowAnotherSubmission: config.allowAnotherSubmission,
    fields: config.fields.map(({ taskField, customFieldId: _customFieldId, ...question }) => ({
      ...question,
      maxLength: Math.min(
        question.maxLength ?? 50_000,
        taskField === 'name' ? 500 : taskField === 'custom' ? 5000 : 50_000,
      ),
    })),
  };
}

export function plannerFormTaskValues(
  config: PlannerFormData,
  project: PlannerProjectData,
  name: string,
  answers: Record<string, unknown>,
  fileCounts: Record<string, number> = {},
  fileNames: Record<string, string[]> = {},
): Record<string, unknown> & { customValues: PlannerTaskData['customValues'] } {
  keys(
    answers,
    config.fields.map((field) => field.id),
  );
  validatePlannerFormProject(config, project);
  const values: Record<string, unknown> = {};
  const customValues: PlannerTaskData['customValues'] = {};
  const descriptions: string[] = [];
  const visible = plannerVisibleFormQuestions(config.fields, answers);
  const title = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value));
  for (const field of visible) {
    const value = answers[field.id];
    if (field.type === 'attachment') {
      const count = fileCounts[field.id] ?? 0;
      if (field.required && count === 0) fail(`${field.label} is required`);
      if (!field.multiple && count > 1) fail(`${field.label} accepts one file`);
      if (count && config.copyAnswersToDescription)
        descriptions.push(`${field.label}: ${(fileNames[field.id] ?? []).join(', ')}`);
      continue;
    }
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      if (field.required) fail(`${field.label} is required`);
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('Expected a numeric answer');
    } else if (field.type === 'multi_select') {
      const selected = list(value);
      unique(selected);
      if (selected.some((choice) => typeof choice !== 'string' || !field.options.includes(choice)))
        fail('Invalid form choices');
    } else {
      text(
        value,
        Math.min(
          field.maxLength ?? 50_000,
          field.taskField === 'custom' ? 5000 : field.taskField === 'name' ? 500 : 50_000,
        ),
      );
      if (field.type === 'select' && !field.options.includes(String(value)))
        fail('Invalid form choice');
      if (field.type === 'date' && !plannerCalendarDate(value)) fail('Expected a valid form date');
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)))
        fail('Expected an email address');
    }
    if (field.taskField === 'custom') {
      const mapped = project.fields.find((candidate) => candidate.id === field.customFieldId)!;
      validatePlannerFieldValue(mapped, value);
      customValues[mapped.id] = value as string | number | string[];
    } else if (field.taskField) {
      values[field.taskField] = ['name', 'description'].includes(field.taskField)
        ? title(value)
        : value;
    }
    if (config.copyAnswersToDescription) descriptions.push(`${field.label}: ${title(value)}`);
  }
  if (config.titleFieldId !== undefined) {
    const value = visible.some((field) => field.id === config.titleFieldId)
      ? answers[config.titleFieldId!]
      : undefined;
    values.name =
      value !== undefined &&
      value !== null &&
      value !== '' &&
      (!Array.isArray(value) || value.length > 0)
        ? title(value).slice(0, 500)
        : name;
  }
  if (descriptions.length)
    values.description = [values.description, descriptions.join('\n\n')]
      .filter(Boolean)
      .join('\n\n');
  return { ...values, customValues };
}
