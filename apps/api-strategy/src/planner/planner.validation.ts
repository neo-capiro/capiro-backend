import { BadRequestException } from '@nestjs/common';
import {
  plannerCalendarDate,
  type PlannerProjectData,
  type PlannerTaskData,
  type PlannerField,
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
} from '@capiro/strategy-verifier';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function fail(message: string): never {
  throw new BadRequestException(message);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('Unknown Planner field');
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('Invalid text');
  return value;
}
function choice(value: unknown, options: string[]) {
  if (typeof value !== 'string' || !options.includes(value)) fail('Invalid option');
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Invalid record id');
  return value;
}
function nullableId(value: unknown) {
  if (value !== null) uuid(value);
}
function identity(value: unknown) {
  text(value, 200, true);
}
function integer(value: unknown, min = 0, max = 1_000_000) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    fail('Invalid number');
}
function list(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Invalid list');
  return value;
}
function distinct(values: unknown[]) {
  if (new Set(values).size !== values.length) fail('Duplicate values');
}
function dates(start: unknown, due: unknown) {
  for (const date of [start, due])
    if (date !== null && !plannerCalendarDate(date)) fail('Invalid calendar date');
  if (start !== null && due !== null && String(start) > String(due))
    fail('Start date must not follow due date');
}
export function validateProject(value: unknown): PlannerProjectData {
  const data = object(value);
  keys(data, Object.keys(PLANNER_DEFAULT_PROJECT));
  text(data.name, 500, true);
  text(data.description, 50_000);
  text(data.color, 7);
  if (!/^#[0-9a-f]{6}$/i.test(String(data.color))) fail('Invalid project color');
  choice(data.privacy, ['private', 'team']);
  choice(data.defaultView, ['list', 'board', 'calendar', 'timeline', 'gantt']);
  choice(data.health, ['on_track', 'at_risk', 'off_track', 'on_hold', 'complete']);
  dates(data.startOn, data.dueOn);
  nullableId(data.clientId);
  const sections = list(data.sections);
  for (const raw of sections) {
    const section = object(raw);
    keys(section, ['id', 'name']);
    uuid(section.id);
    text(section.name, 200, true);
  }
  distinct(sections.map((s) => object(s).id));
  const members = list(data.members, 1000);
  for (const raw of members) {
    const member = object(raw);
    keys(member, ['userId', 'role']);
    identity(member.userId);
    choice(member.role, ['admin', 'editor', 'commenter', 'viewer']);
  }
  distinct(members.map((m) => object(m).userId));
  const fields = list(data.fields);
  for (const raw of fields) {
    const field = object(raw);
    keys(field, ['id', 'name', 'type', 'options']);
    uuid(field.id);
    text(field.name, 200, true);
    choice(field.type, ['text', 'number', 'date', 'select', 'multi_select']);
    const options = list(field.options);
    for (const option of options) text(option, 200, true);
    distinct(options);
  }
  distinct(fields.map((f) => object(f).id));
  return data as unknown as PlannerProjectData;
}
export function validateTask(value: unknown): PlannerTaskData {
  const data = object(value);
  keys(data, Object.keys(PLANNER_DEFAULT_TASK));
  text(data.name, 500, true);
  text(data.description, 50_000);
  choice(data.status, ['todo', 'in_progress', 'blocked', 'done']);
  choice(data.priority, ['none', 'low', 'medium', 'high']);
  choice(data.subtype, ['task', 'milestone', 'approval']);
  choice(data.approval, ['pending', 'approved', 'rejected', 'changes_requested']);
  dates(data.startOn, data.dueOn);
  nullableId(data.parentId);
  nullableId(data.clientId);
  nullableId(data.meetingId);
  if (data.assigneeId !== null) identity(data.assigneeId);
  const dependencies = list(data.dependencies);
  for (const id of dependencies) uuid(id);
  distinct(dependencies);
  const collaborators = list(data.collaborators);
  for (const id of collaborators) identity(id);
  distinct(collaborators);
  const tags = list(data.tags);
  for (const tag of tags) text(tag, 100, true);
  distinct(tags);
  const memberships = list(data.memberships);
  for (const raw of memberships) {
    const membership = object(raw);
    keys(membership, ['projectId', 'sectionId', 'position']);
    uuid(membership.projectId);
    nullableId(membership.sectionId);
    integer(membership.position);
  }
  distinct(memberships.map((m) => object(m).projectId));
  if (memberships.length === 0 && !data.parentId && data.assigneeId === null) {
    /* creator owns personal tasks */
  }
  const values = object(data.customValues);
  if (Object.keys(values).length > 100) fail('Too many custom fields');
  for (const [key, v] of Object.entries(values)) {
    uuid(key);
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && !Array.isArray(v))
      fail('Invalid custom field value');
    if (typeof v === 'string') text(v, 5000);
    if (typeof v === 'number' && !Number.isFinite(v)) fail('Invalid custom number');
    if (Array.isArray(v)) {
      for (const item of list(v)) text(item, 200);
    }
  }
  integer(data.estimateMinutes);
  if (data.recurrence !== null) {
    const recurrence = object(data.recurrence);
    keys(recurrence, ['frequency', 'interval']);
    choice(recurrence.frequency, ['daily', 'weekly', 'monthly']);
    integer(recurrence.interval, 1, 365);
    if (!data.dueOn) fail('Recurring tasks require a due date');
  }
  return data as unknown as PlannerTaskData;
}
export function validateMutation(body: unknown): {
  data: Record<string, unknown>;
  version?: number;
  archived?: boolean;
} {
  const value = object(body);
  keys(value, ['data', 'version', 'archived']);
  if (value.version !== undefined) integer(value.version, 1);
  if (value.archived !== undefined && typeof value.archived !== 'boolean')
    fail('Invalid archive flag');
  return {
    data: value.data === undefined ? {} : object(value.data),
    version: value.version as number | undefined,
    archived: value.archived as boolean | undefined,
  };
}
export function validatePlannerFieldValue(field: PlannerField, value: unknown) {
  if (value === null) return;
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
    fail('Expected a custom field number');
  if (['text', 'date', 'select'].includes(field.type) && typeof value !== 'string')
    fail('Expected custom field text');
  if (field.type === 'date' && !plannerCalendarDate(value))
    fail('Expected a valid custom field date');
  if (field.type === 'select' && !field.options.includes(String(value)))
    fail('Unknown custom field option');
  if (
    field.type === 'multi_select' &&
    (!Array.isArray(value) || value.some((v) => !field.options.includes(v)))
  )
    fail('Unknown custom field options');
}
