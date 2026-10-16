export type PlanLifecycle = 'draft' | 'active' | 'archived';
export type PlanTransition = 'activate' | 'deactivate' | 'archive' | 'restore';
export type WaveTransition = 'archive' | 'restore';
export interface OfficeReferenceInput {
  targetId: string;
  officeKey: string;
}
export interface PlanObjectiveInput {
  objectiveId: string;
  objectiveVersion: number;
}
export interface PlanWaveWindow {
  startDate: string;
  endDateExclusive: string;
  timeZone: string;
}
export interface CreatePlanInput {
  clientId: string;
  requestId: string;
  title: string;
  officeReferences: OfficeReferenceInput[];
  objective: PlanObjectiveInput | null;
}
export interface PatchPlanInput {
  expectedPlanVersion: number;
  title?: string;
  officeReferences?: OfficeReferenceInput[];
  objective?: PlanObjectiveInput | null;
  action?: PlanTransition;
}
export interface CreateWaveInput {
  requestId: string;
  expectedPlanVersion: number;
  title: string;
  formatLabel: string | null;
  window: PlanWaveWindow | null;
  officeTargetIds: string[];
}
export interface PatchWaveInput {
  expectedPlanVersion: number;
  title?: string;
  formatLabel?: string | null;
  window?: PlanWaveWindow | null;
  officeTargetIds?: string[];
  action?: WaveTransition;
}
export interface ReorderWavesInput {
  expectedPlanVersion: number;
  waveIds: string[];
}
export interface ReviewPlanInput {
  expectedPlanVersion: number;
  reviewDueAt: string;
}
export interface PlanListQuery {
  clientId?: string;
  cursor?: string;
  limit: number;
}
export interface PlanHistoryQuery {
  beforeVersion?: number;
  limit: number;
}
export interface PlanReviewBasis {
  version: number;
  reviewedPlanVersion: number | null;
  reviewDueAt: Date | string | null;
}
export interface ReviewFreshness {
  status: 'unknown' | 'current' | 'stale';
  reason:
    | 'not_reviewed'
    | 'invalid_review_basis'
    | 'plan_changed'
    | 'review_expired'
    | 'review_current';
  checkedAt: string;
}

export class PlanInputError extends Error {
  readonly code = 'PLAN_INPUT_INVALID';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PlanInputError';
  }
}
export class PlanRuleError extends Error {
  readonly code = 'PLAN_INVALID_LIFECYCLE';
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'PlanRuleError';
  }
}

const MAX_VERSION = 2_147_483_647;
const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = (field: string): never => {
  throw new PlanInputError(`Invalid ${field}`);
};
function record(
  value: unknown,
  allowed: readonly string[],
  field = 'input',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid(field);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return invalid(`${field} field`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return invalid(field);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return invalid(field);
  return trimmed;
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) return invalid(field);
  return value.toLowerCase();
}
function version(value: unknown, field = 'expectedPlanVersion'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION)
    return invalid(field);
  return value;
}
function ids(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) return invalid(field);
  const result = value.map((item) => uuid(item, field));
  if (new Set(result).size !== result.length) return invalid(`${field} duplicate`);
  return result;
}
function offices(value: unknown): OfficeReferenceInput[] {
  if (!Array.isArray(value) || value.length > 200) return invalid('officeReferences');
  const result = value.map((item) => {
    const row = record(item, ['targetId', 'officeKey'], 'officeReference');
    const key = text(row.officeKey, 'officeKey', 512);
    if (!/^(directory|manual):\S+$/.test(key)) return invalid('officeKey');
    const [prefix, ...parts] = key.split(':');
    const suffix = parts.join(':');
    return {
      targetId: uuid(row.targetId, 'targetId'),
      officeKey: `${prefix}:${UUID.test(suffix) ? suffix.toLowerCase() : suffix}`,
    };
  });
  if (
    new Set(result.map((row) => row.targetId)).size !== result.length ||
    new Set(result.map((row) => row.officeKey)).size !== result.length
  )
    return invalid('officeReferences duplicate');
  return result;
}
function objective(value: unknown): PlanObjectiveInput | null {
  if (value === null) return null;
  const row = record(value, ['objectiveId', 'objectiveVersion'], 'objective');
  return {
    objectiveId: uuid(row.objectiveId, 'objectiveId'),
    objectiveVersion: version(row.objectiveVersion, 'objectiveVersion'),
  };
}
function dateDay(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-'))
    return invalid(field);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value)
    return invalid(field);
  return value;
}
function windowInput(value: unknown): PlanWaveWindow | null {
  if (value === null) return null;
  const row = record(value, ['startDate', 'endDateExclusive', 'timeZone'], 'window');
  const startDate = dateDay(row.startDate, 'startDate');
  const endDateExclusive = dateDay(row.endDateExclusive, 'endDateExclusive');
  if (startDate >= endDateExclusive) return invalid('window range');
  const zone = text(row.timeZone, 'timeZone', 120);
  if (!/^[A-Za-z_][A-Za-z0-9_+\-/]*$/.test(zone)) return invalid('timeZone');
  let timeZone: string;
  try {
    timeZone = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return invalid('timeZone');
  }
  return { startDate, endDateExclusive, timeZone };
}
function formatLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length > 120) return invalid('formatLabel');
  return value.trim() || null;
}
function action<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid('action');
  return value as T;
}
function exclusiveAction(row: Record<string, unknown>, authorFields: string[]): void {
  if (owns(row, 'action') && authorFields.some((field) => owns(row, field)))
    invalid('action mixed with authoring fields');
}
function explicitInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string') return invalid(field);
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return invalid(field);
  dateDay(match[1], field);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)
    return invalid(field);
  if (match[5] !== 'Z' && (Number(match[5]!.slice(1, 3)) > 23 || Number(match[5]!.slice(4)) > 59))
    return invalid(field);
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return invalid(field);
  return instant;
}
function checkedInstant(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invalid('checkedAt');
  return value.getTime();
}

export function normalizeCreatePlan(input: unknown): CreatePlanInput {
  const row = record(input, ['clientId', 'requestId', 'title', 'officeReferences', 'objective']);
  return {
    clientId: uuid(row.clientId, 'clientId'),
    requestId: uuid(row.requestId, 'requestId'),
    title: text(row.title, 'title', 200),
    officeReferences: owns(row, 'officeReferences') ? offices(row.officeReferences) : [],
    objective: owns(row, 'objective') ? objective(row.objective) : null,
  };
}
export function normalizePatchPlan(input: unknown): PatchPlanInput {
  const row = record(input, [
    'expectedPlanVersion',
    'title',
    'officeReferences',
    'objective',
    'action',
  ]);
  exclusiveAction(row, ['title', 'officeReferences', 'objective']);
  return {
    expectedPlanVersion: version(row.expectedPlanVersion),
    ...(owns(row, 'title') ? { title: text(row.title, 'title', 200) } : {}),
    ...(owns(row, 'officeReferences') ? { officeReferences: offices(row.officeReferences) } : {}),
    ...(owns(row, 'objective') ? { objective: objective(row.objective) } : {}),
    ...(owns(row, 'action')
      ? { action: action(row.action, ['activate', 'deactivate', 'archive', 'restore'] as const) }
      : {}),
  };
}
export function normalizeCreateWave(input: unknown): CreateWaveInput {
  const row = record(input, [
    'requestId',
    'expectedPlanVersion',
    'title',
    'formatLabel',
    'window',
    'officeTargetIds',
  ]);
  return {
    requestId: uuid(row.requestId, 'requestId'),
    expectedPlanVersion: version(row.expectedPlanVersion),
    title: text(row.title, 'title', 200),
    formatLabel: owns(row, 'formatLabel') ? formatLabel(row.formatLabel) : null,
    window: owns(row, 'window') ? windowInput(row.window) : null,
    officeTargetIds: owns(row, 'officeTargetIds')
      ? ids(row.officeTargetIds, 'officeTargetIds', 200)
      : [],
  };
}
export function normalizePatchWave(input: unknown): PatchWaveInput {
  const row = record(input, [
    'expectedPlanVersion',
    'title',
    'formatLabel',
    'window',
    'officeTargetIds',
    'action',
  ]);
  exclusiveAction(row, ['title', 'formatLabel', 'window', 'officeTargetIds']);
  return {
    expectedPlanVersion: version(row.expectedPlanVersion),
    ...(owns(row, 'title') ? { title: text(row.title, 'title', 200) } : {}),
    ...(owns(row, 'formatLabel') ? { formatLabel: formatLabel(row.formatLabel) } : {}),
    ...(owns(row, 'window') ? { window: windowInput(row.window) } : {}),
    ...(owns(row, 'officeTargetIds')
      ? { officeTargetIds: ids(row.officeTargetIds, 'officeTargetIds', 200) }
      : {}),
    ...(owns(row, 'action') ? { action: action(row.action, ['archive', 'restore'] as const) } : {}),
  };
}
export function normalizeReorder(input: unknown): ReorderWavesInput {
  const row = record(input, ['expectedPlanVersion', 'waveIds']);
  return {
    expectedPlanVersion: version(row.expectedPlanVersion),
    waveIds: ids(row.waveIds, 'waveIds', 1000),
  };
}
export const normalizeReorderWaves = normalizeReorder;
export function normalizeReview(input: unknown, now: Date): ReviewPlanInput {
  const row = record(input, ['expectedPlanVersion', 'reviewDueAt']);
  const reviewDueAt = explicitInstant(row.reviewDueAt, 'reviewDueAt');
  if (reviewDueAt.getTime() <= checkedInstant(now)) return invalid('reviewDueAt must be future');
  return {
    expectedPlanVersion: version(row.expectedPlanVersion),
    reviewDueAt: reviewDueAt.toISOString(),
  };
}
export function normalizeListQuery(input: unknown): PlanListQuery {
  const row = record(input, ['clientId', 'cursor', 'limit']);
  const limit = !owns(row, 'limit')
    ? 25
    : typeof row.limit === 'string' && /^[1-9]\d*$/.test(row.limit)
      ? Number(row.limit)
      : row.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    return invalid('limit');
  if (
    owns(row, 'cursor') &&
    (typeof row.cursor !== 'string' || row.cursor.length < 1 || row.cursor.length > 512)
  )
    return invalid('cursor');
  return {
    limit,
    ...(owns(row, 'clientId') ? { clientId: uuid(row.clientId, 'clientId') } : {}),
    ...(owns(row, 'cursor') ? { cursor: row.cursor as string } : {}),
  };
}
export function normalizeHistoryQuery(input: unknown): PlanHistoryQuery {
  const row = record(input, ['beforeVersion', 'limit']);
  const { limit } = normalizeListQuery(owns(row, 'limit') ? { limit: row.limit } : {});
  if (!owns(row, 'beforeVersion')) return { limit };
  const beforeVersion =
    typeof row.beforeVersion === 'string' && /^[1-9]\d*$/.test(row.beforeVersion)
      ? Number(row.beforeVersion)
      : row.beforeVersion;
  return { limit, beforeVersion: version(beforeVersion, 'beforeVersion') };
}

/** Service owns expected-version checks, atomic version increments and authorization. */
export function planTransition(current: PlanLifecycle, transition: PlanTransition): PlanLifecycle {
  const states: Record<PlanTransition, Partial<Record<PlanLifecycle, PlanLifecycle>>> = {
    activate: { draft: 'active', active: 'active' },
    deactivate: { active: 'draft', draft: 'draft' },
    archive: { draft: 'archived', active: 'archived', archived: 'archived' },
    restore: { archived: 'draft', draft: 'draft' },
  };
  const choices = owns(states, transition) ? states[transition] : undefined;
  const next = choices && owns(choices, current) ? choices[current] : undefined;
  if (!next) throw new PlanRuleError('Invalid plan lifecycle transition');
  return next;
}

/** Only an explicit review of this aggregate version can establish current freshness. */
export function deriveReviewFreshness(basis: PlanReviewBasis, checkedAt: Date): ReviewFreshness {
  const now = checkedInstant(checkedAt);
  const result = (
    status: ReviewFreshness['status'],
    reason: ReviewFreshness['reason'],
  ): ReviewFreshness => ({ status, reason, checkedAt: checkedAt.toISOString() });
  if (basis.reviewedPlanVersion === null || basis.reviewDueAt === null)
    return result('unknown', 'not_reviewed');
  let due: number;
  try {
    version(basis.version, 'version');
    version(basis.reviewedPlanVersion, 'reviewedPlanVersion');
    due =
      basis.reviewDueAt instanceof Date
        ? checkedInstant(basis.reviewDueAt)
        : explicitInstant(basis.reviewDueAt, 'reviewDueAt').getTime();
  } catch {
    return result('unknown', 'invalid_review_basis');
  }
  if (basis.reviewedPlanVersion > basis.version) return result('unknown', 'invalid_review_basis');
  if (due <= now) return result('stale', 'review_expired');
  if (basis.reviewedPlanVersion !== basis.version) return result('stale', 'plan_changed');
  return result('current', 'review_current');
}
