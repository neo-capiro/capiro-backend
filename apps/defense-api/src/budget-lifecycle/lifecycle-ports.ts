/**
 * Ports for the Session 7 control loop.
 *
 * Discovery, byte retrieval and persistence are behind interfaces so the control
 * loop itself — the part that decides whether new work exists, whether a source
 * is ambiguous, and whether ingestion may be queued — is testable against real
 * recorded official sources without a network or a database.
 */

import type {
  AuthorityTrack,
  BundleMemberFactsV1,
  ExpectedSourceState,
  IngestionJobKind,
  LifecycleStage,
  ObservationState,
  SourceFamily,
  SourceRevisionKind,
} from '@capiro/defense-domain';

/** A candidate the adapter believes may satisfy an expected source. */
export interface DiscoveredCandidate {
  readonly adapterId: string;
  readonly expectedSourceDedupKey: string;
  readonly url: string;
  readonly packageId?: string | null;
  readonly title?: string | null;
  readonly declaredFiscalYear?: number | null;
  readonly divisionEvidence?: string | null;
  /** Publisher version rank, when the publisher versions the document itself. */
  readonly versionRank?: number | null;
  /** Set when the publisher reports the document withdrawn or removed. */
  readonly withdrawn?: boolean;
}

export interface SourceDiscoveryPort {
  /**
   * Discover candidates for one adapter. Implementations must respect the
   * adapter's rate limit and publishing constraints, and must return only URLs
   * on the adapter's own official hosts.
   */
  discover(input: {
    adapterId: string;
    cursor: Record<string, unknown>;
    nowIso: string;
  }): Promise<{
    candidates: readonly DiscoveredCandidate[];
    cursor: Record<string, unknown>;
  }>;
}

export interface FetchedSource {
  /** 304 means the publisher reports no change; bytes are absent. */
  readonly notModified: boolean;
  readonly contentSha256: string | null;
  readonly byteSize: number | null;
  readonly httpEtag: string | null;
  readonly httpLastModified: string | null;
  /** Text rendition used to corroborate the metadata classification. */
  readonly contentExcerpt: string | null;
  /**
   * `false` when the publisher offers no text rendition at all (GovInfo BUDGET
   * packages and every comptroller/service exhibit are PDF-only). Corroboration
   * is then deferred to deterministic parsing plus Phase 2 verification rather
   * than treated as ambiguity.
   */
  readonly contentExcerptAvailable: boolean;
  readonly blocked?: boolean;
  readonly blockedReason?: string | null;
}

export interface SourceFetchPort {
  fetch(input: {
    url: string;
    conditionalHeaders: Readonly<Record<string, string>>;
  }): Promise<FetchedSource>;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface StoredCycle {
  readonly id: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
}

export interface StoredExpectedSource {
  readonly id: string;
  readonly cycleId: string;
  readonly dedupKey: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly adapterId: string;
  readonly expectedState: ExpectedSourceState;
  readonly optional: boolean;
  readonly expectedTo: string;
}

export interface StoredObservation {
  readonly id: string;
  readonly expectedSourceId: string;
  readonly cycleId: string;
  readonly discoveredUrl: string;
  readonly contentSha256: string;
  readonly httpEtag: string | null;
  readonly httpLastModified: string | null;
  readonly observationState: ObservationState;
  readonly revisionKind: SourceRevisionKind;
  readonly versionRank: number | null;
  readonly dedupKey: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
}

export interface NewObservation {
  readonly expectedSourceId: string;
  readonly cycleId: string;
  readonly adapterId: string;
  readonly discoveredUrl: string;
  readonly contentSha256: string;
  readonly byteSize: number | null;
  readonly httpEtag: string | null;
  readonly httpLastModified: string | null;
  readonly observationState: ObservationState;
  readonly revisionKind: SourceRevisionKind;
  readonly classifiedFiscalYear: number | null;
  readonly classifiedAuthorityTrack: AuthorityTrack | null;
  readonly classifiedStage: LifecycleStage | null;
  readonly classifiedSourceFamily: SourceFamily | null;
  readonly classificationConfidence: number | null;
  readonly reviewReasons: readonly string[];
  readonly versionRank: number | null;
  readonly dedupKey: string;
  readonly observedAt: string;
}

export interface LifecycleStore {
  /** Idempotent by (fiscalYear, authorityTrack). */
  upsertCycle(input: {
    fiscalYear: number;
    authorityTrack: AuthorityTrack;
    templateVersion: string;
    bootstrapOrigin: 'discovery' | 'template' | 'operator';
    dedupKey: string;
  }): Promise<StoredCycle>;

  /** Idempotent by dedupKey; never resets an already-observed state. */
  upsertExpectedSource(input: {
    cycleId: string;
    plan: Omit<StoredExpectedSource, 'id' | 'cycleId'> & {
      chamber: string | null;
      committee: string | null;
      component: string | null;
      label: string;
      templateVersion: string;
      expectedFrom: string;
    };
  }): Promise<StoredExpectedSource>;

  findExpectedSourceByDedupKey(dedupKey: string): Promise<StoredExpectedSource | null>;

  /** Most recent non-superseded observation for an expected source. */
  findLatestObservation(expectedSourceId: string): Promise<StoredObservation | null>;

  /**
   * Insert-or-touch. `created: false` means these exact bytes were already
   * recorded for this expected source, so the run must not create new work.
   */
  recordObservation(
    observation: NewObservation,
  ): Promise<{ observation: StoredObservation; created: boolean }>;

  supersedeObservation(input: { previousId: string; nextId: string }): Promise<void>;

  setExpectedSourceState(input: {
    expectedSourceId: string;
    expectedState: ExpectedSourceState;
    reviewReason: string | null;
  }): Promise<void>;

  /**
   * Phase 10B-18 Part D. Optional: an implementation that never registers
   * bundle members (every store predating this phase) may omit it entirely —
   * the watcher treats a missing method exactly like an empty array, which is
   * `evaluateBundleCompletenessV1`'s `no_bundle` case, i.e. byte-for-byte the
   * pre-Phase-10B-18 behavior. Only an expected source with rows in
   * `defense_budget_source_bundle_member` (currently: none in production —
   * this phase does not seed any) is affected.
   */
  loadBundleMembers?(expectedSourceId: string): Promise<readonly BundleMemberFactsV1[]>;

  /** `created: false` when this observation already has a job of this kind. */
  enqueueIngestion(input: {
    observationId: string;
    observationState: ObservationState;
    cycleId: string;
    jobKind: IngestionJobKind;
    dedupKey: string;
  }): Promise<{ created: boolean }>;

  loadAdapterState(adapterId: string): Promise<{
    cursor: Record<string, unknown>;
    consecutiveFailures: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
  } | null>;

  /** Must be atomic: returns false if another live worker holds the lease. */
  acquireAdapterLease(input: {
    adapterId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): Promise<boolean>;

  releaseAdapterLease(input: {
    adapterId: string;
    leaseOwner: string;
    cursor: Record<string, unknown>;
    nextCheckAt: string;
    succeeded: boolean;
    errorClass: string | null;
    errorMessage: string | null;
    nowIso: string;
  }): Promise<void>;

  recordWatcherRun(input: {
    adapterId: string;
    runKey: string;
    status: 'succeeded' | 'failed' | 'partial';
    startedAt: string;
    finishedAt: string;
    discovered: number;
    unchanged: number;
    changed: number;
    review: number;
    queued: number;
    blocked: number;
    attempt: number;
    errorClass: string | null;
    errorMessage: string | null;
    nextCheckAt: string;
  }): Promise<void>;
}
