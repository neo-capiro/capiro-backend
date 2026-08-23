/**
 * Phase 10B-1 — governed observation-to-SourceDocument bridge.
 *
 * Ports the bridge service depends on. Kept separate from the service so the
 * decision logic is testable against fakes, exactly like every other
 * defense-budget service in this directory (RawArchiveService,
 * DocumentRegistrar, ParseRunner all follow the same shape).
 */
import type {
  AuthorityTrack,
  LifecycleStage,
  ObservationState,
  SourceFamily,
} from '@capiro/defense-domain';

/** The exact, immutable fields the bridge needs from one lifecycle observation. */
export interface BridgeObservationRecord {
  readonly id: string;
  readonly expectedSourceId: string;
  readonly cycleId: string;
  readonly adapterId: string;
  readonly discoveredUrl: string;
  readonly contentSha256: string;
  readonly observationState: ObservationState;
  /** Non-null exactly when observationState is 'changed' or 'ingested' (never ambiguous). */
  readonly classifiedFiscalYear: number | null;
  readonly classifiedAuthorityTrack: AuthorityTrack | null;
  readonly classifiedStage: LifecycleStage | null;
  readonly classifiedSourceFamily: SourceFamily | null;
  readonly sourceDocumentId: string | null;
  readonly dedupKey: string;
}

export interface BridgeExpectedSourceRecord {
  readonly id: string;
  readonly adapterId: string;
  readonly label: string;
  readonly chamber: 'house' | 'senate' | 'joint' | null;
  readonly committee: string | null;
  readonly component: string | null;
}

export interface BridgeCycleRecord {
  readonly id: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
}

export interface LoadedBridgeObservation {
  readonly observation: BridgeObservationRecord;
  readonly expectedSource: BridgeExpectedSourceRecord;
  readonly cycle: BridgeCycleRecord;
}

/**
 * Read+guarded-write access the bridge needs. Deliberately narrow: it does
 * NOT widen the frozen Session 7 `LifecycleStore` (`budget-lifecycle/lifecycle-ports.ts`
 * in apps/defense-api) — that interface stays byte-for-byte untouched, same
 * precedent Session 8/10/11 followed for their own new ports.
 */
export interface ObservationBridgeStore {
  /** Loads the observation plus the identity it belongs to, or null if unknown. */
  loadForBridge(observationId: string): Promise<LoadedBridgeObservation | null>;

  /**
   * Loads the archive locator a prior bridge run persisted onto the named
   * SourceDocument. Required on the idempotent-replay path so a retry reads
   * bytes back from the immutable S3 archive instead of the observation's
   * live `discoveredUrl` — see `SourceDocumentArchiveReadPort`. Returns null
   * only if the SourceDocument row itself cannot be found, which contradicts
   * the observation's own `source_document_id` foreign key and is treated as
   * a schema-invariant violation by the caller.
   */
  loadSourceDocumentArchive(sourceDocumentId: string): Promise<StoredSourceDocumentArchiveRecord | null>;

  /**
   * Guarded, transactional write: persists `source_document_id` on the
   * observation and transitions `observation_state` to `'ingested'` — but
   * ONLY when every invariant holds:
   *   - the observation is still in a queueable-eligible state (not
   *     review_required/blocked/withdrawn — re-checked here, not just by the
   *     caller, so a concurrent watcher run cannot race the transition);
   *   - the observation's persisted `content_sha256` still equals
   *     `expectedContentSha256` (defends against a concurrent supersession
   *     changing the row between load and write);
   *   - the SourceDocument being attached carries the SAME sha256.
   *
   * Idempotent by design: if the observation is ALREADY `'ingested'` with
   * `source_document_id` equal to `sourceDocumentId`, this is a no-op success
   * (`alreadyApplied: true`) rather than an error — the at-least-once replay
   * case (crash after a prior successful transition, retried).
   *
   * This method's own success means exactly one thing: the immutable
   * SourceDocument is durably registered and bound to this observation. It
   * makes NO claim about parser handoff or canonical projection — those are
   * reported separately in `ObservationIngestionBridgeResult` and MUST NOT be
   * folded into "the observation is ingested" by any caller.
   */
  attachSourceDocumentAndMarkIngested(input: {
    observationId: string;
    expectedContentSha256: string;
    sourceDocumentId: string;
    sourceDocumentSha256: string;
  }): Promise<{ applied: boolean; alreadyApplied: boolean }>;
}

/** Bytes acquired from the observation's persisted official source locator. */
export interface FetchedObservationBytes {
  readonly bytes: Buffer;
  readonly contentSha256: string;
  readonly byteSize: number;
}

export interface ObservationByteFetchFailure {
  readonly blocked: true;
  readonly reason: string;
}

/**
 * Full-byte-buffer retrieval for an already-discovered, already-classified
 * observation's official URL. This is deliberately NOT the same contract as
 * the Session 7 `SourceFetchPort` (`https-source-fetch.adapter.ts`): that
 * adapter hashes bytes for change-detection and then discards them. The
 * bridge needs the durable bytes themselves so `RawArchiveService` can
 * archive the exact original.
 *
 * This port is used ONLY on the first-time (`changed` -> `ingested`) path,
 * before a SourceDocument exists. It must never be reached again once an
 * observation is `ingested` — see `SourceDocumentArchiveReadPort` below.
 */
export interface ObservationByteFetchPort {
  fetchFullBytes(input: { url: string }): Promise<FetchedObservationBytes | ObservationByteFetchFailure>;
}

/**
 * The immutable archive locator DocumentRegistrar recorded on the
 * SourceDocument when this observation was first bridged: the Object-Lock
 * raw-bucket bytes, not the observation's live `discoveredUrl`.
 */
export interface SourceDocumentArchiveLocator {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string | null;
}

export interface ArchivedSourceBytes {
  readonly bytes: Buffer;
  readonly contentSha256: string;
}

/**
 * Reads the exact archived bytes for an already-registered SourceDocument
 * back out of the immutable S3 raw-archive bucket.
 *
 * This is the ONLY byte source the bridge's replay path (an already-
 * `ingested` observation whose parser handoff needs to run again — crash
 * recovery, an outbox retry, or a deliberate re-parse) may use. Reusing
 * `observation.discoveredUrl` there would defeat the point of archiving in
 * the first place: a publisher can silently replace the bytes at that URL at
 * any time (the exact `SOURCE_BYTES_CHANGED` scenario this bridge already
 * guards against on first ingestion), and a replay that trusted the live URL
 * again would no longer be reading the bytes the lifecycle observation and
 * its SourceDocument actually certify. The archived object is immutable
 * (Object-Lock, content-addressed by sha256), so it is the only byte source
 * a replay can trust without re-verifying against a moving target.
 */
export interface SourceDocumentArchiveReadPort {
  readMaterializedBytes(locator: SourceDocumentArchiveLocator): Promise<ArchivedSourceBytes>;
}

/**
 * The archive locator persisted on a SourceDocument row — the fields
 * `attachSourceDocumentAndMarkIngested`'s caller must load back out of
 * storage before a replay can use `SourceDocumentArchiveReadPort` instead of
 * re-fetching the (potentially moved) live URL.
 */
export interface StoredSourceDocumentArchiveRecord {
  readonly sourceDocumentId: string;
  readonly sha256: string | null;
  readonly archiveBucket: string | null;
  readonly archiveS3Key: string | null;
  readonly archiveVersionId: string | null;
}

/** What the parser-handoff adapter needs to identify and route a registered document. */
export interface ParserHandoffInput {
  readonly cycleId: string;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  /** Absolute path to the archived original bytes on local disk (temp materialization). */
  readonly sourcePath: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly title: string;
  readonly sourceUrl: string;
}

/**
 * The terminal result of the EXISTING Phase 1-7 parser/verification pipeline
 * for one SourceDocument. This is proof that parsing and verification ran —
 * it is NOT proof that canonical Defense Budget data exists. See
 * `CanonicalProjectionPort` for the boundary that would make that claim, and
 * `PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING` for why the
 * bridge cannot cross it today.
 */
export interface ParserHandoffResult {
  readonly invoked: true;
  readonly decision: string;
  readonly finalState: string;
  readonly artifactLocator: string;
}

/**
 * Small adapter boundary around the EXISTING Phase 1-7 parser/verification
 * pipeline (`ParserRouterV1Service` + its production verification context),
 * so the bridge never re-implements parsing/verification itself. See
 * `parser-router/source-document-parser-handoff.ts` for the real
 * implementation, shared with `scripts/extract-defense-budget-cycle.ts`.
 */
export interface ParserHandoffPort {
  handoff(input: ParserHandoffInput): Promise<ParserHandoffResult>;
}

/** What a canonical-projection boundary would need to project one verified artifact. */
export interface CanonicalProjectionInput {
  readonly observationId: string;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  readonly cycleId: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly parserHandoff: ParserHandoffResult;
}

export interface CanonicalProjectionOutcome {
  readonly succeeded: boolean;
  readonly reason: string;
}

/**
 * The boundary a future canonical-projection step would occupy: verified
 * `ParserHandoffResult` in, a durable canonical Defense Budget write (or a
 * refusal) out.
 *
 * Phase 10B-1 repair traced this boundary starting from
 * `ParserRouterV1Service`'s terminal result and found no legitimate
 * per-observation production path to it —
 * `DefenseBudgetCanonicalPromotionServiceV1.execute` operates on an entire
 * certified cycle/family plan, requires a separately issued human
 * authorization bound to that plan's hash, and runs under a distinct
 * `PROMOTER_DATABASE_URL` role the serving API does not hold. There is
 * structurally no way for a single-observation bridge to reach it.
 *
 * `CanonicalProjectionPort` exists so that gap is a real, injectable seam
 * rather than a silent omission: `Phase10B1CanonicalProjectionBoundaryMissingAdapter`
 * is the only implementation wired today, and it deterministically refuses
 * every call with `PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING`.
 * A future implementation of this exact interface — once the per-observation
 * (or per-completed-cycle) canonical write boundary is designed — is what the
 * bridge would call instead, unchanged everywhere else.
 */
export interface CanonicalProjectionPort {
  project(input: CanonicalProjectionInput): Promise<CanonicalProjectionOutcome>;
}
