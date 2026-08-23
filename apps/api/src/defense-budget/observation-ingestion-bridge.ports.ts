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
 */
export interface ObservationByteFetchPort {
  fetchFullBytes(input: { url: string }): Promise<FetchedObservationBytes | ObservationByteFetchFailure>;
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
