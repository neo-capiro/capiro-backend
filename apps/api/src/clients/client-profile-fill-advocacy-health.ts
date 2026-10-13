import { asRecord, asString } from './client-profile-fill.helpers.js';

export type AdvocacyBackfillStatus =
  'not_started' | 'in_progress' | 'complete' | 'partial' | 'failed';

export interface AdvocacySourceBackfillState {
  status: AdvocacyBackfillStatus;
  startedAt?: string;
  completedAt?: string;
  checkpoint?: Record<string, unknown> | null;
  historyStart?: string | null;
  examined: number;
  candidates: number;
  lastError?: string | null;
  lastErrorAt?: string;
  limitation?: string | null;
  suggestions?: unknown[];
  availability?: AdvocacySourceAvailability;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  freshness?: AdvocacySourceFreshness;
  nextRefreshAt?: string;
}

export type AdvocacySourceAvailability = 'available' | 'unavailable' | 'degraded' | 'unknown';
export type AdvocacySourceFreshness = 'fresh' | 'stale' | 'unknown';
export type AdvocacyOverallHealth =
  'not_built' | 'building_history' | 'current' | 'stale' | 'partial' | 'degraded' | 'failed';

export interface AdvocacySourceHealth extends AdvocacySourceBackfillState {
  source: string;
  backfillStatus: AdvocacyBackfillStatus;
  availability: AdvocacySourceAvailability;
  freshness: AdvocacySourceFreshness;
}

export interface AdvocacyHistoryHealth {
  overall: AdvocacyOverallHealth;
  refreshedAt?: string;
  nextRefreshAt?: string;
  pendingFindings: number;
  acceptedFindings: number;
  rejectedFindings: number;
  sources: AdvocacySourceHealth[];
}
export type AdvocacyBackfillOverallStatus =
  | 'never_started'
  | 'backfill_running'
  | 'backfill_partial'
  | 'backfill_complete'
  | 'backfill_failed';
export const ADVOCACY_SOURCE_NAMES = [
  'lda',
  'fara',
  'testimony',
  'regulations_gov',
  'federal_register',
  'community_funding',
  'client_submission',
  'private_evidence',
] as const;
// Low-frequency canonical/enrichment sources tolerate two configured cycles;
// continuously growing activity sources become stale after one missed cycle.
const ADVOCACY_FRESHNESS_CADENCE_MULTIPLIER: Record<string, number> = {
  lda: 1,
  testimony: 1,
  regulations_gov: 1,
  client_submission: 1,
  private_evidence: 1,
  fara: 2,
  federal_register: 2,
  // Canonical CPF/CDS tables grow with each congressional cycle, not daily —
  // same low-frequency class as FARA / Federal Register.
  community_funding: 2,
};
export function deriveAdvocacyBackfillOverallStatus(
  sources: Record<string, Pick<AdvocacySourceBackfillState, 'status'>>,
): AdvocacyBackfillOverallStatus {
  const statuses = Object.values(sources).map((source) => source.status);
  if (statuses.length === 0 || statuses.every((status) => status === 'not_started')) {
    return 'never_started';
  }
  if (statuses.every((status) => status === 'complete')) return 'backfill_complete';
  if (statuses.every((status) => status === 'failed')) return 'backfill_failed';
  if (statuses.some((status) => status === 'partial' || status === 'failed')) {
    return 'backfill_partial';
  }
  return 'backfill_running';
}

export function deriveAdvocacyFreshness(
  source: string,
  lastSuccessAt: string | null | undefined,
  cadenceHours: number,
  now = new Date(),
): AdvocacySourceFreshness {
  if (!lastSuccessAt) return 'unknown';
  const lastSuccess = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastSuccess)) return 'unknown';
  const multiplier = ADVOCACY_FRESHNESS_CADENCE_MULTIPLIER[source] ?? 1;
  const windowMs = Math.max(1, cadenceHours) * multiplier * 60 * 60_000;
  return now.getTime() - lastSuccess <= windowMs ? 'fresh' : 'stale';
}

export function updateAdvocacySourceHealth(
  source: string,
  prior: Record<string, unknown>,
  current: AdvocacySourceBackfillState,
  attemptedAt: string,
  cadenceHours: number,
  nextRefreshAt: Date | string | null,
): AdvocacySourceBackfillState {
  const hadError = Boolean(current.lastError);
  const priorSuccess = asString(prior.lastSuccessAt);
  const limitation = current.limitation ?? null;
  // A transient refresh failure must never erase already-earned historical
  // completeness. The failure belongs to availability/freshness, not backfill.
  const status = hadError && asString(prior.status) === 'complete' ? 'complete' : current.status;
  const lastSuccessAt = hadError ? priorSuccess : attemptedAt;
  const availability: AdvocacySourceAvailability = hadError
    ? priorSuccess
      ? 'degraded'
      : 'unavailable'
    : limitation
      ? 'degraded'
      : 'available';
  return {
    ...current,
    status,
    completedAt:
      status === 'complete'
        ? (current.completedAt ?? asString(prior.completedAt) ?? undefined)
        : current.completedAt,
    checkpoint:
      hadError && !current.checkpoint && Object.keys(asRecord(prior.checkpoint)).length
        ? asRecord(prior.checkpoint)
        : current.checkpoint,
    examined: hadError ? Math.max(Number(prior.examined ?? 0), current.examined) : current.examined,
    candidates: hadError
      ? Math.max(Number(prior.candidates ?? 0), current.candidates)
      : current.candidates,
    availability,
    lastAttemptAt: attemptedAt,
    lastSuccessAt: lastSuccessAt ?? undefined,
    freshness: deriveAdvocacyFreshness(source, lastSuccessAt, cadenceHours, new Date(attemptedAt)),
    nextRefreshAt:
      nextRefreshAt instanceof Date ? nextRefreshAt.toISOString() : (nextRefreshAt ?? undefined),
    lastError: hadError ? sourceHealthMessage(source, current.lastError!) : null,
    lastErrorAt: hadError ? attemptedAt : undefined,
  };
}

export function deriveAdvocacyOverallHealth(
  sources: Record<
    string,
    Pick<AdvocacySourceBackfillState, 'status' | 'availability' | 'freshness' | 'limitation'>
  >,
): AdvocacyOverallHealth {
  const states = Object.values(sources);
  if (!states.length || states.every((state) => state.status === 'not_started')) return 'not_built';
  if (states.some((state) => state.status === 'in_progress')) return 'building_history';
  if (
    states.length > 0 &&
    states.every((state) => state.status === 'failed' || state.availability === 'unavailable')
  ) {
    return 'failed';
  }
  if (states.some((state) => state.status === 'partial' || Boolean(state.limitation))) {
    return 'partial';
  }
  if (
    states.some(
      (state) => state.availability === 'unavailable' || state.availability === 'degraded',
    )
  ) {
    return 'degraded';
  }
  if (states.some((state) => state.freshness !== 'fresh')) return 'stale';
  return states.every((state) => state.status === 'complete') ? 'current' : 'not_built';
}

export function buildAdvocacyHistoryHealth(
  cursor: Record<string, unknown>,
  cadenceHours: number,
  nextRefreshAt: Date | string | null,
  counts: { pending: number; accepted: number; rejected: number },
  now = new Date(),
): AdvocacyHistoryHealth {
  const persisted = asRecord(asRecord(cursor.backfill).sources);
  const sources = ADVOCACY_SOURCE_NAMES.map((source): AdvocacySourceHealth => {
    const state = asRecord(persisted[source]);
    const lastSuccessAt = asString(state.lastSuccessAt);
    const lastError = asString(state.lastError);
    return {
      source,
      status: (asString(state.status) as AdvocacyBackfillStatus) ?? 'not_started',
      backfillStatus: (asString(state.status) as AdvocacyBackfillStatus) ?? 'not_started',
      startedAt: asString(state.startedAt) ?? undefined,
      completedAt: asString(state.completedAt) ?? undefined,
      checkpoint: Object.keys(asRecord(state.checkpoint)).length
        ? asRecord(state.checkpoint)
        : null,
      historyStart: asString(state.historyStart),
      examined: Number(state.examined ?? 0),
      candidates: Number(state.candidates ?? 0),
      limitation: asString(state.limitation),
      availability: (asString(state.availability) as AdvocacySourceAvailability) ?? 'unknown',
      lastAttemptAt: asString(state.lastAttemptAt) ?? undefined,
      lastSuccessAt: lastSuccessAt ?? undefined,
      freshness: deriveAdvocacyFreshness(source, lastSuccessAt, cadenceHours, now),
      nextRefreshAt:
        nextRefreshAt instanceof Date ? nextRefreshAt.toISOString() : (nextRefreshAt ?? undefined),
      lastError: lastError ? sourceHealthMessage(source, lastError) : null,
      lastErrorAt: asString(state.lastErrorAt) ?? undefined,
    };
  });
  const sourceRecord = Object.fromEntries(sources.map((source) => [source.source, source]));
  return {
    overall: deriveAdvocacyOverallHealth(sourceRecord),
    refreshedAt: asString(cursor.refreshedAt) ?? undefined,
    nextRefreshAt:
      nextRefreshAt instanceof Date ? nextRefreshAt.toISOString() : (nextRefreshAt ?? undefined),
    pendingFindings: counts.pending,
    acceptedFindings: counts.accepted,
    rejectedFindings: counts.rejected,
    sources,
  };
}

function sourceHealthMessage(source: string, error: string): string {
  const label =
    source === 'regulations_gov'
      ? 'Regulations.gov'
      : source === 'federal_register'
        ? 'Federal Register'
        : source === 'community_funding'
          ? 'Community Project Funding / Congressionally Directed Spending'
          : source === 'client_submission'
            ? 'Client submissions'
            : source === 'private_evidence'
              ? 'Private evidence'
              : source.toUpperCase();
  if (/not configured|api.?key/i.test(error))
    return `${label} is unavailable because it is not configured`;
  return `${label} is temporarily unavailable`;
}
