/**
 * Defense Budget Lifecycle Watcher — pure domain half.
 *
 * Content identity rule, non-negotiable: `ETag` and `Last-Modified` are discovery
 * optimisations only. The SHA-256 of the retrieved bytes is the authoritative
 * content identity, and it is the only thing that decides whether new work
 * exists. Real official publishers bear this out — GovInfo serves
 * `Last-Modified` but no `ETag` on its PDF packages, so a validator-only design
 * would be blind on the very sources that matter most.
 */

import { canonicalJson, sha256Hex } from './cycle.js';
import type { AuthorityTrack, LifecycleStage, ObservationState, SourceFamily } from './types.js';
import { NON_QUEUEABLE_OBSERVATION_STATES } from './types.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidContentShaError extends Error {
  constructor(readonly value: unknown) {
    super(`Expected a lowercase hex sha256, received: ${String(value)}`);
    this.name = 'InvalidContentShaError';
  }
}

export function assertContentSha256(value: string): string {
  if (!SHA256_PATTERN.test(String(value ?? ''))) throw new InvalidContentShaError(value);
  return value;
}

// ── Observation identity ─────────────────────────────────────────────────────

/**
 * Observation identity is (expected source, content sha). Two watcher runs that
 * see the same bytes therefore produce the SAME key and one observation row.
 * The URL is deliberately excluded: a publisher relocating a document must not
 * manufacture a second observation of identical bytes.
 */
export function observationDedupKey(input: {
  expectedSourceDedupKey: string;
  contentSha256: string;
}): string {
  return sha256Hex(
    canonicalJson({
      kind: 'defense_budget_source_observation_v1',
      expectedSourceDedupKey: input.expectedSourceDedupKey,
      contentSha256: assertContentSha256(input.contentSha256),
    }),
  );
}

export type IngestionJobKind =
  | 'governed_source_ingestion'
  | 'governed_alternative_funding_ingestion';

/**
 * Outbox identity is (observation, job kind). One changed source therefore
 * queues exactly one job, and a repeated observation of the same bytes cannot
 * queue a second — concurrent workers collide on a unique key instead of
 * double-enqueueing.
 */
export function ingestionOutboxDedupKey(input: {
  observationDedupKey: string;
  jobKind: IngestionJobKind;
}): string {
  return sha256Hex(
    canonicalJson({
      kind: 'defense_budget_ingestion_outbox_v1',
      observationDedupKey: input.observationDedupKey,
      jobKind: input.jobKind,
    }),
  );
}

export class NonQueueableObservationError extends Error {
  constructor(readonly state: ObservationState) {
    super(`Observation in state "${state}" must not be queued for governed ingestion`);
    this.name = 'NonQueueableObservationError';
  }
}

/**
 * Application-side twin of the database's composite-foreign-key guard. An
 * ambiguous (review_required), blocked or withdrawn observation may never reach
 * the ingestion queue.
 */
export function assertObservationQueueable(state: ObservationState): ObservationState {
  if (NON_QUEUEABLE_OBSERVATION_STATES.includes(state)) {
    throw new NonQueueableObservationError(state);
  }
  return state;
}

// ── Revision detection ───────────────────────────────────────────────────────

export type SourceRevisionKind =
  | 'first_discovery'
  | 'unchanged'
  | 'changed'
  | 'replacement_url'
  | 'superseding_version';

export interface ObservedSourceSnapshot {
  readonly discoveredUrl: string;
  readonly contentSha256: string;
  readonly httpEtag?: string | null;
  readonly httpLastModified?: string | null;
  /** Official publisher version rank, where the publisher exposes one. */
  readonly versionRank?: number | null;
}

export interface SourceRevisionOutcome {
  readonly kind: SourceRevisionKind;
  /** Whether the immutable source ledger gains a new version row. */
  readonly createsNewVersion: boolean;
  /** Whether governed ingestion work should be queued. */
  readonly queuesIngestion: boolean;
  /** Whether the prior version is superseded (never deleted). */
  readonly supersedesPrevious: boolean;
  readonly reason: string;
}

/**
 * The seven cases the Session 7 assignment requires, resolved from bytes first.
 *
 * Note `replacement_url`: same bytes at a new URL is a relocation, not new
 * content. It must not queue a second parse — that is exactly the duplicated
 * provider/parser cost the cost invariant forbids.
 */
export function detectSourceRevision(input: {
  previous?: ObservedSourceSnapshot | null;
  next: ObservedSourceSnapshot;
}): SourceRevisionOutcome {
  const next = input.next;
  assertContentSha256(next.contentSha256);
  const previous = input.previous ?? null;

  if (!previous) {
    return Object.freeze({
      kind: 'first_discovery' as const,
      createsNewVersion: true,
      queuesIngestion: true,
      supersedesPrevious: false,
      reason: 'no prior observation for this expected source',
    });
  }
  assertContentSha256(previous.contentSha256);

  const sameBytes = previous.contentSha256 === next.contentSha256;
  const sameUrl = previous.discoveredUrl === next.discoveredUrl;

  if (sameBytes && sameUrl) {
    return Object.freeze({
      kind: 'unchanged' as const,
      createsNewVersion: false,
      queuesIngestion: false,
      supersedesPrevious: false,
      reason: 'identical content sha at the same official URL',
    });
  }

  if (sameBytes && !sameUrl) {
    return Object.freeze({
      kind: 'replacement_url' as const,
      createsNewVersion: false,
      queuesIngestion: false,
      supersedesPrevious: false,
      reason: 'publisher relocated identical bytes; content identity is unchanged',
    });
  }

  const previousRank = previous.versionRank ?? null;
  const nextRank = next.versionRank ?? null;
  if (previousRank !== null && nextRank !== null && nextRank > previousRank) {
    return Object.freeze({
      kind: 'superseding_version' as const,
      createsNewVersion: true,
      queuesIngestion: true,
      supersedesPrevious: true,
      reason: `official publisher version advanced ${previousRank} -> ${nextRank}`,
    });
  }

  if (previousRank !== null && nextRank !== null && nextRank < previousRank) {
    // An older official version appearing after a newer one is not a revision.
    // Record it, but never let it overwrite the later stage evidence.
    return Object.freeze({
      kind: 'changed' as const,
      createsNewVersion: true,
      queuesIngestion: false,
      supersedesPrevious: false,
      reason: `refusing to supersede: publisher version regressed ${previousRank} -> ${nextRank}`,
    });
  }

  return Object.freeze({
    kind: 'changed' as const,
    createsNewVersion: true,
    queuesIngestion: true,
    supersedesPrevious: true,
    reason: 'content sha changed at the same official source identity',
  });
}

/**
 * Conditional-fetch hint. Returns request headers that let a publisher answer
 * 304, purely to save bandwidth. A 304 is NOT proof of unchanged content — the
 * caller still records the prior SHA as the authoritative identity, and any 200
 * response is re-hashed regardless of what the validators claimed.
 */
export function conditionalFetchHeaders(
  previous: ObservedSourceSnapshot | null | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (previous?.httpEtag) headers['if-none-match'] = previous.httpEtag;
  if (previous?.httpLastModified) headers['if-modified-since'] = previous.httpLastModified;
  return Object.freeze(headers);
}

// ── Watcher cadence ──────────────────────────────────────────────────────────

export type WatcherSeason = 'in_season' | 'shoulder' | 'off_season';

export interface AdapterCadence {
  readonly adapterId: string;
  readonly inSeasonMinutes: number;
  readonly shoulderMinutes: number;
  readonly offSeasonMinutes: number;
}

export const DEFAULT_ADAPTER_CADENCE: AdapterCadence = Object.freeze({
  adapterId: 'default',
  inSeasonMinutes: 180,
  shoulderMinutes: 720,
  offSeasonMinutes: 2880,
});

/**
 * Months in which each adapter family is actually publishing, so cadence is
 * driven by the calendar rather than by a hand-edited schedule. A new fiscal
 * year needs no configuration change.
 *
 *   - Comptroller/service exhibit sites publish the PB in Feb–May.
 *   - Committees mark up and report May–Sep.
 *   - Conference/JES and public laws land Nov–Mar.
 *   - Reprogramming/transfer actions follow execution, Oct–Sep, all year.
 */
const ADAPTER_IN_SEASON_MONTHS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  'dod-comptroller': [2, 3, 4, 5],
  'army-budget': [2, 3, 4, 5],
  'navy-budget': [2, 3, 4, 5],
  'saf-fm-budget': [2, 3, 4, 5],
  hasc: [4, 5, 6, 7],
  sasc: [5, 6, 7, 8],
  'house-appropriations': [5, 6, 7, 8],
  'senate-appropriations': [6, 7, 8, 9],
  'govinfo-committee-reports': [5, 6, 7, 8, 9, 11, 12],
  'govinfo-bills': [6, 7, 8, 9, 10, 11, 12],
  'govinfo-public-laws': [11, 12, 1, 2, 3],
  'congress-gov': [5, 6, 7, 8, 9, 11, 12],
  'dod-comptroller-reprogramming': [4, 5, 6, 7, 8, 9],
  'dod-contract-announcements': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
});

/** Months adjacent to an adapter's in-season window get the shoulder cadence. */
function isShoulderMonth(inSeason: readonly number[], month: number): boolean {
  const previous = month === 1 ? 12 : month - 1;
  const next = month === 12 ? 1 : month + 1;
  return inSeason.includes(previous) || inSeason.includes(next);
}

/**
 * Per-adapter season for an instant. Adapters with no registry entry fall back
 * to the congressional calendar rather than to a constant, so an unregistered
 * adapter is merely imprecise, never silently idle.
 */
export function watcherSeasonForInstant(
  instantIso: string,
  adapterId: string = 'default',
): WatcherSeason {
  const date = new Date(instantIso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid instant: ${instantIso}`);
  const month = date.getUTCMonth() + 1;
  const inSeason = ADAPTER_IN_SEASON_MONTHS[adapterId] ?? [5, 6, 7, 8, 9, 11, 12];
  if (inSeason.includes(month)) return 'in_season';
  if (isShoulderMonth(inSeason, month)) return 'shoulder';
  return 'off_season';
}

export function nextWatcherCheckAt(input: {
  nowIso: string;
  cadence?: AdapterCadence;
  season?: WatcherSeason;
  /** Consecutive failures; backs the adapter off without ever stopping it. */
  consecutiveFailures?: number;
}): string {
  const cadence = input.cadence ?? DEFAULT_ADAPTER_CADENCE;
  const season = input.season ?? watcherSeasonForInstant(input.nowIso, cadence.adapterId);
  const base =
    season === 'in_season'
      ? cadence.inSeasonMinutes
      : season === 'shoulder'
        ? cadence.shoulderMinutes
        : cadence.offSeasonMinutes;
  const failures = Math.max(0, input.consecutiveFailures ?? 0);
  const backoff = Math.min(2 ** failures, 8);
  const now = new Date(input.nowIso);
  if (Number.isNaN(now.getTime())) throw new RangeError(`Invalid instant: ${input.nowIso}`);
  return new Date(now.getTime() + base * backoff * 60_000).toISOString();
}

// ── GPU independence ─────────────────────────────────────────────────────────

/**
 * The watcher is CPU/network work. Under the accepted Session 5 negative
 * provider decision NVIDIA routing is disabled and there is no persistent
 * endpoint; discovery and classification must not depend on either.
 */
export const WATCHER_EXECUTION_CONTRACT = Object.freeze({
  requiresGpu: false as const,
  nvidiaRouting: 'disabled' as const,
  activeGpuCapacity: 0 as const,
  nvidiaQueuedPages: 0 as const,
  persistentNvidiaEndpoint: false as const,
  productionParser: 'DETERMINISTIC_PRIMARY' as const,
  // Provider-neutral aliases. `apps/defense-api` reads these instead of the
  // provider-named fields above, because the Session 3 boundary forbids the
  // HTTP service from naming a GPU provider at all.
  providerRouting: 'disabled' as const,
  queuedProviderPages: 0 as const,
});

/**
 * Resolve the GPU/provider environment for a watcher run.
 *
 * The provider routing mode is read HERE rather than in `defense-api`, because
 * the Session 3 boundary forbids the HTTP service from naming NVIDIA at all —
 * and because the accepted Session 5 decision is a domain invariant, not a
 * service-level configuration knob. A caller that has no environment gets the
 * accepted default: disabled.
 */
export function resolveWatcherGpuEnvironment(
  env: Readonly<Record<string, string | undefined>> = {},
): { readonly providerRouting: string; readonly activeGpuCapacity: number } {
  return Object.freeze({
    providerRouting: env.NVIDIA_ROUTING_MODE ?? 'disabled',
    activeGpuCapacity: Number(env.ACTIVE_GPU_CAPACITY ?? 0) || 0,
  });
}

export class WatcherGpuDependencyError extends Error {
  constructor(readonly detail: string) {
    super(`Lifecycle watcher must not require GPU capacity: ${detail}`);
    this.name = 'WatcherGpuDependencyError';
  }
}

/**
 * Fail-closed proof that a watcher run needs no GPU. Called at the start of
 * every run so a future change that introduces a GPU dependency breaks loudly
 * instead of quietly reviving provider spend.
 */
export function assertWatcherRunnableWithoutGpu(env: {
  /** Provider-neutral input name; see the alias note on the contract above. */
  readonly providerRouting?: string | null;
  readonly nvidiaRouting?: string | null;
  readonly activeGpuCapacity?: number | null;
  readonly requiresGpu?: boolean | null;
}): typeof WATCHER_EXECUTION_CONTRACT {
  if (env.requiresGpu === true) {
    throw new WatcherGpuDependencyError('run declared requiresGpu=true');
  }
  if (typeof env.activeGpuCapacity === 'number' && env.activeGpuCapacity !== 0) {
    throw new WatcherGpuDependencyError(`activeGpuCapacity=${env.activeGpuCapacity}`);
  }
  const routing = env.providerRouting ?? env.nvidiaRouting;
  if (routing && routing !== 'disabled') {
    throw new WatcherGpuDependencyError(`nvidiaRouting=${routing}`);
  }
  return WATCHER_EXECUTION_CONTRACT;
}

// ── Lease / crash-retry safety ───────────────────────────────────────────────

export interface WatcherLease {
  readonly adapterId: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
}

/**
 * A crashed worker's lease expires; a second worker may then resume. Two live
 * workers can never both hold the same adapter, so a crash/retry resumes safely
 * without double-processing.
 */
export function canAcquireWatcherLease(input: {
  existing?: WatcherLease | null;
  candidateOwner: string;
  nowIso: string;
}): { readonly acquired: boolean; readonly reason: string } {
  const now = new Date(input.nowIso).getTime();
  if (Number.isNaN(now)) throw new RangeError(`Invalid instant: ${input.nowIso}`);
  if (!input.existing) return Object.freeze({ acquired: true, reason: 'no existing lease' });
  if (input.existing.leaseOwner === input.candidateOwner) {
    return Object.freeze({ acquired: true, reason: 'lease already held by this owner' });
  }
  const expiresAt = new Date(input.existing.leaseExpiresAt).getTime();
  if (Number.isNaN(expiresAt)) throw new RangeError(`Invalid lease expiry: ${input.existing.leaseExpiresAt}`);
  if (expiresAt <= now) {
    return Object.freeze({ acquired: true, reason: 'previous lease expired after crash or timeout' });
  }
  return Object.freeze({
    acquired: false,
    reason: `adapter is leased by ${input.existing.leaseOwner} until ${input.existing.leaseExpiresAt}`,
  });
}

// ── Alternative-funding routing ──────────────────────────────────────────────

export interface AlternativeFundingRoute {
  readonly measureType:
    | 'supplemental'
    | 'emergency_supplemental'
    | 'reconciliation'
    | 'continuing_resolution'
    | 'rescission'
    | 'transfer'
    | 'reprogramming';
  readonly jobKind: IngestionJobKind;
  /** Discovery metadata NEVER carries dollars; ingestion is the only path. */
  readonly fabricatesDollars: false;
  readonly note: string;
}

const ALTERNATIVE_FUNDING_STAGE_TO_MEASURE: Readonly<
  Partial<Record<LifecycleStage, AlternativeFundingRoute['measureType']>>
> = Object.freeze({
  supplemental: 'supplemental',
  emergency_supplemental: 'emergency_supplemental',
  reconciliation: 'reconciliation',
  continuing_resolution: 'continuing_resolution',
  rescission: 'rescission',
  transfer: 'transfer',
  reprogramming: 'reprogramming',
});

export class NotAlternativeFundingStageError extends Error {
  constructor(readonly stage: LifecycleStage) {
    super(`Stage ${stage} is not an alternative-funding stage`);
    this.name = 'NotAlternativeFundingStageError';
  }
}

/**
 * Route an alternative-funding discovery into the Session 6 governed domain.
 *
 * This says "an official document of this vehicle type exists". It does not, and
 * structurally cannot, create provisions, allocations, PE dollars or capability
 * dollars — those come only from evidence-bound Session 6 ingestion.
 */
export function routeAlternativeFundingDiscovery(input: {
  stage: LifecycleStage;
  sourceFamily: SourceFamily;
  authorityTrack: AuthorityTrack;
}): AlternativeFundingRoute {
  if (input.authorityTrack !== 'alternative_funding') {
    throw new NotAlternativeFundingStageError(input.stage);
  }
  const measureType = ALTERNATIVE_FUNDING_STAGE_TO_MEASURE[input.stage];
  if (!measureType) throw new NotAlternativeFundingStageError(input.stage);
  return Object.freeze({
    measureType,
    jobKind: 'governed_alternative_funding_ingestion' as const,
    fabricatesDollars: false as const,
    note:
      'watcher records vehicle existence and classification only; provisions and allocations ' +
      'require governed Session 6 evidence-bound ingestion',
  });
}
