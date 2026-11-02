import { createHash } from 'node:crypto';

/**
 * Shared vocabulary and pure projections for the durable view of the existing
 * LDA client importer (POST /firm/import). Nothing here performs I/O: the
 * importer writes these outcomes and every read (list/detail/status) derives
 * its counts and terminal state from the same projection.
 */

export const MAX_IMPORT_LDA_IDS = 100;
export const IMPORT_JOB_STALE_AFTER_SECONDS = 15 * 60;
export const IMPORT_JOB_PAGE_DEFAULT = 20;
export const IMPORT_JOB_PAGE_MAX = 50;

export type FirmImportJobStatus =
  'queued' | 'running' | 'partially_completed' | 'failed' | 'completed';

export type FirmImportItemOutcome = 'pending' | 'created' | 'already_present' | 'rejected';

/** Closed, actionable codes. Never store or return raw provider/SQL messages. */
export type FirmImportItemCode =
  'NOT_OWN_CLIENT' | 'LDA_CLIENT_NOT_FOUND' | 'CLIENT_SLOT_LIMIT' | 'INTERNAL_ERROR';

export const IMPORT_JOB_TERMINAL_STATUSES: ReadonlySet<FirmImportJobStatus> = new Set([
  'partially_completed',
  'failed',
  'completed',
]);

const TERMINAL_OUTCOMES: ReadonlySet<FirmImportItemOutcome> = new Set([
  'created',
  'already_present',
  'rejected',
]);

export interface ImportRequestIdentity {
  /** Exactly the ids persisted on the job: deduplicated, ascending, integers only. */
  ids: number[];
  /** Bound to the firm registrant as well as the ids (a registrant change is a new request). */
  requestSha256: string;
}

export interface ImportItemProjectionInput {
  ldaClientId: number;
  outcome: FirmImportItemOutcome;
  code?: string | null;
  clientId?: string | null;
  clientName?: string | null;
}

export interface ImportJobProjectionInput {
  status: FirmImportJobStatus;
  updatedAt: Date;
  items: readonly ImportItemProjectionInput[];
}

export interface ImportJobCounts {
  total: number;
  processed: number;
  successful: number;
  rejected: number;
  outstanding: number;
  created: number;
  alreadyPresent: number;
}

export interface ImportJobProjection extends ImportJobCounts {
  status: FirmImportJobStatus;
  terminal: boolean;
  /** Only a non-terminal job can be stale; staleness signals operator attention. */
  stale: boolean;
  staleAfterSeconds: number;
}

/**
 * The exact normalized selection: integers only, de-duplicated, ascending.
 * Callers' order never matters; the same set always produces the same identity.
 */
export function normalizeImportSelection(ldaClientIds: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const value of ldaClientIds) {
    if (Number.isInteger(value) && value > 0) unique.add(value);
  }
  return [...unique].sort((a, b) => a - b);
}

export function importRequestSha256(ldaRegistrantId: number, ids: readonly number[]): string {
  // Order-independent: the identity is the exact SET of selected ids.
  const canonical = JSON.stringify({
    registrantId: ldaRegistrantId,
    ldaClientIds: [...ids].sort((a, b) => a - b),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function importItemReason(code: FirmImportItemCode | null | undefined): string {
  switch (code) {
    case 'NOT_OWN_CLIENT':
      return 'not a client of your firm';
    case 'LDA_CLIENT_NOT_FOUND':
      return 'LDA client record not found';
    case 'CLIENT_SLOT_LIMIT':
      return 'CLIENT_SLOT_LIMIT: client slot limit reached';
    case 'INTERNAL_ERROR':
      return 'import_failed';
    default:
      return 'skipped';
  }
}

/**
 * Single source of truth for state and counts. Terminal state is asserted ONLY
 * when every persisted item row has a terminal outcome; an unfinished or
 * crashed job never becomes successful/rejected because a process or clock
 * moved. Counts always come from item rows, never from Client counts.
 */
export function projectImportJob(
  input: ImportJobProjectionInput,
  now: Date = new Date(),
): ImportJobProjection {
  let created = 0;
  let alreadyPresent = 0;
  let rejected = 0;
  let processed = 0;
  for (const item of input.items) {
    if (!TERMINAL_OUTCOMES.has(item.outcome)) continue;
    processed += 1;
    if (item.outcome === 'created') created += 1;
    else if (item.outcome === 'already_present') alreadyPresent += 1;
    else rejected += 1;
  }

  const total = input.items.length;
  const outstanding = total - processed;
  const terminal = total > 0 && outstanding === 0;

  let status: FirmImportJobStatus;
  if (!terminal) {
    // Unfinished work stays in-flight. A persisted terminal status with
    // outstanding rows cannot be trusted as completion.
    status = input.status === 'queued' ? 'queued' : 'running';
  } else if (rejected === total) {
    status = 'failed';
  } else if (rejected > 0) {
    status = 'partially_completed';
  } else {
    status = 'completed';
  }

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - input.updatedAt.getTime()) / 1000));
  const stale = !terminal && ageSeconds >= IMPORT_JOB_STALE_AFTER_SECONDS;

  return {
    status,
    terminal,
    stale,
    staleAfterSeconds: IMPORT_JOB_STALE_AFTER_SECONDS,
    total,
    processed,
    successful: created + alreadyPresent,
    rejected,
    outstanding,
    created,
    alreadyPresent,
  };
}

export interface ImportJobItemView {
  ldaClientId: number;
  outcome: FirmImportItemOutcome;
  code: FirmImportItemCode | null;
  clientId: string | null;
  clientName: string | null;
  processedAt: string | null;
}

export interface ImportJobView extends ImportJobProjection {
  id: string;
  requestId: string;
  ldaRegistrantId: number;
  requestedIds: number[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  items: ImportJobItemView[];
  /** Whole job population eligible for the current tenant/filter, not just this page. */
  population?: ImportJobPopulationCounts;
}

export interface ImportJobPopulationCounts {
  total: number;
  queued: number;
  running: number;
  partially_completed: number;
  failed: number;
  completed: number;
}

export function emptyPopulationCounts(): ImportJobPopulationCounts {
  return { total: 0, queued: 0, running: 0, partially_completed: 0, failed: 0, completed: 0 };
}

export interface ImportJobRowLike {
  id: string;
  requestKey: string;
  ldaRegistrantId: number;
  requestedIds: number[];
  status: FirmImportJobStatus;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  items: Array<{
    ldaClientId: number;
    outcome: FirmImportItemOutcome;
    code: string | null;
    clientId: string | null;
    processedAt: Date | null;
  }>;
}

export function toImportJobView(
  row: ImportJobRowLike,
  clientNames: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
  population?: ImportJobPopulationCounts,
): ImportJobView {
  const items: ImportJobItemView[] = row.items
    .slice()
    .sort((a, b) => a.ldaClientId - b.ldaClientId)
    .map((item) => ({
      ldaClientId: item.ldaClientId,
      outcome: item.outcome,
      code: (item.code as FirmImportItemCode | null) ?? null,
      clientId: item.clientId,
      clientName: item.clientId ? (clientNames.get(item.clientId) ?? null) : null,
      processedAt: item.processedAt ? item.processedAt.toISOString() : null,
    }));

  return {
    ...projectImportJob({ status: row.status, updatedAt: row.updatedAt, items }, now),
    id: row.id,
    requestId: row.requestKey,
    ldaRegistrantId: row.ldaRegistrantId,
    requestedIds: row.requestedIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    items,
    ...(population ? { population } : {}),
  };
}

/** Additive POST /firm/import fields; the legacy `created|items|skipped` shape is kept. */
export interface ImportChunkJobSummary {
  id: string;
  requestId: string;
  status: FirmImportJobStatus;
  counts: ImportJobCounts;
  stale: boolean;
}
