/**
 * Phase 10B-1 — Prisma-backed ObservationBridgeStore.
 *
 * Reads through the fully-typed `apps/api` Prisma client (unlike
 * `apps/defense-api`'s curated model subset, `apps/api/prisma/schema.prisma`
 * already carries typed models for every lifecycle table AND `SourceDocument`
 * — see `defense-budget-lifecycle-read.service.ts`'s own doc comment for why
 * this app is the one with unrestricted typed access). The guarded write
 * (`attachSourceDocumentAndMarkIngested`) is the one place in this file that
 * mutates, and it does so inside a single transaction with a re-check of every
 * invariant against the CURRENT row, not the row this process loaded earlier
 * — the only way to make a concurrent-supersession race and an at-least-once
 * replay both safe.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AuthorityTrack,
  LifecycleStage,
  ObservationState,
  SourceFamily,
} from '@capiro/defense-domain';
import { NON_QUEUEABLE_OBSERVATION_STATES } from '@capiro/defense-domain';

import { PrismaService } from '../prisma/prisma.service.js';
import type {
  LoadedBridgeObservation,
  ObservationBridgeStore,
  StoredSourceDocumentArchiveRecord,
} from './observation-ingestion-bridge.ports.js';
import { readAppropriationAccountMetadataV1 } from './appropriation-account-metadata-v1.js';

type PrismaLike = PrismaService | PrismaClient;

@Injectable()
export class PrismaObservationBridgeStore implements ObservationBridgeStore {
  constructor(private readonly prisma: PrismaLike) {}

  async loadForBridge(observationId: string): Promise<LoadedBridgeObservation | null> {
    const observation = await this.prisma.defenseBudgetSourceObservation.findUnique({
      where: { id: observationId },
      include: { expectedSource: true, cycle: true },
    });
    if (!observation) return null;

    return {
      observation: {
        id: observation.id,
        expectedSourceId: observation.expectedSourceId,
        cycleId: observation.cycleId,
        adapterId: observation.adapterId,
        discoveredUrl: observation.discoveredUrl,
        contentSha256: observation.contentSha256,
        observationState: observation.observationState as ObservationState,
        classifiedFiscalYear: observation.classifiedFiscalYear,
        classifiedAuthorityTrack: observation.classifiedAuthorityTrack as AuthorityTrack | null,
        classifiedStage: observation.classifiedStage as LifecycleStage | null,
        classifiedSourceFamily: observation.classifiedSourceFamily as SourceFamily | null,
        sourceDocumentId: observation.sourceDocumentId,
        dedupKey: observation.dedupKey,
      },
      expectedSource: {
        id: observation.expectedSource.id,
        adapterId: observation.expectedSource.adapterId,
        label: observation.expectedSource.label,
        chamber: observation.expectedSource.chamber as 'house' | 'senate' | 'joint' | null,
        committee: observation.expectedSource.committee,
        component: observation.expectedSource.component,
        account: readAppropriationAccountMetadataV1(observation.expectedSource.metadata) ?? null,
      },
      cycle: {
        id: observation.cycle.id,
        fiscalYear: observation.cycle.fiscalYear,
        authorityTrack: observation.cycle.authorityTrack as AuthorityTrack,
      },
    };
  }

  async loadSourceDocumentArchive(
    sourceDocumentId: string,
  ): Promise<StoredSourceDocumentArchiveRecord | null> {
    const document = await this.prisma.sourceDocument.findUnique({
      where: { id: sourceDocumentId },
    });
    if (!document) return null;
    return {
      sourceDocumentId: document.id,
      sha256: document.sha256,
      archiveBucket: document.archiveBucket,
      archiveS3Key: document.archiveS3Key,
      archiveVersionId: document.archiveVersionId,
      // Phase 10B-31: same already-loaded row, one more of its columns --
      // lets a replay hand the parser the real, persisted component.
      component: document.component,
      account: readAppropriationAccountMetadataV1(document.metadata) ?? null,
    };
  }

  async attachSourceDocumentAndMarkIngested(input: {
    observationId: string;
    expectedContentSha256: string;
    sourceDocumentId: string;
    sourceDocumentSha256: string;
  }): Promise<{ applied: boolean; alreadyApplied: boolean }> {
    // Guard 0: never attach a SourceDocument whose SHA does not match the
    // observation SHA. This is re-asserted here — the last line of defense —
    // even though every caller is expected to have already verified it.
    if (input.sourceDocumentSha256 !== input.expectedContentSha256) {
      throw new Error(
        `refusing to attach source_document_id=${input.sourceDocumentId} (sha=${input.sourceDocumentSha256}) ` +
          `to observation ${input.observationId}: SHA does not match the observation's persisted ` +
          `content_sha256=${input.expectedContentSha256}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.defenseBudgetSourceObservation.findUnique({
        where: { id: input.observationId },
      });
      if (!current) {
        throw new Error(`observation ${input.observationId} no longer exists`);
      }

      // Idempotent replay: a prior run of this bridge already completed this
      // exact transition. Converge rather than error or re-mutate.
      if (
        current.observationState === 'ingested' &&
        current.sourceDocumentId === input.sourceDocumentId
      ) {
        return { applied: false, alreadyApplied: true };
      }

      // Re-check every invariant against the CURRENT row, not the row loaded
      // earlier in this process — defends against a concurrent watcher
      // supersession that ran between load and write.
      if (NON_QUEUEABLE_OBSERVATION_STATES.includes(current.observationState as ObservationState)) {
        throw new Error(
          `observation ${input.observationId} is now '${current.observationState}'; refusing to transition ` +
            'a review_required/blocked/withdrawn observation into ingestion',
        );
      }
      if (current.observationState !== 'changed') {
        throw new Error(
          `observation ${input.observationId} is '${current.observationState}', not 'changed'; only a ` +
            'freshly-changed observation may be bridged into ingestion',
        );
      }
      if (current.contentSha256 !== input.expectedContentSha256) {
        throw new Error(
          `observation ${input.observationId} content_sha256 changed since it was loaded ` +
            `(now ${current.contentSha256}, expected ${input.expectedContentSha256}); refusing to attach a ` +
            'SourceDocument built from stale bytes',
        );
      }

      await tx.defenseBudgetSourceObservation.update({
        where: { id: input.observationId },
        data: {
          sourceDocumentId: input.sourceDocumentId,
          observationState: 'ingested' satisfies ObservationState,
        },
      });
      return { applied: true, alreadyApplied: false };
    });
  }
}

/** Narrow typing helper so the transaction callback sees the real delegate shape. */
export type ObservationBridgeTx = Prisma.TransactionClient;
