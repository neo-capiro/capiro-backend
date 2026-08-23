/**
 * Phase 10B-1 — governed observation-to-SourceDocument ingestion bridge.
 *
 * Implements exactly the flow the Phase 10B outbox-drain audit (prior
 * session) identified as the missing architecture:
 *
 *   observation_id
 *     -> load observation + expected source + lifecycle cycle
 *     -> verify observation is eligible for governed ingestion
 *     -> acquire official bytes from the observation's persisted source locator
 *        (first-time path) OR from the immutable S3 archive (replay path —
 *        see the Phase 10B-1 repair notes below)
 *     -> compute SHA-256
 *     -> require SHA == observation.content_sha256
 *     -> archive exact bytes through the EXISTING RawArchiveService
 *     -> register/upsert SourceDocument through the EXISTING DocumentRegistrar
 *     -> persist source_document_id back to the lifecycle observation
 *     -> invoke the existing parser / verification / projection entrypoint
 *     -> invoke the canonical-projection boundary (currently a deterministic
 *        refusal — see PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING)
 *
 * This service does NOT drain the outbox — it is the real downstream
 * operation a future outbox-drain worker will invoke per row. It also does
 * NOT re-implement RawArchiveService, DocumentRegistrar, or the parser
 * router: all three are reused unmodified.
 *
 * ── Phase 10B-1 repair: failure semantics ──────────────────────────────────
 * `bridge()`'s `status` is now split into two independent axes that a future
 * outbox-drain worker MUST read separately:
 *
 *   1. Was the immutable SourceDocument durably registered and bound to this
 *      observation? (`sourceDocumentBound`)
 *   2. Did EVERY required downstream operation succeed —parser handoff AND
 *      canonical projection? (`downstreamSucceeded`)
 *
 * A row may only be marked "succeeded" by an outbox consumer when
 * `downstreamSucceeded` is `true`. `sourceDocumentBound: true` with
 * `downstreamSucceeded: false` is a RETRYABLE failure: the SourceDocument
 * exists (so a retry must not re-fetch/re-archive/re-register — see the
 * replay path below), but the row is not done and must be retried until
 * downstream succeeds or a human intervenes.
 *
 * ── Phase 10B-1 repair: replay reads archived bytes, never the live URL ────
 * Once `DocumentRegistrar` has succeeded, the SourceDocument carries
 * `archiveBucket`/`archiveS3Key`/`archiveVersionId` — the durable, immutable
 * byte identity. Every replay (idempotent re-invocation of an already-
 * `ingested` observation, or a retry after a downstream failure) reads
 * bytes back from that archive through `SourceDocumentArchiveReadPort`,
 * never by re-fetching `observation.discoveredUrl`. The live URL is used
 * EXACTLY ONCE, on the first transition from `changed` to `ingested` —
 * after that, the archive is the only trusted byte source, so a publisher
 * silently changing the bytes at that URL later can never affect a replay.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

import { evaluateBridgeEligibility, SOURCE_BYTES_CHANGED } from '@capiro/defense-domain';

import { DocumentRegistrar } from './document-registrar.js';
import { routingForSourceFamily } from './parser-router/source-family-routing.js';
import type {
  ObservationBridgeStore,
  ObservationByteFetchPort,
  CanonicalProjectionPort,
  ParserHandoffPort,
  SourceDocumentArchiveReadPort,
} from './observation-ingestion-bridge.ports.js';

export type ObservationIngestionBridgeStatus =
  | 'ingested'
  | 'already_ingested'
  | 'source_bytes_changed'
  | 'downstream_failed'
  | 'blocked'
  | 'rejected';

export interface ObservationIngestionBridgeResult {
  readonly status: ObservationIngestionBridgeStatus;
  readonly observationId: string;
  readonly sourceDocumentId: string | null;
  readonly reason: string | null;
  /**
   * True once the immutable SourceDocument is durably registered and bound
   * to this observation — independent of whether downstream parsing/
   * projection succeeded. An outbox consumer that only cares about avoiding
   * duplicate archives/registrations on retry should read this, not
   * `status`.
   */
  readonly sourceDocumentBound: boolean;
  /**
   * True ONLY when every required downstream operation (parser handoff AND
   * canonical projection) succeeded. An outbox consumer MUST require this
   * to be `true` before marking a row succeeded — `sourceDocumentBound &&
   * !downstreamSucceeded` is a retryable failure, never a success.
   */
  readonly downstreamSucceeded: boolean;
  readonly parserHandoffInvoked: boolean;
  readonly parserHandoffError: string | null;
  readonly canonicalProjectionSucceeded: boolean;
  readonly canonicalProjectionError: string | null;
}

@Injectable()
export class ObservationIngestionBridgeService {
  private readonly logger = new Logger(ObservationIngestionBridgeService.name);

  constructor(
    private readonly store: ObservationBridgeStore,
    private readonly fetcher: ObservationByteFetchPort,
    private readonly registrar: DocumentRegistrar,
    private readonly parserHandoff: ParserHandoffPort,
    private readonly archiveReader: SourceDocumentArchiveReadPort,
    private readonly canonicalProjection: CanonicalProjectionPort,
  ) {}

  async bridge(observationId: string): Promise<ObservationIngestionBridgeResult> {
    const loaded = await this.store.loadForBridge(observationId);
    if (!loaded) {
      return this.result('rejected', observationId, null, `observation ${observationId} not found`, {
        sourceDocumentBound: false,
      });
    }
    const { observation, expectedSource, cycle } = loaded;

    const eligibility = evaluateBridgeEligibility(observation.observationState);

    if (eligibility.kind === 'ineligible') {
      return this.result('rejected', observationId, observation.sourceDocumentId, eligibility.reason, {
        sourceDocumentBound: observation.sourceDocumentId != null,
      });
    }

    // Idempotent replay: this observation was already bridged by a prior run
    // (crash after registration but before/around downstream parsing, a
    // downstream failure being retried, or a genuinely repeated at-least-once
    // invocation). The observation_state 'ingested' CHECK constraint
    // guarantees source_document_id is set. Bytes for this path are read
    // from the immutable archive, never re-fetched from discoveredUrl.
    if (eligibility.kind === 'idempotent_replay') {
      if (!observation.sourceDocumentId) {
        // Contradicts the DB CHECK constraint; fail loudly rather than guess.
        return this.result(
          'rejected',
          observationId,
          null,
          `observation ${observationId} is 'ingested' but carries no source_document_id (schema invariant violated)`,
          { sourceDocumentBound: false },
        );
      }

      const materialized = await this.materializeArchivedBytes({
        sourceDocumentId: observation.sourceDocumentId,
        expectedSha256: observation.contentSha256,
      });
      if ('error' in materialized) {
        return this.result(
          'downstream_failed',
          observationId,
          observation.sourceDocumentId,
          materialized.error,
          { sourceDocumentBound: true },
        );
      }

      try {
        const downstream = await this.runDownstream({
          cycle,
          observation,
          sourceDocumentId: observation.sourceDocumentId,
          sourceSha256: observation.contentSha256,
          localPath: materialized.localPath,
        });
        return this.result(
          downstream.succeeded ? 'already_ingested' : 'downstream_failed',
          observationId,
          observation.sourceDocumentId,
          downstream.succeeded
            ? 'observation already ingested; downstream re-invoked idempotently'
            : downstream.reason,
          { sourceDocumentBound: true, downstream },
        );
      } finally {
        materialized.dispose();
      }
    }

    // eligible: fetch, verify, archive, register, persist, hand off. The
    // live URL is used HERE ONLY — every later replay of this observation
    // reads the immutable archive instead (see materializeArchivedBytes).
    const fetched = await this.fetcher.fetchFullBytes({ url: observation.discoveredUrl });
    if ('blocked' in fetched) {
      return this.result('blocked', observationId, observation.sourceDocumentId, fetched.reason, {
        sourceDocumentBound: false,
      });
    }

    // ── Critical SHA rule ────────────────────────────────────────────────
    // The lifecycle observation represents a specific immutable byte
    // identity. Bytes that no longer match are NEVER ingested under the old
    // observation, NEVER overwrite the persisted SHA, and are NEVER silently
    // accepted. The observation/outbox job is left exactly as it was; the
    // lifecycle watcher/discovery system — not this bridge — is responsible
    // for creating the new observation for changed bytes.
    if (fetched.contentSha256 !== observation.contentSha256) {
      this.logger.warn(
        `${SOURCE_BYTES_CHANGED}: observation ${observationId} persisted sha=${observation.contentSha256} ` +
          `but ${observation.discoveredUrl} now returns sha=${fetched.contentSha256}`,
      );
      return this.result(
        'source_bytes_changed',
        observationId,
        observation.sourceDocumentId,
        SOURCE_BYTES_CHANGED,
        { sourceDocumentBound: false },
      );
    }

    const routing = observation.classifiedSourceFamily
      ? routingForSourceFamily(observation.classifiedSourceFamily)
      : null;
    if (!routing || !observation.classifiedFiscalYear || !observation.classifiedAuthorityTrack || !observation.classifiedStage) {
      // A 'changed' observation is only ever recorded WITH a resolved
      // classification (the watcher's ambiguous path stops at
      // 'review_required', never 'changed') — this branch defends against a
      // schema/invariant regression rather than a case expected in practice.
      return this.result(
        'rejected',
        observationId,
        observation.sourceDocumentId,
        `observation ${observationId} is 'changed' but carries an unresolved classification`,
        { sourceDocumentBound: false },
      );
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'phase10b1-obs-bridge-'));
    try {
      const localPath = join(tempDir, `${randomUUID()}.bin`);
      writeFileSync(localPath, fetched.bytes);

      // documentId is derived from the OBSERVATION's own dedup key (a stable
      // sha256 hex over expectedSourceDedupKey + contentSha256), not a random
      // id — so replaying the same observation resolves to the SAME sourceKey
      // and therefore the SAME logical SourceDocument, never a second
      // immutable copy for identical bytes.
      const sourceKey = `defense-budget-observation-${observation.dedupKey}`;

      const registered = await this.registrar.register({
        sourceKey,
        fiscalYear: observation.classifiedFiscalYear,
        budgetCycle: routing.budgetCycle,
        component: expectedSource.component,
        documentType: routing.documentType,
        title: expectedSource.label,
        sourceUrl: observation.discoveredUrl,
        archive: {
          documentId: sourceKey,
          fiscalYear: observation.classifiedFiscalYear,
          sourceAuthority: routing.authority,
          family: routing.family,
          localPath,
          retrievalAliases: [observation.discoveredUrl],
          manifest: {
            observationId: observation.id,
            expectedSourceId: expectedSource.id,
            cycleId: cycle.id,
            authorityTrack: observation.classifiedAuthorityTrack,
            stage: observation.classifiedStage,
            sourceFamily: observation.classifiedSourceFamily,
            adapterId: observation.adapterId,
          },
        },
      });

      // Never attach a SourceDocument whose SHA does not match the
      // observation SHA — re-verified here even though DocumentRegistrar's
      // own archive step recomputed the same sha256 from the same bytes.
      const documentSha256 = registered.registry.document.sha256;
      if (!documentSha256 || documentSha256 !== observation.contentSha256) {
        throw new Error(
          `registered SourceDocument sha256 (${documentSha256}) does not match observation ` +
            `content_sha256 (${observation.contentSha256}); refusing to attach`,
        );
      }

      const attach = await this.store.attachSourceDocumentAndMarkIngested({
        observationId: observation.id,
        expectedContentSha256: observation.contentSha256,
        sourceDocumentId: registered.registry.document.id,
        sourceDocumentSha256: documentSha256,
      });

      // From here on the SourceDocument is durably bound to this
      // observation. Everything below is downstream work whose failure must
      // be reported as retryable, never folded into overall bridge success.
      const downstream = await this.runDownstream({
        cycle,
        observation,
        sourceDocumentId: registered.registry.document.id,
        sourceSha256: documentSha256,
        localPath,
      });

      return this.result(
        downstream.succeeded ? 'ingested' : 'downstream_failed',
        observationId,
        registered.registry.document.id,
        downstream.succeeded
          ? attach.alreadyApplied
            ? 'source_document already attached by a prior replay; observation transition was a no-op'
            : null
          : downstream.reason,
        { sourceDocumentBound: true, downstream },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Reads a prior bridge run's archived bytes back out of immutable S3
   * storage and materializes them to a local temp path, re-verifying SHA
   * before returning. This is the ONLY byte source for every replay path —
   * `observation.discoveredUrl` is never consulted again once a
   * SourceDocument has been registered.
   */
  private async materializeArchivedBytes(input: {
    sourceDocumentId: string;
    expectedSha256: string;
  }): Promise<{ localPath: string; dispose: () => void } | { error: string }> {
    const record = await this.store.loadSourceDocumentArchive(input.sourceDocumentId);
    if (!record) {
      return {
        error: `SourceDocument ${input.sourceDocumentId} not found while materializing archived bytes ` +
          '(schema invariant violated: observation.source_document_id names a row that does not exist)',
      };
    }
    if (!record.archiveBucket || !record.archiveS3Key) {
      return {
        error: `SourceDocument ${input.sourceDocumentId} carries no archive locator; refusing to trust ` +
          'observation.discoveredUrl as a substitute for the immutable archive on a replay',
      };
    }

    let archived: { bytes: Buffer; contentSha256: string };
    try {
      archived = await this.archiveReader.readMaterializedBytes({
        bucket: record.archiveBucket,
        key: record.archiveS3Key,
        versionId: record.archiveVersionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `failed to read archived bytes for SourceDocument ${input.sourceDocumentId}: ${message}` };
    }

    // Keep the existing SHA rule on the replay path too: never hand archived
    // bytes to the parser unless they match the lifecycle observation SHA.
    if (archived.contentSha256 !== input.expectedSha256) {
      return {
        error:
          `archived bytes for SourceDocument ${input.sourceDocumentId} hash to ${archived.contentSha256}, ` +
          `not the observation's content_sha256 (${input.expectedSha256}); refusing to parse — this ` +
          'indicates archive corruption or a bug, not a normal SOURCE_BYTES_CHANGED case (the archive ' +
          'is immutable and was already SHA-verified at registration time)',
      };
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'phase10b1-obs-bridge-replay-'));
    const localPath = join(tempDir, `${randomUUID()}.bin`);
    writeFileSync(localPath, archived.bytes);
    return { localPath, dispose: () => rmSync(tempDir, { recursive: true, force: true }) };
  }

  /**
   * Runs both required downstream steps — parser handoff, then canonical
   * projection — and reports a single succeeded/failed outcome. Either step
   * failing means `succeeded: false`; only both succeeding is a downstream
   * success. Canonical projection is currently a deterministic refusal (see
   * `Phase10B1CanonicalProjectionBoundaryMissingAdapter`), so today this
   * ALWAYS returns `succeeded: false` on the eligible/first-time path —
   * exactly the intended fail-closed behavior for the missing boundary.
   */
  private async runDownstream(input: {
    cycle: { id: string };
    observation: {
      classifiedFiscalYear: number | null;
      classifiedAuthorityTrack: import('@capiro/defense-domain').AuthorityTrack | null;
      classifiedStage: import('@capiro/defense-domain').LifecycleStage | null;
      classifiedSourceFamily: import('@capiro/defense-domain').SourceFamily | null;
      discoveredUrl: string;
      id: string;
    };
    sourceDocumentId: string;
    sourceSha256: string;
    localPath: string;
  }): Promise<{
    succeeded: boolean;
    reason: string | null;
    parserHandoffInvoked: boolean;
    parserHandoffError: string | null;
    canonicalProjectionSucceeded: boolean;
    canonicalProjectionError: string | null;
  }> {
    const { observation } = input;
    if (
      !observation.classifiedFiscalYear ||
      !observation.classifiedAuthorityTrack ||
      !observation.classifiedStage ||
      !observation.classifiedSourceFamily
    ) {
      return {
        succeeded: false,
        reason: 'observation classification unavailable for downstream handoff',
        parserHandoffInvoked: false,
        parserHandoffError: 'observation classification unavailable for parser handoff',
        canonicalProjectionSucceeded: false,
        canonicalProjectionError: 'parser handoff did not run; canonical projection not attempted',
      };
    }
    const routing = routingForSourceFamily(observation.classifiedSourceFamily);

    let parserHandoffResult: Awaited<ReturnType<ParserHandoffPort['handoff']>> | null = null;
    let parserHandoffError: string | null = null;
    try {
      parserHandoffResult = await this.parserHandoff.handoff({
        cycleId: input.cycle.id,
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        sourcePath: input.localPath,
        fiscalYear: observation.classifiedFiscalYear,
        authorityTrack: observation.classifiedAuthorityTrack,
        stage: observation.classifiedStage,
        sourceFamily: observation.classifiedSourceFamily,
        title: routing.documentType,
        sourceUrl: observation.discoveredUrl,
      });
    } catch (error) {
      parserHandoffError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`parser handoff failed for ${input.sourceDocumentId}: ${parserHandoffError}`);
    }

    if (!parserHandoffResult) {
      return {
        succeeded: false,
        reason: `parser handoff failed: ${parserHandoffError}`,
        parserHandoffInvoked: false,
        parserHandoffError,
        canonicalProjectionSucceeded: false,
        canonicalProjectionError: 'parser handoff failed; canonical projection not attempted',
      };
    }

    const projection = await this.canonicalProjection.project({
      observationId: observation.id,
      sourceDocumentId: input.sourceDocumentId,
      sourceSha256: input.sourceSha256,
      cycleId: input.cycle.id,
      fiscalYear: observation.classifiedFiscalYear,
      authorityTrack: observation.classifiedAuthorityTrack,
      stage: observation.classifiedStage,
      sourceFamily: observation.classifiedSourceFamily,
      parserHandoff: parserHandoffResult,
    });

    return {
      succeeded: projection.succeeded,
      reason: projection.succeeded ? null : projection.reason,
      parserHandoffInvoked: true,
      parserHandoffError: null,
      canonicalProjectionSucceeded: projection.succeeded,
      canonicalProjectionError: projection.succeeded ? null : projection.reason,
    };
  }

  private result(
    status: ObservationIngestionBridgeStatus,
    observationId: string,
    sourceDocumentId: string | null,
    reason: string | null,
    input: {
      sourceDocumentBound: boolean;
      downstream?: {
        succeeded: boolean;
        parserHandoffInvoked: boolean;
        parserHandoffError: string | null;
        canonicalProjectionSucceeded: boolean;
        canonicalProjectionError: string | null;
      };
    },
  ): ObservationIngestionBridgeResult {
    return {
      status,
      observationId,
      sourceDocumentId,
      reason,
      sourceDocumentBound: input.sourceDocumentBound,
      downstreamSucceeded: input.downstream?.succeeded ?? false,
      parserHandoffInvoked: input.downstream?.parserHandoffInvoked ?? false,
      parserHandoffError: input.downstream?.parserHandoffError ?? null,
      canonicalProjectionSucceeded: input.downstream?.canonicalProjectionSucceeded ?? false,
      canonicalProjectionError: input.downstream?.canonicalProjectionError ?? null,
    };
  }
}
