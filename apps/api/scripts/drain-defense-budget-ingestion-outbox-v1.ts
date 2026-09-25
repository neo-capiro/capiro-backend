/**
 * One-shot Phase 10B-3 ingestion drain. It invokes governed ingestion and
 * cycle/family readiness, then stops at awaiting_authorization.
 *
 * ABSOLUTE INVARIANT: this script never imports or invokes a promotion
 * authorization service, never invokes canonical promotion execution, and
 * never reads the promoter-only database credential. The unresolved production artifact
 * substrate is named by `PARSER_ARTIFACT_STORAGE_RUNTIME_GAP`; this worker
 * does not make that later infrastructure choice.
 */
import { hostname } from 'node:os';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  PARSER_ARTIFACT_STORAGE_RUNTIME_GAP,
  type AuthorityTrack,
  type SourceFamily,
} from '@capiro/defense-domain';
import { RawArchiveService } from '../src/defense-budget/raw-archive.service.js';
import { makeS3, awsS3Commands } from '../src/defense-budget/s3-aws-commands.js';
import { DocumentRegistrar } from '../src/defense-budget/document-registrar.js';
import { PrismaObservationBridgeStore } from '../src/defense-budget/prisma-observation-bridge.store.js';
import { HttpsObservationByteFetchAdapter } from '../src/defense-budget/https-observation-byte-fetch.adapter.js';
import { S3SourceDocumentArchiveReadAdapter } from '../src/defense-budget/s3-source-document-archive-read.adapter.js';
import { DefaultParserHandoffAdapter } from '../src/defense-budget/default-parser-handoff.adapter.js';
import { congressionalPacketResolverConfigFromEnv, createCongressionalPacketResolverV1 } from '../src/defense-budget/parser-router/congressional-packet-resolver-v1.js';
import {
  ObservationIngestionBridgeService,
  type ObservationIngestionBridgeStatus,
} from '../src/defense-budget/observation-ingestion-bridge.service.js';
import type { ObservationIngestionStageReportV1 } from '../src/defense-budget/observation-ingestion-stage-report-v1.js';
import { createIngestionOutboxDrainRepositoryPrismaV1 } from '../src/defense-budget/ingestion-outbox-drain-repository-prisma-v1.js';
import {
  drainIngestionOutboxBatchV1,
  drainIngestionOutboxRowV1,
  drainReadinessPendingBatchV1,
  emptyIngestionDrainResultV1,
  type IngestionOutboxDrainWorkerPortsV1,
} from '../src/defense-budget/ingestion-outbox-drain-worker-v1.js';
import { evaluateAndAdvanceCycleFamilyReadinessV1 } from '../src/defense-budget/promotion/readiness/cycle-family-readiness-orchestrator-v1.js';
import { buildCycleFamilyReadinessPorts } from './lib/defense-budget-readiness-wiring.js';

dotenvConfig();
const DEFAULT_DOMAIN = 'defense_budget';
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function usage(message: string): never {
  console.error(`drain-defense-budget-ingestion-outbox-v1: ${message}`);
  process.exit(2);
}
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const environment = argValue('--environment');
  if (!environment) usage('--environment is required');
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const outboxRowId = argValue('--outbox-row-id');
  const batchSizeArg = argValue('--batch-size');
  if (outboxRowId && batchSizeArg)
    usage('--outbox-row-id and --batch-size are mutually exclusive -- the single-row mode always claims exactly one named row');
  const batchSize = Number(batchSizeArg ?? '100');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    usage('--batch-size must be an integer from 1 to 1000');
  const leaseOwner = argValue('--lease-owner') ?? `${hostname()}:${process.pid}`;
  const bucket = requiredEnv('DEFENSE_BUDGET_RAW_BUCKET');
  const artifactRoot = requiredEnv('BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT');
  const retentionYears = Number(process.env.DEFENSE_BUDGET_RETENTION_YEARS ?? '7');
  if (!Number.isFinite(retentionYears) || retentionYears <= 0)
    throw new Error('DEFENSE_BUDGET_RETENTION_YEARS must be positive');
  const region = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';
  const prisma = new PrismaClient();
  const archiveReader = new S3SourceDocumentArchiveReadAdapter();
  try {
    const registrar = new DocumentRegistrar(
      new RawArchiveService(makeS3(region), awsS3Commands, {
        bucket,
        kmsKeyArn: process.env.DEFENSE_BUDGET_RAW_KMS_KEY_ARN,
        retentionYears,
      }),
      prisma,
    );
    const bridge = new ObservationIngestionBridgeService(
      new PrismaObservationBridgeStore(prisma),
      new HttpsObservationByteFetchAdapter(),
      registrar,
      new DefaultParserHandoffAdapter({
        workDir: artifactRoot,
        resolveCongressionalPacket: createCongressionalPacketResolverV1(
          congressionalPacketResolverConfigFromEnv(process.env, artifactRoot),
        ),
      }),
      archiveReader,
    );
    const readinessPorts = buildCycleFamilyReadinessPorts(prisma, { domain, environment });
    const ingestionStages: {
      observationId: string;
      sourceDocumentId: string | null;
      bridgeStatus: ObservationIngestionBridgeStatus;
      ingestionSucceeded: boolean;
      stages: ObservationIngestionStageReportV1 | null;
    }[] = [];
    const workerPorts: IngestionOutboxDrainWorkerPortsV1 = {
      repository: createIngestionOutboxDrainRepositoryPrismaV1(prisma),
      bridge: {
        async bridge(observationId) {
          const outcome = await bridge.bridge(observationId);
          ingestionStages.push({
            observationId,
            sourceDocumentId: outcome.sourceDocumentId,
            bridgeStatus: outcome.status,
            ingestionSucceeded: outcome.ingestionSucceeded,
            stages: outcome.stageReport ?? null,
          });
          return outcome;
        },
      },
      async loadObservationScope(observationId) {
        const row = await prisma.defenseBudgetSourceObservation.findUnique({
          where: { id: observationId },
          select: {
            classifiedSourceFamily: true,
            classifiedAuthorityTrack: true,
            classifiedFiscalYear: true,
          },
        });
        if (
          !row?.classifiedSourceFamily ||
          !row.classifiedAuthorityTrack ||
          row.classifiedFiscalYear == null
        )
          return null;
        return {
          classifiedSourceFamily: row.classifiedSourceFamily as SourceFamily,
          authorityTrack: row.classifiedAuthorityTrack as AuthorityTrack,
          fiscalYear: row.classifiedFiscalYear,
        };
      },
      async invokeReadiness(scope) {
        const out = await evaluateAndAdvanceCycleFamilyReadinessV1(scope, readinessPorts, {
          mode: 'new_cycle',
          domain,
          environment,
        });
        return { outcome: out.outcome, planId: out.planId, planHash: out.planHash };
      },
    };
    const result = await (outboxRowId
      ? drainIngestionOutboxRowV1({ leaseOwner, now: new Date(), rowId: outboxRowId }, workerPorts)
      : drainIngestionOutboxBatchV1({ leaseOwner, now: new Date(), batchSize }, workerPorts));
    // Governed single-row mode must never touch any OTHER row's backlog --
    // including the separate readiness-catch-up sweep below, which recovers
    // rows that succeeded in a PRIOR run but crashed before readiness was
    // invoked. drainIngestionOutboxRowV1 already invokes+persists readiness
    // for the named row inline (same as the batch path does per-row), so
    // this sweep is skipped entirely in single-row mode -- it would
    // otherwise silently process unrelated already-succeeded rows sitting in
    // the readiness-pending backlog, defeating the whole point of a bounded
    // canary.
    const readinessCatchUp = outboxRowId
      ? emptyIngestionDrainResultV1()
      : await drainReadinessPendingBatchV1({ leaseOwner, now: new Date(), batchSize }, workerPorts);
    console.log(
      JSON.stringify(
        {
          safety:
            'Stops at awaiting_authorization; no authorization or canonical execution occurs.',
          // Stages describe bridge evidence, independently of the worker's
          // lease/outbox outcome. In particular REVIEW may be persisted with
          // an extraction artifact while ingestionSucceeded remains false.
          ingestionStages,
          parserRuntimeBlocker: PARSER_ARTIFACT_STORAGE_RUNTIME_GAP,
          domain,
          environment,
          leaseOwner,
          outboxRowId: outboxRowId ?? null,
          ...result,
          readinessCatchUp,
        },
        null,
        2,
      ),
    );
  } finally {
    await archiveReader.destroy();
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error('drain-defense-budget-ingestion-outbox-v1 FAILED:', error);
  process.exit(1);
});
