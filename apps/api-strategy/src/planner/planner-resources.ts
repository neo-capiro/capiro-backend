import type {
  PlannerResourceKind,
  PlannerTaskData,
  PlannerRuleData,
  PlannerGoalData,
} from '@capiro/strategy-verifier';
import {
  PLANNER_DEFAULT_TASK,
  plannerCalendarDate,
  plannerTime,
  plannerTimeZone,
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
import { validatePlannerForm } from './planner-form.js';
import { validatePlannerReportWidgets } from './planner-reporting.validation.js';
import { plannerGoalSourceIds, PLANNER_WEIGHTED_GOAL_MODES } from './planner-goals.js';

export const RESOURCE_KINDS: PlannerResourceKind[] = [
  'portfolio',
  'goal',
  'template',
  'rule',
  'form',
  'saved_view',
  'capacity',
  'my_tasks',
  'dashboard',
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
  if (kind === 'dashboard') {
    keys(d, ['description', 'privacy', 'members', 'widgets']);
    sharing(d);
    validatePlannerReportWidgets(d.widgets);
  } else if (kind === 'portfolio' || kind === 'goal') {
    keys(d, [
      'description',
      'privacy',
      'members',
      'projectIds',
      ...(kind === 'goal'
        ? [
            'ownerId',
            'dueOn',
            'status',
            'progress',
            'current',
            'target',
            'unit',
            'startValue',
            'direction',
            'followers',
            'reminder',
            'timeZone',
            'subgoalIds',
            'taskIds',
            'startOn',
            'timePeriod',
            'goalType',
            'weightMode',
            'weights',
          ]
        : []),
    ]);
    sharing(d);
    const projects = array(d.projectIds);
    projects.forEach(uuid);
    distinct(projects);
    if (kind === 'goal') {
      if (d.ownerId !== null) string(d.ownerId, 200, true);
      if (d.dueOn !== null && !plannerCalendarDate(d.dueOn)) fail('Invalid goal date');
      enumValue(d.status, [
        'on_track',
        'at_risk',
        'off_track',
        'achieved',
        'partial',
        'missed',
        'dropped',
      ]);
      enumValue(d.progress, [
        'manual',
        'task_completion',
        'project_task_completion',
        'project_milestone_completion',
        'task_list_completion',
        'subgoal_percentage',
        'subgoal_total',
      ]);
      for (const value of [d.current, d.target, d.startValue ?? 0])
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000)
          fail('Invalid goal measurement value');
      if (d.direction !== undefined) enumValue(d.direction, ['increase', 'decrease']);
      if (d.progress === 'manual' || d.progress === 'subgoal_total') {
        const start = Number(d.startValue ?? 0),
          target = Number(d.target);
        if ((d.direction ?? 'increase') === 'increase' ? target <= start : target >= start)
          fail(
            (d.direction ?? 'increase') === 'increase'
              ? 'An increasing goal needs a target above its starting value'
              : 'A decreasing goal needs a target below its starting value',
          );
      } else {
        if (Number(d.target) <= 0) fail('A goal needs a positive target');
        if ((d.startValue ?? 0) !== 0 || (d.direction ?? 'increase') !== 'increase')
          fail('Automatic percentage progress starts at zero and increases');
      }
      string(d.unit, 100, true);
      if (d.followers !== undefined) {
        const followers = array(d.followers, 1000);
        followers.forEach((id) => string(id, 200, true));
        distinct(followers);
      }
      if (d.timeZone !== undefined && !plannerTimeZone(d.timeZone)) fail('Invalid goal time zone');
      if (d.reminder !== undefined && d.reminder !== null) {
        const reminder = object(d.reminder);
        keys(reminder, ['cadence', 'anchorOn', 'time', 'timeZone']);
        enumValue(reminder.cadence, ['weekly', 'biweekly', 'monthly', 'quarterly']);
        if (
          !plannerCalendarDate(reminder.anchorOn) ||
          !plannerTime(reminder.time) ||
          !plannerTimeZone(reminder.timeZone)
        )
          fail('Invalid goal reminder schedule');
      }
      if (d.startOn !== undefined && d.startOn !== null && !plannerCalendarDate(d.startOn))
        fail('Invalid goal start date');
      if (d.startOn && d.dueOn && String(d.startOn) > String(d.dueOn))
        fail('Goal start date must precede its due date');
      if (d.timePeriod !== undefined) string(d.timePeriod, 100);
      if (d.goalType !== undefined) enumValue(d.goalType, ['company', 'team', 'individual']);
      for (const key of ['subgoalIds', 'taskIds']) {
        if (d[key] !== undefined) {
          const ids = array(d[key]);
          ids.forEach(uuid);
          distinct(ids);
        }
      }
      if (d.weightMode !== undefined) enumValue(d.weightMode, ['equal', 'custom']);
      const weights = array(d.weights ?? []);
      for (const raw of weights) {
        const item = object(raw);
        keys(item, ['sourceId', 'weight']);
        uuid(item.sourceId);
        number(item.weight, 100);
      }
      distinct(weights.map((w) => object(w).sourceId));
      if (d.weightMode === 'custom') {
        if (!(PLANNER_WEIGHTED_GOAL_MODES as readonly string[]).includes(String(d.progress)))
          fail('Custom weights require automatic percentage progress');
        const sourceIds = plannerGoalSourceIds(d as unknown as PlannerGoalData);
        if (
          !sourceIds.length ||
          weights.length !== sourceIds.length ||
          weights.some((w) => !sourceIds.includes(String(object(w).sourceId)))
        )
          fail('Every progress source needs a weight');
        if (
          Math.abs(weights.reduce<number>((sum, w) => sum + Number(object(w).weight), 0) - 100) >
          0.000001
        )
          fail('Goal weights must add up to 100%');
      } else if (weights.length) fail('Custom weights require custom weight mode');
    }
  } else if (kind === 'template') {
    keys(d, ['description', 'privacy', 'members', 'project', 'tasks', 'layout', 'schedule']);
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
    if (d.schedule !== undefined) {
      const schedule = object(d.schedule);
      keys(schedule, ['anchor', 'skipWeekends', 'dates']);
      enumValue(schedule.anchor, ['start', 'due']);
      bool(schedule.skipWeekends);
      const dates = array(schedule.dates, 1000);
      if (dates.length !== array(d.tasks, 1000).length) fail('Template dates must match its tasks');
      for (const raw of dates) {
        const date = object(raw);
        keys(date, ['startOffset', 'dueOffset']);
        for (const value of [date.startOffset, date.dueOffset])
          if (value !== null && (!Number.isInteger(value) || Math.abs(Number(value)) > 3650))
            fail('Relative dates must be whole days within ten years');
        if (
          date.startOffset !== null &&
          date.dueOffset !== null &&
          Number(date.startOffset) > Number(date.dueOffset)
        )
          fail('Template start date must precede its due date');
      }
    }
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
    keys(d, ['enabled', 'trigger', 'conditions', 'actions', 'schedule']);
    bool(d.enabled);
    enumValue(d.trigger, [
      'created',
      'status_changed',
      'section_changed',
      'priority_changed',
      'due_approaching',
      'overdue',
    ]);
    if (['due_approaching', 'overdue'].includes(String(d.trigger))) validateDateRule(d);
    else if (d.schedule !== undefined) fail('Only date rules have a schedule');
    for (const [key, allowed] of [
      ['conditions', ['status', 'priority', 'sectionId']],
      ['actions', ['status', 'priority', 'sectionId', 'assigneeId', 'notify']],
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
      if (props.notify !== undefined) bool(props.notify);
    }
    if (
      !Object.entries(object(d.actions)).some(([key, value]) => key !== 'notify' || value === true)
    )
      fail('A rule requires an action');
    if (
      !['due_approaching', 'overdue'].includes(String(d.trigger)) &&
      object(d.actions).notify !== undefined
    )
      fail('Explicit reminders require a date rule');
  } else if (kind === 'form') {
    return validatePlannerForm(d) as unknown as Record<string, unknown>;
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
    enumValue(d.sort, ['position', 'due', 'name', 'priority', 'estimated', 'actual']);
    if (d.groupBy !== undefined)
      enumValue(d.groupBy, ['section', 'status', 'priority', 'assignee', 'none']);
  } else if (kind === 'my_tasks') {
    keys(d, ['sections', 'placements', 'rules']);
    const sections = array(d.sections, 100);
    for (const raw of sections) {
      const s = object(raw);
      keys(s, ['id', 'name']);
      uuid(s.id);
      string(s.name, 200, true);
    }
    distinct(sections.map((s) => object(s).id));
    const placements = array(d.placements, 10000);
    for (const raw of placements) {
      const p = object(raw);
      keys(p, ['taskId', 'sectionId', 'position']);
      uuid(p.taskId);
      if (p.sectionId !== null && !sections.some((s) => object(s).id === p.sectionId))
        fail('Personal section is unavailable');
      number(p.position, 1000000);
      if (!Number.isInteger(p.position)) fail('Personal task order must use whole numbers');
    }
    distinct(placements.map((p) => object(p).taskId));
    if (d.rules !== undefined) {
      const rules = array(d.rules, 100);
      for (const raw of rules) {
        const rule = object(raw);
        keys(rule, ['id', 'name', 'enabled', 'trigger', 'schedule', 'sectionId', 'notify']);
        uuid(rule.id);
        string(rule.name, 200, true);
        bool(rule.enabled);
        bool(rule.notify);
        validateDateRule(rule);
        if (
          rule.sectionId !== undefined &&
          rule.sectionId !== null &&
          !sections.some((s) => object(s).id === rule.sectionId)
        )
          fail('Personal rule section is unavailable');
        if (rule.sectionId === undefined && !rule.notify)
          fail('A personal rule requires an action');
      }
      distinct(rules.map((r) => object(r).id));
    }
  } else if (kind === 'capacity') {
    keys(d, ['userId', 'weeklyMinutes']);
    string(d.userId, 200, true);
    number(d.weeklyMinutes, 10080);
    if (!Number.isInteger(d.weeklyMinutes)) fail('Capacity must use whole minutes');
  } else fail('Unknown resource kind');
  return d;
}
function validateDateRule(rule: Record<string, unknown>) {
  enumValue(rule.trigger, ['due_approaching', 'overdue']);
  const schedule = object(rule.schedule);
  keys(schedule, ['amount', 'unit']);
  enumValue(schedule.unit, ['days', 'hours', 'minutes']);
  const max = { days: 365, hours: 8760, minutes: 525600 }[String(schedule.unit)]!;
  number(schedule.amount, max);
  if (!Number.isInteger(schedule.amount)) fail('Date rule offset must use whole numbers');
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
  if (!Object.hasOwn(triggers, rule.trigger) || !triggers[rule.trigger as keyof typeof triggers])
    return data;
  const c = rule.conditions;
  if (
    (c.status !== undefined && c.status !== data.status) ||
    (c.priority !== undefined && c.priority !== data.priority) ||
    (c.sectionId !== undefined && c.sectionId !== current.sectionId)
  )
    return data;
  const { sectionId, notify: _notify, ...patch } = rule.actions;
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
