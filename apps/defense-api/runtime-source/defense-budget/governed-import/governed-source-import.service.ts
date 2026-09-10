/**
 * Phase 10B-18 Parts F/H/I/J/K — governed operator-attested source import.
 *
 * Orchestrates exactly:
 *
 *   validate (governed-source-import.validation.ts, fail-closed, zero writes
 *     on any refusal)
 *     -> [dry run stops here, reporting the same preview a commit would act on]
 *     -> record the lifecycle observation + outbox row (GovernedSourceImportStore)
 *     -> invoke the EXISTING, UNMODIFIED ObservationIngestionBridgeService,
 *        with ONLY the byte-fetch port swapped for OperatorAttestedByteFetchPort
 *        (see that adapter's doc comment for why this is 100% code-path reuse)
 *     -> update the bundle member's status/binding from the bridge's result
 *     -> update the expected source's bundle-aware completion state
 *        (the SAME decideExpectedSourceStateOnDocumentArrivalV1 the live
 *        watcher calls — see lifecycle-watcher.service.ts)
 *     -> persist the immutable audit record (governed-source-import.store.ts)
 *
 * Deliberately does NOT invoke cycle/family readiness or promotion — Phase
 * 10B-18 Part I requires that WHEN readiness/projection later run, they
 * cannot tell this observation apart from a live-fetch one; it does not
 * require this command to trigger them itself. Running them here would also
 * be "deploying a drain runtime" in substance, which this phase's brief
 * explicitly defers.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';

import {
  decideExpectedSourceStateOnDocumentArrivalV1,
  evaluateBundleCompletenessV1,
  observationDedupKey,
  type BundleMemberFactsV1,
} from '@capiro/defense-domain';

import { ObservationIngestionBridgeService } from '../observation-ingestion-bridge.service.js';
import { PrismaObservationBridgeStore } from '../prisma-observation-bridge.store.js';
import { DocumentRegistrar } from '../document-registrar.js';
import { RawArchiveService, type S3CommandFactory, type S3Like } from '../raw-archive.service.js';
import { DefaultParserHandoffAdapter } from '../default-parser-handoff.adapter.js';
import { S3SourceDocumentArchiveReadAdapter } from '../s3-source-document-archive-read.adapter.js';
import { OperatorAttestedByteFetchPort } from './operator-attested-byte-fetch.adapter.js';
import {
  validateGovernedImportRequest,
  type GovernedImportValidationResult,
} from './governed-source-import.validation.js';
import { GovernedSourceImportStore, type LoadedGovernedImportContext } from './governed-source-import.store.js';

export const IMPORT_COMMAND_VERSION = 'import-defense-budget-source-v1@10b18.1';

export interface GovernedSourceImportRequest {
  readonly expectedSourceId: string;
  readonly memberId: string;
  readonly officialUrl: string;
  readonly fileBytes: Buffer;
  readonly actor: string;
  readonly reason: string;
  readonly commit: boolean;
  readonly nowIso: string;
}

export interface GovernedSourceImportDryRunResult {
  readonly mode: 'dry_run';
  readonly accepted: boolean;
  readonly validation: GovernedImportValidationResult;
  readonly preview?: {
    readonly expectedSourceId: string;
    readonly memberKey: string;
    readonly officialUrl: string;
    readonly contentSha256: string;
    readonly byteSize: number;
    readonly currentMemberStatus: string;
    readonly wouldCollideWithExistingObservation: boolean;
  };
}

export interface GovernedSourceImportCommitResult {
  readonly mode: 'commit';
  readonly accepted: boolean;
  readonly validation: GovernedImportValidationResult;
  readonly observationId?: string;
  readonly observationCreated?: boolean;
  readonly outboxCreated?: boolean;
  readonly ingestionSucceeded?: boolean;
  readonly verifierDecision?: string | null;
  readonly memberStatus?: string;
  readonly bundleCompleteness?: string;
  readonly expectedSourceState?: string;
  readonly auditId?: string;
}

export type GovernedSourceImportResult = GovernedSourceImportDryRunResult | GovernedSourceImportCommitResult;

export interface GovernedSourceImportInfra {
  readonly rawArchiveBucket: string;
  readonly rawArchiveKmsKeyArn: string | undefined;
  readonly retentionYears: number;
  readonly parserArtifactRoot: string;
  readonly s3: S3Like;
  readonly s3Commands: S3CommandFactory;
}

export class GovernedSourceImportService {
  constructor(
    private readonly store: GovernedSourceImportStore,
    private readonly prisma: PrismaClient,
    private readonly infra: GovernedSourceImportInfra,
  ) {}

  async run(request: GovernedSourceImportRequest): Promise<GovernedSourceImportResult | { error: string }> {
    const context = await this.store.loadContext({
      expectedSourceId: request.expectedSourceId,
      memberId: request.memberId,
    });
    if ('error' in context) return context;

    const validation = validateGovernedImportRequest({
      expectedSource: context.expectedSource,
      bundleMember: context.bundleMember,
      siblingMembers: context.siblingMembers,
      officialUrlArg: request.officialUrl,
      fileBytes: request.fileBytes,
      actor: request.actor,
      reason: request.reason,
    });

    if (!request.commit) {
      if (!validation.ok) {
        return { mode: 'dry_run', accepted: false, validation };
      }
      const existingObservation = await this.wouldCollide(context, validation.contentSha256);
      return {
        mode: 'dry_run',
        accepted: true,
        validation,
        preview: {
          expectedSourceId: context.expectedSource.id,
          memberKey: context.bundleMember.memberKey,
          officialUrl: request.officialUrl,
          contentSha256: validation.contentSha256,
          byteSize: validation.byteSize,
          currentMemberStatus: context.bundleMember.memberStatus,
          wouldCollideWithExistingObservation: existingObservation,
        },
      };
    }

    if (!validation.ok) {
      return { mode: 'commit', accepted: false, validation };
    }

    return this.commit(context, request, validation);
  }

  private async wouldCollide(context: LoadedGovernedImportContext, contentSha256: string): Promise<boolean> {
    return context.bundleMember.boundContentSha256 === contentSha256;
  }

  private async commit(
    context: LoadedGovernedImportContext,
    request: GovernedSourceImportRequest,
    validation: Extract<GovernedImportValidationResult, { ok: true }>,
  ): Promise<GovernedSourceImportCommitResult> {
    const recorded = await this.store.recordGovernedObservation({
      expectedSource: context.expectedSource,
      officialUrl: request.officialUrl,
      contentSha256: validation.contentSha256,
      byteSize: validation.byteSize,
      actor: request.actor,
      reason: request.reason,
      nowIso: request.nowIso,
    });

    const observationDedup = observationDedupKey({
      expectedSourceDedupKey: context.expectedSource.dedupKey,
      contentSha256: validation.contentSha256,
    });
    const outbox = await this.store.enqueueGovernedIngestion({
      observationId: recorded.observationId,
      cycleId: context.expectedSource.cycleId,
      observationDedupKeyValue: observationDedup,
    });

    const tempDir = mkdtempSync(join(tmpdir(), 'phase10b18-governed-import-'));
    let bridgeOutcome:
      | Awaited<ReturnType<ObservationIngestionBridgeService['bridge']>>
      | { ingestionSucceeded: false; sourceDocumentBound: false; verifierDecision: null; sourceDocumentId: null };
    try {
      const localPath = join(tempDir, `${randomUUID()}.pdf`);
      writeFileSync(localPath, request.fileBytes);

      const archiveReader = new S3SourceDocumentArchiveReadAdapter();
      try {
        const bridge = new ObservationIngestionBridgeService(
          new PrismaObservationBridgeStore(this.prisma),
          new OperatorAttestedByteFetchPort(request.officialUrl, request.fileBytes),
          new DocumentRegistrar(
            new RawArchiveService(this.infra.s3, this.infra.s3Commands, {
              bucket: this.infra.rawArchiveBucket,
              kmsKeyArn: this.infra.rawArchiveKmsKeyArn,
              retentionYears: this.infra.retentionYears,
            }),
            this.prisma,
          ),
          new DefaultParserHandoffAdapter({ workDir: this.infra.parserArtifactRoot }),
          archiveReader,
        );
        bridgeOutcome = await bridge.bridge(recorded.observationId);
      } finally {
        await archiveReader.destroy();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const memberStatus: 'observed' | 'verified' = bridgeOutcome.ingestionSucceeded ? 'verified' : 'observed';
    let bundleCompleteness = 'no_bundle';
    let expectedSourceState = 'published';
    if (bridgeOutcome.sourceDocumentBound && bridgeOutcome.sourceDocumentId) {
      await this.store.markMemberBound({
        bundleMemberId: context.bundleMember.id,
        memberStatus,
        observationId: recorded.observationId,
        sourceDocumentId: bridgeOutcome.sourceDocumentId,
      });

      const refreshed = await this.store.loadContext({
        expectedSourceId: context.expectedSource.id,
        memberId: context.bundleMember.id,
      });
      const members: BundleMemberFactsV1[] =
        'error' in refreshed
          ? []
          : [
              { required: context.bundleMember.required, memberStatus },
              ...refreshed.siblingMembers.map((s) => ({
                required: s.required,
                memberStatus: s.memberStatus,
              })),
            ];
      const completeness = evaluateBundleCompletenessV1(members);
      bundleCompleteness = completeness;
      expectedSourceState = decideExpectedSourceStateOnDocumentArrivalV1(completeness);
      await this.prisma.defenseBudgetExpectedSource.update({
        where: { id: context.expectedSource.id },
        data: { expectedState: expectedSourceState, reviewReason: null },
      });
    }

    let auditId: string | undefined;
    if (bridgeOutcome.sourceDocumentBound && bridgeOutcome.sourceDocumentId) {
      const locator = await this.store.loadSourceDocumentArchiveLocator(bridgeOutcome.sourceDocumentId);
      const audit = await this.store.recordAudit({
        expectedSourceId: context.expectedSource.id,
        bundleMemberId: context.bundleMember.id,
        observationId: recorded.observationId,
        operator: request.actor,
        reason: request.reason,
        officialUrl: request.officialUrl,
        contentSha256: validation.contentSha256,
        byteSize: validation.byteSize,
        archiveBucket: locator?.archiveBucket ?? this.infra.rawArchiveBucket,
        archiveS3Key: locator?.archiveS3Key ?? '',
        archiveVersionId: locator?.archiveVersionId ?? null,
        importCommandVersion: IMPORT_COMMAND_VERSION,
        identityChecks: { validation },
      });
      auditId = audit.auditId;
    }

    return {
      mode: 'commit',
      accepted: true,
      validation,
      observationId: recorded.observationId,
      observationCreated: recorded.created,
      outboxCreated: outbox.created,
      ingestionSucceeded: bridgeOutcome.ingestionSucceeded,
      verifierDecision: bridgeOutcome.verifierDecision,
      memberStatus: bridgeOutcome.sourceDocumentBound ? memberStatus : context.bundleMember.memberStatus,
      bundleCompleteness,
      expectedSourceState,
      auditId,
    };
  }
}
