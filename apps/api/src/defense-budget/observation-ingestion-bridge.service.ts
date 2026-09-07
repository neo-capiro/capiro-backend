/**
 * Phase 10B-1 — governed observation-to-SourceDocument ingestion bridge.
 *
 * Owns exactly:
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
 *     -> invoke the existing parser / verification pipeline, which durably
 *        persists its terminal decision and evidence (see ParserHandoffPort)
 *     -> SOURCE INGESTION COMPLETE
 *
 * This service does NOT drain the outbox — it is the real downstream
 * operation a future outbox-drain worker will invoke per row. It also does
 * NOT re-implement RawArchiveService, DocumentRegistrar, or the parser
 * router: all three are reused unmodified.
 *
 * ── Scope boundary: canonical promotion is OUT OF SCOPE for this bridge ───
 * This service's success (`ingestionSucceeded: true`) means exactly:
 *
 *   sourceDocumentBound && parserVerificationSucceeded && durableEvidencePersisted
 *
 * i.e. the immutable SourceDocument is durably bound to the observation, the
 * existing Phase 1-7 parser/verification pipeline resolved a PASS decision,
 * and that decision + its evidence were durably persisted (never merely
 * written to the ephemeral container's local filesystem). It makes NO claim
 * about canonical Defense Budget data existing. Reconciling/certifying a
 * whole cycle/family's corpus and driving
 * `DefenseBudgetCanonicalPromotionServiceV1.execute` — which requires a
 * whole-cycle promotion plan, a separately issued human authorization bound
 * to that plan's hash, and the `PROMOTER_DATABASE_URL` role the serving API
 * does not hold — is Phase 10B-2 work. This bridge does not call it,
 * reference it, or gate ordinary per-observation ingestion success on it.
 * See `PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING` in
 * `@capiro/defense-domain` for the traced reasons that boundary is
 * structurally unreachable from a single observation — that constant now
 * documents a Phase 10B-2 gap and is deliberately NOT referenced by this
 * service.
 *
 * ── Failure semantics ──────────────────────────────────────────────────────
 * `bridge()`'s result carries four independent facts a future outbox-drain
 * worker MUST read separately (never collapse to a single boolean):
 *
 *   1. `sourceDocumentBound` — is the immutable SourceDocument durably
 *      registered and bound to this observation?
 *   2. `parserVerificationSucceeded` — did the existing Phase 1-7 pipeline
 *      resolve a PASS decision? (`false` for REVIEW, REJECT, or an
 *      unresolved/transient outcome — never conflate any of those with PASS.)
 *   3. `durableEvidencePersisted` — was that decision (whatever it was)
 *      durably persisted, as opposed to existing only in the ephemeral
 *      container's local filesystem?
 *   4. `ingestionSucceeded` — all three of the above. Only this may be read
 *      by an outbox consumer as "mark this row done."
 *
 * A REVIEW or REJECT decision is a resolved, durably-persisted, AUDITABLE
 * terminal disposition — never retried forever, and never silently reported
 * as ingestion success. Only a genuine transient/infrastructure failure
 * (network, process crash, unreachable database, missing persistence
 * configuration) is retryable; see `status: 'downstream_failed'`.
 *
 * ── Replay reads archived bytes, never the live URL ────────────────────────
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
  ParserHandoffPort,
  SourceDocumentArchiveReadPort,
  VerifierDecision,
} from './observation-ingestion-bridge.ports.js';

export type ObservationIngestionBridgeStatus =
  | 'ingested'
  | 'already_ingested'
  | 'source_bytes_changed'
  | 'downstream_failed'
  | 'review_required'
  | 'verification_rejected'
  | 'blocked'
  | 'rejected';

export interface ObservationIngestionBridgeResult {
  readonly status: ObservationIngestionBridgeStatus;
  readonly observationId: string;
  readonly sourceDocumentId: string | null;
  readonly reason: string | null;
  /**
   * True once the immutable SourceDocument is durably registered and bound
   * to this observation — independent of whether parsing/verification
   * succeeded. An outbox consumer that only cares about avoiding duplicate
   * archives/registrations on retry should read this, not `status`.
   */
  readonly sourceDocumentBound: boolean;
  /**
   * True ONLY when the existing Phase 1-7 parser/verification pipeline
   * resolved a `PASS` decision. `false` for `REVIEW`, `REJECT`, an
   * unresolved terminal decision, or any transient failure — never
   * conflate any of those with success.
   */
  readonly parserVerificationSucceeded: boolean;
  /**
   * True ONLY when the parser/verification decision (whatever it was) was
   * durably persisted — Prisma `DocumentParseJob` + verification
   * candidate/run/checks rows, never filesystem-only output in the
   * ephemeral ingestion worker's container.
   */
  readonly durableEvidencePersisted: boolean;
  /**
   * `sourceDocumentBound && parserVerificationSucceeded && durableEvidencePersisted`.
   * The ONLY field an outbox consumer may use to mark a row succeeded.
   * Canonical promotion is never part of this computation — see the file
   * header's scope-boundary note.
   */
  readonly ingestionSucceeded: boolean;
  readonly parserHandoffInvoked: boolean;
  readonly parserHandoffError: string | null;
  /** The Phase 2 verifier's terminal decision, or null if handoff never resolved one. */
  readonly verifierDecision: VerifierDecision | null;
}

interface DownstreamOutcome {
  readonly parserHandoffInvoked: boolean;
  readonly parserHandoffError: string | null;
  readonly verifierDecision: VerifierDecision | null;
  readonly parserVerificationSucceeded: boolean;
  readonly durableEvidencePersisted: boolean;
  readonly reason: string | null;
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
  ) {}

  async bridge(observationId: string): Promise<ObservationIngestionBridgeResult> {
    const loaded = await this.store.loadForBridge(observationId);
    if (!loaded) {
      return this.result('rejected', observationId, null, `observation ${observationId} not found`, {
        sourceDocumentBound: false,
      });
    }
    const { observation, expectedSource, cycle } = loaded;

    // Phase 10B-31: the SAME deterministic sourceKey this (or a prior) run
    // registers the SourceDocument under -- a pure function of the
    // observation's own immutable dedupKey, available and identical whether
    // this is the first-time or the idempotent-replay path, so it is
    // computed once here rather than re-derived differently per branch. See
    // the first-time path below for why this can never diverge from what
    // DocumentRegistrar actually persists.
    const sourceKey = `defense-budget-observation-${observation.dedupKey}`;

    const eligibility = evaluateBridgeEligibility(observation.observationState);

    if (eligibility.kind === 'ineligible') {
      return this.result('rejected', observationId, observation.sourceDocumentId, eligibility.reason, {
        sourceDocumentBound: observation.sourceDocumentId != null,
      });
    }

    // Idempotent replay: this observation was already bridged by a prior run
    // (crash after registration but before/around downstream parsing, a
    // downstream failure being retried, or a genuinely repeated at-least-
    // once invocation). The observation_state 'ingested' CHECK constraint
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
          sourceKey,
          component: materialized.component,
        });
        return this.result(
          this.deriveStatus(downstream, { isReplay: true }),
          observationId,
          observation.sourceDocumentId,
          downstream.reason,
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

      // `sourceKey` (computed once, above, from the OBSERVATION's own
      // immutable dedup key) is derived the same way on every invocation —
      // so replaying the same observation resolves to the SAME sourceKey and
      // therefore the SAME logical SourceDocument, never a second immutable
      // copy for identical bytes.
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
      // be reported as retryable (or a governed terminal disposition), never
      // silently folded into overall bridge success.
      //
      // Phase 10B-31: component is read back from the row DocumentRegistrar
      // just persisted (`registered.registry.document.component`), not
      // re-derived from `expectedSource.component` a second time — the two
      // are equal on every code path that actually writes a new row (the
      // registrar passes `expectedSource.component` straight through), but
      // reading the persisted value directly is strictly the authoritative
      // source DocumentRegistrar's own idempotent upsert can return (the
      // pre-existing-row short-circuit), and needs no separate proof of
      // agreement.
      const downstream = await this.runDownstream({
        cycle,
        observation,
        sourceDocumentId: registered.registry.document.id,
        sourceSha256: documentSha256,
        localPath,
        sourceKey,
        component: (registered.registry.document.component as string | null | undefined) ?? null,
      });

      const reason =
        downstream.parserVerificationSucceeded && attach.alreadyApplied
          ? 'source_document already attached by a prior replay; observation transition was a no-op'
          : downstream.reason;

      return this.result(
        this.deriveStatus(downstream, { isReplay: false }),
        observationId,
        registered.registry.document.id,
        reason,
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
  }): Promise<
    | { localPath: string; component: string | null; dispose: () => void }
    | { error: string }
  > {
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
    return {
      localPath,
      // Phase 10B-31: the authoritative, persisted component from the SAME
      // SourceDocument row `record` was just loaded from -- read back here
      // (rather than re-derived from `expectedSource`) so a replay hands the
      // parser the real value that is actually on the row, never a value
      // that could have drifted since first registration.
      component: record.component,
      dispose: () => rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  /**
   * Runs the sole required downstream step — parser/verification handoff —
   * and separates a genuine transient/infrastructure failure (the handoff
   * call throws: network, process crash, unreachable database, missing
   * persistence configuration) from a resolved, durably-persisted terminal
   * decision (PASS, REVIEW, or REJECT — the handoff call resolves).
   *
   * Canonical projection is NEVER invoked here — see the file header's scope
   * boundary. `parserVerificationSucceeded` is `true` only for a `PASS`
   * decision; `REVIEW` and `REJECT` are legitimate, durably-persisted,
   * auditable terminal dispositions that must not be retried forever and
   * must never be reported as success.
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
    /** Phase 10B-31: the authoritative sourceKey/component this SourceDocument
     * carries, forwarded unchanged into the parser handoff so production-proof
     * verification's metadata-agreement check compares against the real,
     * persisted values instead of an absent field or a locally re-derived one. */
    sourceKey: string;
    component: string | null;
  }): Promise<DownstreamOutcome> {
    const { observation } = input;
    if (
      !observation.classifiedFiscalYear ||
      !observation.classifiedAuthorityTrack ||
      !observation.classifiedStage ||
      !observation.classifiedSourceFamily
    ) {
      return {
        parserHandoffInvoked: false,
        parserHandoffError: 'observation classification unavailable for parser handoff',
        verifierDecision: null,
        parserVerificationSucceeded: false,
        durableEvidencePersisted: false,
        reason: 'observation classification unavailable for downstream handoff',
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
        // Phase 10B-31: propagate the authoritative, persisted identity/
        // component through unchanged (see the widened `runDownstream` input
        // above) instead of leaving them unset for the manifest builder to
        // silently default away.
        sourceKey: input.sourceKey,
        component: input.component,
      });
    } catch (error) {
      parserHandoffError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`parser handoff failed for ${input.sourceDocumentId}: ${parserHandoffError}`);
    }

    if (!parserHandoffResult) {
      // The handoff call THREW: a transient/infrastructure failure (parser
      // runtime crash, unreachable database, missing
      // BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT, etc.) — never a resolved
      // verification decision. Always retryable; no evidence was durably
      // persisted for this attempt.
      return {
        parserHandoffInvoked: false,
        parserHandoffError,
        verifierDecision: null,
        parserVerificationSucceeded: false,
        durableEvidencePersisted: false,
        reason: `parser handoff failed: ${parserHandoffError}`,
      };
    }

    const decision = parserHandoffResult.decision;
    if (decision === 'UNKNOWN') {
      // Defensive-only corner: the router returned without ever resolving a
      // verifier decision (e.g. a misconfigured maxEscalationRounds=0). No
      // persistCompletedVerification call happened for this attempt, so no
      // evidence was durably persisted — treat exactly like a transient
      // failure, never as a governed REVIEW/REJECT disposition.
      return {
        parserHandoffInvoked: true,
        parserHandoffError: null,
        verifierDecision: 'UNKNOWN',
        parserVerificationSucceeded: false,
        durableEvidencePersisted: false,
        reason:
          `parser/verification pipeline returned without resolving a terminal decision ` +
          `(finalState: ${parserHandoffResult.finalState}); treating as retryable, not a governed disposition`,
      };
    }

    // Resolving without throwing means the decision — whatever it is — was
    // durably persisted: DefaultParserHandoffAdapter always drives the
    // pipeline with persistVerificationAudit: true, and
    // BudgetVerificationV1Service.verify() persists the candidate/run/checks
    // rows unconditionally in 'persist_audit' mode regardless of decision.
    const durableEvidencePersisted = true;
    const parserVerificationSucceeded = decision === 'PASS';
    const reason =
      decision === 'PASS'
        ? null
        : decision === 'REVIEW'
          ? `verification requires human review (artifact: ${parserHandoffResult.artifactLocator})`
          : `verification deterministically rejected (artifact: ${parserHandoffResult.artifactLocator})`;

    return {
      parserHandoffInvoked: true,
      parserHandoffError: null,
      verifierDecision: decision,
      parserVerificationSucceeded,
      durableEvidencePersisted,
      reason,
    };
  }

  /** Maps a downstream outcome to the outbox-facing status enum. */
  private deriveStatus(
    downstream: DownstreamOutcome,
    context: { isReplay: boolean },
  ): ObservationIngestionBridgeStatus {
    if (!downstream.parserHandoffInvoked) return 'downstream_failed';
    switch (downstream.verifierDecision) {
      case 'PASS':
        return context.isReplay ? 'already_ingested' : 'ingested';
      case 'REVIEW':
        return 'review_required';
      case 'REJECT':
        return 'verification_rejected';
      default:
        // 'UNKNOWN' or any unexpected value: treat as retryable, never as a
        // governed terminal disposition.
        return 'downstream_failed';
    }
  }

  private result(
    status: ObservationIngestionBridgeStatus,
    observationId: string,
    sourceDocumentId: string | null,
    reason: string | null,
    input: {
      sourceDocumentBound: boolean;
      downstream?: DownstreamOutcome;
    },
  ): ObservationIngestionBridgeResult {
    const downstream = input.downstream;
    const parserVerificationSucceeded = downstream?.parserVerificationSucceeded ?? false;
    const durableEvidencePersisted = downstream?.durableEvidencePersisted ?? false;
    return {
      status,
      observationId,
      sourceDocumentId,
      reason,
      sourceDocumentBound: input.sourceDocumentBound,
      parserVerificationSucceeded,
      durableEvidencePersisted,
      ingestionSucceeded: input.sourceDocumentBound && parserVerificationSucceeded && durableEvidencePersisted,
      parserHandoffInvoked: downstream?.parserHandoffInvoked ?? false,
      parserHandoffError: downstream?.parserHandoffError ?? null,
      verifierDecision: downstream?.verifierDecision ?? null,
    };
  }
}
