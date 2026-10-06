import type {
  PlannerResourceKind,
  PlannerTaskData,
  PlannerRuleData,
} from '@capiro/strategy-verifier';
import {
  PLANNER_DEFAULT_TASK,
  plannerCalendarDate,
  plannerDependencyCycle,
} from '@capiro/strategy-verifier';
import {
  fail,
  keys,
  object,
  uuid,
  validateProject,
  validateTask,
  validatePlannerFieldValue,
} from './planner.validation.js';

export const RESOURCE_KINDS: PlannerResourceKind[] = [
  'portfolio',
  'goal',
  'template',
  'rule',
  'form',
  'saved_view',
  'capacity',
];
function string(value: unknown, max = 5000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('Invalid resource text');
}
function bool(value: unknown) {
  if (typeof value !== 'boolean') fail('Expected a boolean');
}
function enumValue(value: unknown, choices: string[]) {
  if (!choices.includes(String(value))) fail('Invalid resource option');
}
function array(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Invalid resource list');
  return value;
}
function distinct(values: unknown[]) {
  if (new Set(values).size !== values.length) fail('Duplicate resource values');
}
function number(value: unknown, max = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
    fail('Invalid resource number');
}
function sharing(data: Record<string, unknown>) {
  string(data.description, 50000);
  enumValue(data.privacy, ['private', 'team']);
  const members = array(data.members, 1000);
  for (const raw of members) {
    const m = object(raw);
    keys(m, ['userId', 'role']);
    string(m.userId, 200, true);
    enumValue(m.role, ['admin', 'editor', 'commenter', 'viewer']);
  }
  distinct(members.map((m) => object(m).userId));
}
export function validateResource(
  kind: PlannerResourceKind,
  value: unknown,
): Record<string, unknown> {
  const d = object(value);
  if (kind === 'portfolio' || kind === 'goal') {
    keys(d, [
      'description',
      'privacy',
      'members',
      'projectIds',
      ...(kind === 'goal'
        ? ['ownerId', 'dueOn', 'status', 'progress', 'current', 'target', 'unit']
        : []),
    ]);
    sharing(d);
    const projects = array(d.projectIds);
    projects.forEach(uuid);
    distinct(projects);
    if (kind === 'goal') {
      if (d.ownerId !== null) string(d.ownerId, 200, true);
      if (d.dueOn !== null && !plannerCalendarDate(d.dueOn)) fail('Invalid goal date');
      enumValue(d.status, ['on_track', 'at_risk', 'off_track', 'achieved']);
      enumValue(d.progress, ['manual', 'task_completion']);
      number(d.current);
      number(d.target);
      if (Number(d.target) <= 0) fail('A goal needs a positive target');
      string(d.unit, 100, true);
    }
  } else if (kind === 'template') {
    keys(d, ['description', 'privacy', 'members', 'project', 'tasks', 'layout']);
    sharing(d);
    const project = validateProject(d.project);
    for (const raw of array(d.tasks, 1000)) {
      const task = validateTask(raw);
      if (
        task.memberships.length ||
        task.parentId ||
        task.dependencies.length ||
        task.clientId ||
        task.meetingId
      )
        fail('Templates cannot contain live record links');
      if (Object.keys(task.customValues).some((id) => !project.fields.some((f) => f.id === id)))
        fail('Template has an unknown field');
      for (const [id, value] of Object.entries(task.customValues))
        validatePlannerFieldValue(
          project.fields.find((f) => f.id === id)!,
          value,
        );
    }
    if (project.clientId) fail('Templates cannot contain a client link');
    if (d.layout !== undefined) {
      const layout = array(d.layout, 1000);
      if (layout.length !== array(d.tasks, 1000).length)
        fail('Template layout must match its tasks');
      for (const raw of layout) {
        const item = object(raw);
        keys(item, ['sectionId', 'parentIndex', 'dependencyIndices']);
        if (item.sectionId !== null && !project.sections.some((s) => s.id === item.sectionId))
          fail('Unknown template section');
        if (
          item.parentIndex !== null &&
          (!Number.isInteger(item.parentIndex) ||
            Number(item.parentIndex) < 0 ||
            Number(item.parentIndex) >= layout.length)
        )
          fail('Invalid template parent');
        const indices = array(item.dependencyIndices);
        for (const index of indices)
          if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= layout.length)
            fail('Invalid template dependency');
        distinct(indices);
      }
      if (
        plannerDependencyCycle(
          layout.map((item, i) => ({
            id: String(i),
            dependencies: (object(item).dependencyIndices as number[]).map(String),
          })),
        ) ||
        plannerDependencyCycle(
          layout.map((item, i) => ({
            id: String(i),
            dependencies:
              object(item).parentIndex === null ? [] : [String(object(item).parentIndex)],
          })),
        )
      )
        fail('Template graph cannot form a cycle');
    }
  } else if (kind === 'rule') {
    keys(d, ['enabled', 'trigger', 'conditions', 'actions']);
    bool(d.enabled);
    enumValue(d.trigger, ['created', 'status_changed', 'section_changed', 'priority_changed']);
    for (const [key, allowed] of [
      ['conditions', ['status', 'priority', 'sectionId']],
      ['actions', ['status', 'priority', 'sectionId', 'assigneeId']],
    ] as const) {
      const props = object(d[key]);
      keys(props, [...allowed]);
      if (props.status !== undefined)
        enumValue(props.status, ['todo', 'in_progress', 'blocked', 'done']);
      if (props.priority !== undefined)
        enumValue(props.priority, ['none', 'low', 'medium', 'high']);
      if (props.sectionId !== undefined && props.sectionId !== null) uuid(props.sectionId);
      if (props.assigneeId !== undefined && props.assigneeId !== null)
        string(props.assigneeId, 200, true);
    }
    if (!Object.keys(object(d.actions)).length) fail('A rule requires an action');
  } else if (kind === 'form') {
    keys(d, ['description', 'enabled', 'fields', 'defaults']);
    string(d.description, 50000);
    bool(d.enabled);
    const fields = array(d.fields, 20);
    for (const raw of fields) {
      const f = object(raw);
      keys(f, ['id', 'label', 'type', 'required', 'options', 'taskField']);
      uuid(f.id);
      string(f.label, 200, true);
      bool(f.required);
      enumValue(f.type, ['text', 'paragraph', 'date', 'number', 'select']);
      enumValue(f.taskField, ['name', 'description', 'dueOn', 'priority', 'estimateMinutes']);
      const options = array(f.options);
      options.forEach((o) => string(o, 200, true));
      distinct(options);
      const expected = {
        name: ['text'],
        description: ['paragraph', 'text'],
        dueOn: ['date'],
        priority: ['select'],
        estimateMinutes: ['number'],
      }[String(f.taskField)]!;
      enumValue(f.type, expected);
      if (
        f.taskField === 'priority' &&
        options.some((o) => !['none', 'low', 'medium', 'high'].includes(String(o)))
      )
        fail('Invalid priority option');
    }
    distinct(fields.map((f) => object(f).id));
    distinct(fields.map((f) => object(f).taskField));
    if (!fields.some((f) => object(f).taskField === 'name' && object(f).required === true))
      fail('Forms require a task name question');
    const defaults = object(d.defaults);
    keys(defaults, ['assigneeId', 'priority', 'status', 'estimateMinutes']);
    validateTask({ ...PLANNER_DEFAULT_TASK, name: 'Form default', ...defaults });
  } else if (kind === 'saved_view') {
    keys(d, [
      'scope',
      'projectId',
      'view',
      'search',
      'status',
      'assigneeId',
      'priority',
      'sort',
      'groupBy',
    ]);
    enumValue(d.scope, ['mine', 'project']);
    if (d.projectId !== null) uuid(d.projectId);
    if (d.scope === 'project' && !d.projectId) fail('A project view needs a project');
    enumValue(d.view, ['list', 'board', 'calendar', 'timeline', 'gantt']);
    string(d.search, 200);
    enumValue(d.status, ['all', 'open', 'todo', 'in_progress', 'blocked', 'done']);
    string(d.assigneeId, 200);
    enumValue(d.priority, ['', 'none', 'low', 'medium', 'high']);
    enumValue(d.sort, ['position', 'due', 'name', 'priority']);
    if (d.groupBy !== undefined)
      enumValue(d.groupBy, ['section', 'status', 'priority', 'assignee', 'none']);
  } else if (kind === 'capacity') {
    keys(d, ['userId', 'weeklyMinutes']);
    string(d.userId, 200, true);
    number(d.weeklyMinutes, 10080);
    if (!Number.isInteger(d.weeklyMinutes)) fail('Capacity must use whole minutes');
  } else fail('Unknown resource kind');
  return d;
}
/** Each rule runs once per direct task mutation, in creation order. No recursive rule dispatch. */
export function applyPlannerRule(
  data: PlannerTaskData,
  before: PlannerTaskData | null,
  projectId: string,
  rule: PlannerRuleData,
): PlannerTaskData {
  if (!rule.enabled) return data;
  const current = data.memberships.find((m) => m.projectId === projectId);
  if (!current) return data;
  const previous = before?.memberships.find((m) => m.projectId === projectId);
  const triggers = {
    created: !before,
    status_changed: !!before && before.status !== data.status,
    priority_changed: !!before && before.priority !== data.priority,
    section_changed: !!before && previous?.sectionId !== current.sectionId,
  };
  if (!triggers[rule.trigger]) return data;
  const c = rule.conditions;
  if (
    (c.status !== undefined && c.status !== data.status) ||
    (c.priority !== undefined && c.priority !== data.priority) ||
    (c.sectionId !== undefined && c.sectionId !== current.sectionId)
  )
    return data;
  const { sectionId, ...patch } = rule.actions;
  return {
    ...data,
    ...patch,
    ...(sectionId === undefined
      ? {}
      : {
          memberships: data.memberships.map((m) =>
            m.projectId === projectId ? { ...m, sectionId } : m,
          ),
        }),
  };
}
