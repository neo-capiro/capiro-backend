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
 *     -> compute SHA-256
 *     -> require SHA == observation.content_sha256
 *     -> archive exact bytes through the EXISTING RawArchiveService
 *     -> register/upsert SourceDocument through the EXISTING DocumentRegistrar
 *     -> persist source_document_id back to the lifecycle observation
 *     -> invoke the existing parser / verification / projection entrypoint
 *
 * This service does NOT drain the outbox — it is the real downstream
 * operation a future outbox-drain worker will invoke per row. It also does
 * NOT re-implement RawArchiveService, DocumentRegistrar, or the parser
 * router: all three are reused unmodified.
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
} from './observation-ingestion-bridge.ports.js';

export type ObservationIngestionBridgeStatus =
  | 'ingested'
  | 'already_ingested'
  | 'source_bytes_changed'
  | 'blocked'
  | 'rejected';

export interface ObservationIngestionBridgeResult {
  readonly status: ObservationIngestionBridgeStatus;
  readonly observationId: string;
  readonly sourceDocumentId: string | null;
  readonly reason: string | null;
  readonly parserHandoffInvoked: boolean;
  readonly parserHandoffError: string | null;
}

@Injectable()
export class ObservationIngestionBridgeService {
  private readonly logger = new Logger(ObservationIngestionBridgeService.name);

  constructor(
    private readonly store: ObservationBridgeStore,
    private readonly fetcher: ObservationByteFetchPort,
    private readonly registrar: DocumentRegistrar,
    private readonly parserHandoff: ParserHandoffPort,
  ) {}

  async bridge(observationId: string): Promise<ObservationIngestionBridgeResult> {
    const loaded = await this.store.loadForBridge(observationId);
    if (!loaded) {
      return this.result('rejected', observationId, null, `observation ${observationId} not found`);
    }
    const { observation, expectedSource, cycle } = loaded;

    const eligibility = evaluateBridgeEligibility(observation.observationState);

    if (eligibility.kind === 'ineligible') {
      return this.result('rejected', observationId, observation.sourceDocumentId, eligibility.reason);
    }

    // Idempotent replay: this observation was already bridged by a prior run
    // (crash after registration but before/around downstream parsing, or a
    // genuinely repeated at-least-once invocation). The observation_state
    // 'ingested' CHECK constraint guarantees source_document_id is set.
    if (eligibility.kind === 'idempotent_replay') {
      if (!observation.sourceDocumentId) {
        // Contradicts the DB CHECK constraint; fail loudly rather than guess.
        return this.result(
          'rejected',
          observationId,
          null,
          `observation ${observationId} is 'ingested' but carries no source_document_id (schema invariant violated)`,
        );
      }
      const handoff = await this.attemptParserHandoff({
        cycle,
        observation,
        sourceDocumentId: observation.sourceDocumentId,
        sourceSha256: observation.contentSha256,
      });
      return this.result(
        'already_ingested',
        observationId,
        observation.sourceDocumentId,
        'observation already ingested; parser handoff re-invoked idempotently',
        handoff,
      );
    }

    // eligible: fetch, verify, archive, register, persist, hand off.
    const fetched = await this.fetcher.fetchFullBytes({ url: observation.discoveredUrl });
    if ('blocked' in fetched) {
      return this.result('blocked', observationId, observation.sourceDocumentId, fetched.reason);
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

      const handoff = await this.attemptParserHandoff({
        cycle,
        observation,
        sourceDocumentId: registered.registry.document.id,
        sourceSha256: documentSha256,
        localPath,
      });

      return this.result(
        'ingested',
        observationId,
        registered.registry.document.id,
        attach.alreadyApplied
          ? 'source_document already attached by a prior replay; observation transition was a no-op'
          : null,
        handoff,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async attemptParserHandoff(input: {
    cycle: { id: string };
    observation: {
      classifiedFiscalYear: number | null;
      classifiedAuthorityTrack: import('@capiro/defense-domain').AuthorityTrack | null;
      classifiedStage: import('@capiro/defense-domain').LifecycleStage | null;
      classifiedSourceFamily: import('@capiro/defense-domain').SourceFamily | null;
      discoveredUrl: string;
    };
    sourceDocumentId: string;
    sourceSha256: string;
    /** When absent (idempotent-replay path), bytes are re-fetched to run the handoff. */
    localPath?: string;
  }): Promise<{ invoked: boolean; error: string | null }> {
    const { observation } = input;
    if (
      !observation.classifiedFiscalYear ||
      !observation.classifiedAuthorityTrack ||
      !observation.classifiedStage ||
      !observation.classifiedSourceFamily
    ) {
      return { invoked: false, error: 'observation classification unavailable for parser handoff' };
    }
    const routing = routingForSourceFamily(observation.classifiedSourceFamily);

    let localPath = input.localPath;
    let tempDir: string | null = null;
    try {
      if (!localPath) {
        const refetched = await this.fetcher.fetchFullBytes({ url: observation.discoveredUrl });
        if ('blocked' in refetched || refetched.contentSha256 !== input.sourceSha256) {
          return {
            invoked: false,
            error:
              'blocked' in refetched
                ? `re-fetch for parser handoff failed: ${refetched.reason}`
                : 'SOURCE_BYTES_CHANGED: bytes changed since ingestion; refusing to hand off to the parser',
          };
        }
        tempDir = mkdtempSync(join(tmpdir(), 'phase10b1-obs-bridge-handoff-'));
        localPath = join(tempDir, `${randomUUID()}.bin`);
        writeFileSync(localPath, refetched.bytes);
      }

      await this.parserHandoff.handoff({
        cycleId: input.cycle.id,
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        sourcePath: localPath,
        fiscalYear: observation.classifiedFiscalYear,
        authorityTrack: observation.classifiedAuthorityTrack,
        stage: observation.classifiedStage,
        sourceFamily: observation.classifiedSourceFamily,
        title: routing.documentType,
        sourceUrl: observation.discoveredUrl,
      });
      return { invoked: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`parser handoff failed for ${input.sourceDocumentId}: ${message}`);
      return { invoked: false, error: message };
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private result(
    status: ObservationIngestionBridgeStatus,
    observationId: string,
    sourceDocumentId: string | null,
    reason: string | null,
    handoff?: { invoked: boolean; error: string | null },
  ): ObservationIngestionBridgeResult {
    return {
      status,
      observationId,
      sourceDocumentId,
      reason,
      parserHandoffInvoked: handoff?.invoked ?? false,
      parserHandoffError: handoff?.error ?? null,
    };
  }
}
