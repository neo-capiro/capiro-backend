import { createHash } from 'node:crypto';

export const MEMORY_GOVERNANCE_BACKFILL_CLASSIFIER_VERSION = 'memory-governance-v2.1';

export type MemoryGovernanceBackfillAction = 'prepare' | 'execute' | 'rollback';

export interface MemoryGovernanceBackfillArgs {
  tenantId: string;
  action: MemoryGovernanceBackfillAction;
  jobId: string | null;
  confirmTenant: string | null;
  confirmJob: string | null;
}

export interface GovernanceState {
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
  sourceType: string;
  sourceId: string | null;
  reviewDueAt: string | null;
}

export interface GovernanceStateRow {
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
  sourceType: string;
  sourceId: string | null;
  reviewDueAt: Date | string | null;
}

export interface PlanHashRow {
  memoryItemId: string;
  shouldUpdate: boolean;
  quarantined: boolean;
  reason: string;
  beforeHash: string;
  expectedPostHash: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueAfter(argv: string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] ?? null : null;
}

function requireUuid(value: string | null, message: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(message);
  return value.toLowerCase();
}

export function parseMemoryGovernanceBackfillArgs(
  argv: string[],
): MemoryGovernanceBackfillArgs {
  const tenantId = requireUuid(
    valueAfter(argv, '--tenant-id'),
    '--tenant-id <uuid> is required',
  );
  const execute = argv.includes('--execute');
  const rollback = argv.includes('--rollback');
  if (execute && rollback) {
    throw new Error('--execute and --rollback are mutually exclusive');
  }
  const action: MemoryGovernanceBackfillAction = rollback
    ? 'rollback'
    : execute
      ? 'execute'
      : 'prepare';
  const jobIdValue = valueAfter(argv, '--job-id');
  const confirmTenantValue =
    valueAfter(argv, '--confirm-tenant') ?? valueAfter(argv, '--confirm');
  const confirmJobValue = valueAfter(argv, '--confirm-job');

  if (action === 'prepare') {
    if (jobIdValue || confirmTenantValue || confirmJobValue) {
      throw new Error(
        'prepare mode does not accept --job-id or confirmation flags; run it first and use the returned jobId',
      );
    }
    return {
      tenantId,
      action,
      jobId: null,
      confirmTenant: null,
      confirmJob: null,
    };
  }

  const jobId = requireUuid(jobIdValue, `${action} requires --job-id <uuid>`);
  const confirmTenant = requireUuid(
    confirmTenantValue,
    `${action} requires --confirm-tenant <tenant uuid>`,
  );
  const confirmJob = requireUuid(
    confirmJobValue,
    `${action} requires --confirm-job <job uuid>`,
  );
  if (confirmTenant !== tenantId) {
    throw new Error('--confirm-tenant must exactly equal --tenant-id');
  }
  if (confirmJob !== jobId) {
    throw new Error('--confirm-job must exactly equal --job-id');
  }

  return { tenantId, action, jobId, confirmTenant, confirmJob };
}

export function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid governance timestamp');
  return date.toISOString();
}

export function governanceStateFromRow(row: GovernanceStateRow): GovernanceState {
  return {
    memoryClass: row.memoryClass,
    memoryAuthority: row.memoryAuthority,
    memoryScope: row.memoryScope,
    governedStatus: row.governedStatus,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    reviewDueAt: normalizeTimestamp(row.reviewDueAt),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashGovernanceState(state: GovernanceState): string {
  return sha256Canonical(state);
}

export function hashBackfillPlan(rows: PlanHashRow[]): string {
  return sha256Canonical(
    [...rows].sort((left, right) => left.memoryItemId.localeCompare(right.memoryItemId)),
  );
}

export function governanceStatesEqual(
  left: GovernanceState,
  right: GovernanceState,
): boolean {
  return hashGovernanceState(left) === hashGovernanceState(right);
}
