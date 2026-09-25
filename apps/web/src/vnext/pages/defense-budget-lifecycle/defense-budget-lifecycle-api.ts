import type { AxiosInstance } from 'axios';

/**
 * Phase 8 Session 11 — typed client for the new, read-only
 * `budget-lifecycle/*` product routes on `defense-api`.
 *
 * Local interfaces rather than an import from `@capiro/defense-contracts`:
 * the frontend has no workspace dependency on that package (same convention
 * `pages/program-element/api.ts` already uses for `budget-lines/*`), so
 * these are kept in sync with `packages/defense-contracts/src/public/budget-lifecycle.ts`
 * / `budget-lifecycle-product-routes.ts` by hand.
 *
 * Every field here can legitimately be `null` — a missing official source is
 * a recorded fact, never a zero. Nothing in this file invents a fallback
 * number for a field the API did not return.
 */

export type AuthorityTrack = 'request' | 'authorization' | 'appropriations' | 'alternative_funding' | 'execution';
export type ExpectedSourceState =
  | 'expected'
  | 'not_filed'
  | 'published'
  | 'superseded'
  | 'withdrawn'
  | 'unavailable'
  | 'review_required';
export type ObservationState =
  | 'discovered'
  | 'downloaded'
  | 'unchanged'
  | 'changed'
  | 'classified'
  | 'review_required'
  | 'queued'
  | 'ingested'
  | 'blocked'
  | 'superseded'
  | 'withdrawn';

export interface CycleTrackHealth {
  authorityTrack: AuthorityTrack;
  expectedSources: number;
  published: number;
  notFiled: number;
  reviewRequired: number;
  superseded: number;
  withdrawn: number;
  unavailable: number;
  stillExpected: number;
}

export interface CycleHealth {
  schemaVersion: 'defense_budget_cycle_health_v1';
  fiscalYear: number;
  generatedAt: string;
  expectedSources: number;
  published: number;
  verified: number;
  reviewRequired: number;
  rejected: number;
  notFiled: number;
  parserFailures: number;
  failedDownloads: number;
  reviewBacklog: number;
  lastDiscoveryAt: string | null;
  nextWatcherRunAt: string | null;
  staleAdapters: readonly string[];
  tracks: readonly CycleTrackHealth[];
  nvidiaRouting: 'disabled';
  productionParser: 'DETERMINISTIC_PRIMARY';
  missingSourceMeansUnknownNotZero: true;
}

export type CoverageExceptionCode =
  | 'catalog_completeness_unknown'
  | 'physical_source_missing'
  | 'source_unavailable'
  | 'source_superseded'
  | 'extraction_missing'
  | 'verification_not_passed'
  | 'review_missing'
  | 'publication_missing'
  | 'publication_lineage_unbound'
  | 'account_attribution_unknown';

export interface PhysicalSourceUnitReconciliation {
  unitId: string;
  kind: 'document' | 'volume' | 'section' | 'exhibit';
  required: boolean;
  superseded: boolean;
  account: string | null;
  budgetActivity: string | null;
  volume: string | null;
  sourceDocumentId: string | null;
  parsed: boolean;
  verified: boolean;
  reviewed: boolean;
  published: boolean;
  exceptions: readonly CoverageExceptionCode[];
}

export interface PhysicalSourceCoverageRow {
  slotId: string;
  fiscalYear: number;
  sourceFamily: string;
  component: string | null;
  optional: boolean;
  discovery: 'observed' | 'not_observed' | 'unknown';
  /** Null means the source catalog's denominator is not attested. */
  denominator: number | null;
  knownRequiredUnits: number;
  knownOptionalUnits: number;
  parsed: number;
  verified: number;
  reviewed: number;
  published: number;
  exceptions: readonly CoverageExceptionCode[];
  units: readonly PhysicalSourceUnitReconciliation[];
}

export interface CoverageReconciliation {
  schemaVersion: 'defense_coverage_reconciliation_v1';
  fiscalYear: number;
  environment: string;
  activeSnapshotId: string | null;
  logicalSlotCount: number;
  rows: readonly PhysicalSourceCoverageRow[];
}

export interface ExpectedSourceListItem {
  id: string;
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  stage: string;
  sourceFamily: string;
  adapterId: string;
  label: string;
  expectedState: ExpectedSourceState;
  optional: boolean;
  expectedTo: string;
  reviewReason: string | null;
  knownFundingPosition: null;
}

export interface SourceObservation {
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  stage: string;
  sourceFamily: string;
  adapterId: string;
  discoveredUrl: string;
  contentSha256: string;
  byteSize: number | null;
  observationState: ObservationState;
  classificationConfidence: number | null;
  reviewReasons: readonly string[];
  sourceDocumentId: string | null;
  supersededByObservationId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}

export interface ExpectedSourceDetail extends ExpectedSourceListItem {
  chamber: 'house' | 'senate' | 'joint' | null;
  committee: string | null;
  component: string | null;
  expectedFrom: string;
  observations: readonly SourceObservation[];
}

export interface ReviewQueueItem {
  expectedSourceId: string;
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  stage: string;
  sourceFamily: string;
  adapterId: string;
  label: string;
  expectedState: ExpectedSourceState;
  expectedSourceReviewReason: string | null;
  observation: SourceObservation;
}

export interface LifecycleSignal {
  signalKind: string;
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  fromStage: string;
  toStage: string;
  fromContentSha256: string;
  toContentSha256: string;
  emittedAt: string;
  carriesFundingAmounts: false;
}

export interface ScheduleTickHealth {
  schemaVersion: 'defense_budget_schedule_tick_health_v1';
  generatedAt: string;
  ticksConsidered: number;
  lastTickAt: string | null;
  lastTickOutcome: 'completed' | 'failed' | null;
  lastTickWorkerId: string | null;
  staleSinceLastTick: boolean;
  completedTicks: number;
  failedTicks: number;
  totalAdaptersConsidered: number;
  totalAdaptersSucceeded: number;
  totalAdaptersFailed: number;
  totalAdaptersSkippedLease: number;
  recentFailureReasons: readonly string[];
}

const BASE = '/api/budget-lifecycle';

export async function getCycleHealth(api: AxiosInstance, fiscalYear: number): Promise<CycleHealth> {
  return (await api.get<CycleHealth>(`${BASE}/cycles/${fiscalYear}/health`)).data;
}

export async function getCoverageReconciliation(
  api: AxiosInstance,
  fiscalYear: number,
): Promise<CoverageReconciliation> {
  return (
    await api.get<CoverageReconciliation>(`${BASE}/cycles/${fiscalYear}/coverage-reconciliation`)
  ).data;
}

export async function listExpectedSources(
  api: AxiosInstance,
  fiscalYear: number,
  filters: { authorityTrack?: string; expectedState?: string } = {},
): Promise<readonly ExpectedSourceListItem[]> {
  return (
    await api.get<readonly ExpectedSourceListItem[]>(`${BASE}/cycles/${fiscalYear}/expected-sources`, {
      params: filters,
    })
  ).data;
}

export async function getExpectedSourceDetail(api: AxiosInstance, id: string): Promise<ExpectedSourceDetail> {
  return (await api.get<ExpectedSourceDetail>(`${BASE}/expected-sources/${encodeURIComponent(id)}`)).data;
}

export async function listReviewQueue(api: AxiosInstance, fiscalYear: number): Promise<readonly ReviewQueueItem[]> {
  return (await api.get<readonly ReviewQueueItem[]>(`${BASE}/cycles/${fiscalYear}/review-queue`)).data;
}

export async function listSignals(api: AxiosInstance, fiscalYear: number): Promise<readonly LifecycleSignal[]> {
  return (await api.get<readonly LifecycleSignal[]>(`${BASE}/cycles/${fiscalYear}/signals`)).data;
}

export async function getScheduleTickHealth(api: AxiosInstance): Promise<ScheduleTickHealth> {
  return (await api.get<ScheduleTickHealth>(`${BASE}/schedule/tick-health`)).data;
}
