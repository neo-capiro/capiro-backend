/**
 * Phase 10B-18 Part F/H/J — Prisma-backed reads/writes for the governed
 * operator-attested import path.
 *
 * Uses the fully-typed `apps/api` Prisma client, same precedent as
 * `PrismaObservationBridgeStore` in this directory. This file owns exactly:
 * loading the expected source + bundle member (+ siblings) to validate
 * against, inserting the lifecycle observation + outbox row a governed
 * import produces, updating the bundle member's status/binding after the
 * bridge resolves, and inserting the append-only audit row. It does NOT
 * archive bytes or run the parser/verifier — that stays entirely inside the
 * existing `ObservationIngestionBridgeService`.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

import {
  ingestionOutboxDedupKey,
  observationDedupKey,
  type AuthorityTrack,
  type BudgetComponent,
  type LifecycleStage,
  type SourceFamily,
} from '@capiro/defense-domain';

import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  GovernedImportBundleMemberFacts,
  GovernedImportExpectedSourceFacts,
  GovernedImportMemberStatus,
  GovernedImportSiblingMemberFacts,
} from './governed-source-import.validation.js';

type PrismaLike = PrismaService | PrismaClient;

export interface LoadedGovernedImportContext {
  readonly expectedSource: GovernedImportExpectedSourceFacts & { readonly dedupKey: string; readonly cycleId: string };
  readonly bundleMember: GovernedImportBundleMemberFacts;
  readonly siblingMembers: readonly GovernedImportSiblingMemberFacts[];
}

@Injectable()
export class GovernedSourceImportStore {
  constructor(private readonly prisma: PrismaLike) {}

  async loadContext(input: {
    expectedSourceId: string;
    memberId: string;
  }): Promise<LoadedGovernedImportContext | { error: string }> {
    const expectedSource = await this.prisma.defenseBudgetExpectedSource.findUnique({
      where: { id: input.expectedSourceId },
    });
    if (!expectedSource) {
      return { error: `expected source ${input.expectedSourceId} does not exist` };
    }

    type MemberRow = Prisma.DefenseBudgetSourceBundleMemberGetPayload<{
      include: { observation: { select: { contentSha256: true } } };
    }>;
    const members: MemberRow[] = await this.prisma.defenseBudgetSourceBundleMember.findMany({
      where: { expectedSourceId: input.expectedSourceId },
      include: { observation: { select: { contentSha256: true } } },
    });
    const target = members.find((m: MemberRow) => m.id === input.memberId);
    if (!target) {
      return {
        error: `bundle member ${input.memberId} does not exist for expected source ${input.expectedSourceId}`,
      };
    }

    return {
      expectedSource: {
        id: expectedSource.id,
        dedupKey: expectedSource.dedupKey,
        cycleId: expectedSource.cycleId,
        fiscalYear: expectedSource.fiscalYear,
        authorityTrack: expectedSource.authorityTrack as AuthorityTrack,
        stage: expectedSource.stage as LifecycleStage,
        sourceFamily: expectedSource.sourceFamily as SourceFamily,
        component: expectedSource.component as BudgetComponent,
        adapterId: expectedSource.adapterId,
      },
      bundleMember: {
        id: target.id,
        expectedSourceId: target.expectedSourceId,
        memberKey: target.memberKey,
        officialUrl: target.officialUrl,
        title: target.title,
        required: target.required,
        memberStatus: target.memberStatus as GovernedImportMemberStatus,
        boundContentSha256: target.observation?.contentSha256 ?? null,
      },
      siblingMembers: members
        .filter((m: MemberRow) => m.id !== target.id)
        .map((m: MemberRow) => ({
          memberKey: m.memberKey,
          required: m.required,
          memberStatus: m.memberStatus as GovernedImportMemberStatus,
          boundContentSha256: m.observation?.contentSha256 ?? null,
        })),
    };
  }

  /**
   * Insert-or-touch, mirroring `recordObservation`'s existing idempotency
   * point on the live watcher path exactly: the same (expected_source_id,
   * content_sha256) pair always resolves to the SAME observation row, so a
   * replayed governed import never creates a duplicate.
   */
  async recordGovernedObservation(input: {
    expectedSource: LoadedGovernedImportContext['expectedSource'];
    officialUrl: string;
    contentSha256: string;
    byteSize: number;
    actor: string;
    reason: string;
    nowIso: string;
  }): Promise<{ observationId: string; created: boolean }> {
    const dedupKey = observationDedupKey({
      expectedSourceDedupKey: input.expectedSource.dedupKey,
      contentSha256: input.contentSha256,
    });

    const existing = await this.prisma.defenseBudgetSourceObservation.findUnique({
      where: {
        expectedSourceId_contentSha256: {
          expectedSourceId: input.expectedSource.id,
          contentSha256: input.contentSha256,
        },
      },
    });
    if (existing) {
      return { observationId: existing.id, created: false };
    }

    const created = await this.prisma.defenseBudgetSourceObservation.create({
      data: {
        expectedSourceId: input.expectedSource.id,
        cycleId: input.expectedSource.cycleId,
        adapterId: input.expectedSource.adapterId,
        discoveredUrl: input.officialUrl,
        contentSha256: input.contentSha256,
        byteSize: input.byteSize,
        observationState: 'changed',
        revisionKind: 'first_discovery',
        classifiedFiscalYear: input.expectedSource.fiscalYear,
        classifiedAuthorityTrack: input.expectedSource.authorityTrack,
        classifiedStage: input.expectedSource.stage,
        classifiedSourceFamily: input.expectedSource.sourceFamily,
        classificationConfidence: 1,
        reviewReasons: [],
        dedupKey,
        firstSeenAt: input.nowIso,
        lastSeenAt: input.nowIso,
        metadata: {
          acquisitionMethod: 'operator_attested_official_source_import',
          operator: input.actor,
          reason: input.reason,
          importedAt: input.nowIso,
        },
      },
    });
    return { observationId: created.id, created: true };
  }

  /** Mirrors `enqueueIngestion`'s existing ON CONFLICT DO NOTHING semantics. */
  async enqueueGovernedIngestion(input: {
    observationId: string;
    cycleId: string;
    observationDedupKeyValue: string;
  }): Promise<{ created: boolean }> {
    const dedupKey = ingestionOutboxDedupKey({
      observationDedupKey: input.observationDedupKeyValue,
      jobKind: 'governed_source_ingestion',
    });
    const existing = await this.prisma.defenseBudgetIngestionOutbox.findUnique({
      where: { observationId_jobKind: { observationId: input.observationId, jobKind: 'governed_source_ingestion' } },
    });
    if (existing) return { created: false };
    await this.prisma.defenseBudgetIngestionOutbox.create({
      data: {
        observationId: input.observationId,
        observationState: 'changed',
        cycleId: input.cycleId,
        jobKind: 'governed_source_ingestion',
        dedupKey,
      },
    });
    return { created: true };
  }

  async markMemberBound(input: {
    bundleMemberId: string;
    memberStatus: GovernedImportMemberStatus;
    observationId: string;
    sourceDocumentId: string | null;
  }): Promise<void> {
    await this.prisma.defenseBudgetSourceBundleMember.update({
      where: { id: input.bundleMemberId },
      data: {
        memberStatus: input.memberStatus,
        observationId: input.observationId,
        sourceDocumentId: input.sourceDocumentId,
      },
    });
  }

  async loadSourceDocumentArchiveLocator(sourceDocumentId: string): Promise<{
    archiveBucket: string | null;
    archiveS3Key: string | null;
    archiveVersionId: string | null;
  } | null> {
    const document = await this.prisma.sourceDocument.findUnique({
      where: { id: sourceDocumentId },
      select: { archiveBucket: true, archiveS3Key: true, archiveVersionId: true },
    });
    return document ?? null;
  }

  async recordAudit(input: {
    expectedSourceId: string;
    bundleMemberId: string;
    observationId: string;
    operator: string;
    reason: string;
    officialUrl: string;
    contentSha256: string;
    byteSize: number;
    archiveBucket: string;
    archiveS3Key: string;
    archiveVersionId: string | null;
    importCommandVersion: string;
    identityChecks: Record<string, unknown>;
  }): Promise<{ auditId: string }> {
    const row = await this.prisma.defenseBudgetGovernedImportAudit.create({
      data: {
        expectedSourceId: input.expectedSourceId,
        bundleMemberId: input.bundleMemberId,
        observationId: input.observationId,
        operator: input.operator,
        reason: input.reason,
        officialUrl: input.officialUrl,
        contentSha256: input.contentSha256,
        byteSize: input.byteSize,
        archiveBucket: input.archiveBucket,
        archiveS3Key: input.archiveS3Key,
        archiveVersionId: input.archiveVersionId,
        importCommandVersion: input.importCommandVersion,
        identityChecks: input.identityChecks as Prisma.InputJsonValue,
      },
    });
    return { auditId: row.id };
  }
}
