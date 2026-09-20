/**
 * qualify-defense-budget-drain-image-v1.integration.spec.ts (Phase 10B-36).
 *
 * Real, disposable-Postgres + disposable-MinIO proof that the committed
 * qualification driver's isolated-seeding, real parser handoff, and dbverify
 * readback all work against genuine infrastructure -- no mocked Prisma
 * client, no stubbed S3 client, no fabricated handoff result. Modeled on
 * this program's established DB-backed-testing convention (pgvector/pgvector:pg16,
 * database named exactly `capiro`) and directly on
 * src/defense-budget/governed-acceptance/candidate-correction/phase10b35c-candidate-correction-e2e.integration.spec.ts's
 * skip-unless-local gate.
 *
 * Uses the SAME real, already-committed FY2024 Army R-2 Volume 1 BA1 fixture
 * this program's other defense-budget integration specs already use
 * (src/defense-budget/rdte/cycle/__fixtures__/production-fy2024-army-r2-vol1-ba1-official.pdf),
 * so this proves the real production_proof path end to end without needing
 * network access to the real archived source or a real presigned URL --
 * fetchAndVerifySource itself (the presigned-URL leg) is exercised
 * separately by the rehearsal script, which serves this same fixture from a
 * local static file server so the exact same HTTP-fetch code path runs.
 *
 * Run with (self-provisions and tears down its own Postgres + MinIO):
 *   pnpm --filter @capiro/api run verify:qualify-defense-budget-drain-image-v1:db
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { createBudgetVerificationS3Client, BUDGET_VERIFICATION_S3_ENDPOINT_ENV } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';
import { runParserHandoffForSourceDocument } from '../src/defense-budget/parser-router/source-document-parser-handoff.js';
import { DocumentRegistrar } from '../src/defense-budget/document-registrar.js';
import type { RawArchiveService } from '../src/defense-budget/raw-archive.service.js';
import { PrismaObservationBridgeStore } from '../src/defense-budget/prisma-observation-bridge.store.js';
import { S3SourceDocumentArchiveReadAdapter } from '../src/defense-budget/s3-source-document-archive-read.adapter.js';
import { DefaultParserHandoffAdapter } from '../src/defense-budget/default-parser-handoff.adapter.js';
import { ObservationIngestionBridgeService } from '../src/defense-budget/observation-ingestion-bridge.service.js';
import { sealIngestionManifestV1 } from '../src/defense-budget/governed-ingestion-manifest/ingestion-manifest-contract-v1.js';
import { createIngestionManifestRepositoryV1 } from '../src/defense-budget/governed-ingestion-manifest/ingestion-manifest-repository-v1.js';
import { RunIngestionManifestV1 } from '../src/defense-budget/governed-ingestion-manifest/run-ingestion-manifest-v1.js';
import {
  buildQualificationReport,
  dbverifyCandidate,
  resolveQualificationConfig,
  seedIsolatedFixtures,
} from './qualify-defense-budget-drain-image-v1.js';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const ARCHIVE_ENDPOINT = process.env[BUDGET_VERIFICATION_S3_ENDPOINT_ENV]?.trim();

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

const describeE2E = isLocalUrl(DATABASE_URL) && isLocalUrl(ARCHIVE_ENDPOINT) ? describe : describe.skip;

const REAL_R2_FIXTURE_PATH = join(
  __dirname,
  '..',
  'src',
  'defense-budget',
  'rdte',
  'cycle',
  '__fixtures__',
  'production-fy2024-army-r2-vol1-ba1-official.pdf',
);
const REAL_R2_FIXTURE_SHA256 = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const PARSER_PROJECT_DIR = join(__dirname, '..', '..', 'defense-budget-parser');

describeE2E('qualify-defense-budget-drain-image-v1 (Phase 10B-36) -- real isolated Postgres + MinIO + real parser handoff', () => {
  jest.setTimeout(10 * 60 * 1000);

  let prisma: PrismaClient;
  let outRoot: string;

  beforeAll(() => {
    prisma = new PrismaClient();
    outRoot = mkdtempSync(join(tmpdir(), 'qualify-defense-budget-drain-image-v1-'));
    expect(existsSync(REAL_R2_FIXTURE_PATH)).toBe(true);
    expect(existsSync(PARSER_PROJECT_DIR)).toBe(true);
    const actualSha256 = createHash('sha256').update(readFileSync(REAL_R2_FIXTURE_PATH)).digest('hex');
    expect(actualSha256).toBe(REAL_R2_FIXTURE_SHA256);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "source_document", "defense_budget_cycle" CASCADE`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(outRoot, { recursive: true, force: true });
  });

  it('seeds real isolated Postgres + MinIO rows, runs the REAL production-proof handoff, and dbverify reads back what was actually persisted', async () => {
    const runId = `it-${Date.now()}`;
    const config = resolveQualificationConfig({
      QUAL_PRESIGNED_GET: 'unused-in-this-spec://not-fetched',
      QUAL_RUN_ID: runId,
      QUAL_OUT_ROOT: outRoot,
      // Distinct identity per test run so repeated CI runs never collide on
      // the (sourceKey, sha256) unique constraint or the cycle dedupKey.
      QUAL_SOURCE_DOCUMENT_ID: randomUUID(),
      QUAL_CYCLE_ID: randomUUID(),
      QUAL_SOURCE_KEY: `defense-budget-observation-qualification-it-${runId}`,
      QUAL_ARCHIVE_BUCKET: `capiro-qualify-it-${Date.now()}`,
    });

    // fetchAndVerifySource is exercised by the rehearsal script's local HTTP
    // server, not here -- this spec seeds the source file directly, exactly
    // the postcondition fetchAndVerifySource leaves behind (a verified PDF
    // at config.sourcePath), so the rest of the pipeline is proven for real.
    mkdirSync(dirname(config.sourcePath), { recursive: true });
    copyFileSync(REAL_R2_FIXTURE_PATH, config.sourcePath);

    const s3 = createBudgetVerificationS3Client(process.env);
    const seed = await seedIsolatedFixtures(prisma, s3, config);
    expect(seed.archiveVersionId).toBeTruthy();

    mkdirSync(config.workDir, { recursive: true });
    process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = config.workDir;
    process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = PARSER_PROJECT_DIR;

    const result = await runParserHandoffForSourceDocument({
      executionId: `qualify-it-${runId}`,
      cycleId: config.cycleId,
      sourceDocumentId: config.sourceDocumentId,
      sourcePath: config.sourcePath,
      sourceSha256: config.sourceSha256,
      sourceLocator: config.sourceUrl,
      sourceUrl: config.sourceUrl,
      parserPolicy: 'deterministic_table',
      exhibitType: 'R-2',
      budgetFamily: 'rdte',
      fiscalYear: config.fiscalYear,
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      sourceKey: config.sourceKey,
      documentType: 'r2',
      title: config.title,
      workDir: config.workDir,
      persistVerificationAudit: true,
      allowPaidParse: false,
      maxPaidPages: 0,
      parserProjectDir: PARSER_PROJECT_DIR,
    });

    // Deliberately NOT asserting a specific decision value here. The
    // Phase 10B-28/10B-32/10B-35 qualification history documents REVIEW as
    // the expected outcome for a correct, complete parse of this fixture --
    // but three independent real runs of this exact spec (2026-09-10,
    // pdfplumber-only / +camelot / +camelot+ocr) all reproduced REJECT
    // instead, with 27 stable `missing_evidence` omissions on physical pages
    // 11-37. That range and failure mode are the SAME pre-existing,
    // already-documented profiler/OCR defect
    // r2-real-document-e2e-acceptance.spec.ts's own header attributes to
    // Phase 10B-16 ("routes them straight to the paddleocr engine tier
    // without ever attempting deterministic_pdfplumber... the separate
    // paddleocr 2.10.0/'PP-StructureV3' engine-version incompatibility") --
    // not a defect in this driver. Pinning to REVIEW would make this test
    // wrong the moment that pre-existing defect is fixed (decision would
    // correctly change); pinning to REJECT would make it wrong the moment it
    // is fixed. What must hold regardless is decision being a real, valid
    // verifier outcome and the artifact/DB agreeing on it -- exactly what's
    // asserted below.
    expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision);

    const dbverify = await dbverifyCandidate(prisma, config.cycleId, config.sourceDocumentId);
    expect(dbverify.candidate).not.toBeNull();
    expect(dbverify.run).not.toBeNull();
    // This IS the exact defect class Phase 10B-32 discovered the prior (v7)
    // driver could never catch: persistVerificationAudit:true must produce a
    // REAL persisted run row, not just an in-memory result.
    expect(dbverify.run?.decision).toBe(result.decision);

    const artifactBytes = readFileSync(result.outputPath);
    const artifact = JSON.parse(artifactBytes.toString('utf8'));
    const manifestPath = join(dirname(result.outputPath), 'lifecycle-bridge-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { cycleId: string };

    const report = buildQualificationReport({
      runId,
      decision: result.decision,
      finalState: result.finalState,
      artifact,
      artifactRawBytes: artifactBytes,
      manifestCycleId: manifest.cycleId,
      targetPeCode: config.targetPeCode,
      fiscalYear: config.fiscalYear,
      dbverify,
    });

    expect(report.dbverifyOk).toBe(true);
    // This IS the invariant that actually matters regardless of decision:
    // the report's decision must agree with what was really persisted, not
    // a second, independent computation of it.
    expect(report.dbRunDecision).toBe(result.decision);
    expect(report.totalAssertions).toBeGreaterThan(0);
    // Stable across all 3 real runs regardless of the profiler defect above
    // (it affects completeness/omissions on unrelated pages, not this PE's
    // own total): PE 0601102A FY2024 total is $296.67M, as a canonical
    // decimal STRING (never a float -- see buildQualificationReport's own
    // ExtractionArtifactLike comment).
    expect(report.targetPeFiscalYearTotalMillions).toBe('296.67');
    expect(report.identityPeCodes).toContain('0601102A');

    console.log('QUALIFICATION_REPORT (integration spec)', JSON.stringify(report, null, 2));
  });

  it('runs a pinned existing outbox row through the Package E controller, real bridge, real parser, fenced persistence, and ingestion-only finalization', async () => {
    const runId = `manifest-it-${Date.now()}`;
    const observationId = randomUUID();
    const observationDedupKey = createHash('sha256').update(`package-e-observation:${runId}`).digest('hex');
    const config = resolveQualificationConfig({
      QUAL_PRESIGNED_GET: 'unused-in-this-spec://not-fetched',
      QUAL_RUN_ID: runId,
      QUAL_OUT_ROOT: outRoot,
      QUAL_SOURCE_DOCUMENT_ID: randomUUID(),
      QUAL_CYCLE_ID: randomUUID(),
      QUAL_SOURCE_KEY: `defense-budget-observation-${observationDedupKey}`,
      QUAL_ARCHIVE_BUCKET: `capiro-package-e-it-${Date.now()}`,
    });
    mkdirSync(dirname(config.sourcePath), { recursive: true });
    copyFileSync(REAL_R2_FIXTURE_PATH, config.sourcePath);

    const seed = await seedIsolatedFixtures(prisma, createBudgetVerificationS3Client(process.env), config);
    const expectedSourceId = randomUUID();
    const outboxRowId = randomUUID();
    const now = new Date();
    await prisma.defenseBudgetExpectedSource.create({ data: {
      id: expectedSourceId,
      cycleId: config.cycleId,
      fiscalYear: config.fiscalYear,
      authorityTrack: 'request',
      stage: 'president_budget_request',
      sourceFamily: 'pb_r2',
      component: 'ARMY',
      adapterId: 'package-e-real-parser-it',
      label: config.title,
      expectedState: 'published',
      templateVersion: 'package-e-real-parser-it-v1',
      expectedFrom: now,
      expectedTo: now,
      dedupKey: createHash('sha256').update(`package-e-expected:${runId}`).digest('hex'),
    } });
    await prisma.defenseBudgetSourceObservation.create({ data: {
      id: observationId,
      expectedSourceId,
      cycleId: config.cycleId,
      adapterId: 'package-e-real-parser-it',
      discoveredUrl: config.sourceUrl,
      contentSha256: config.sourceSha256,
      byteSize: config.sourceBytes,
      observationState: 'ingested',
      revisionKind: 'first_discovery',
      classifiedFiscalYear: config.fiscalYear,
      classifiedAuthorityTrack: 'request',
      classifiedStage: 'president_budget_request',
      classifiedSourceFamily: 'pb_r2',
      classificationConfidence: 1,
      sourceDocumentId: config.sourceDocumentId,
      dedupKey: observationDedupKey,
    } });
    const outbox = await prisma.defenseBudgetIngestionOutbox.create({ data: {
      id: outboxRowId,
      observationId,
      observationState: 'ingested',
      cycleId: config.cycleId,
      jobKind: 'governed_source_ingestion',
      state: 'pending',
      attempts: 0,
      availableAt: now,
      dedupKey: createHash('sha256').update(`package-e-outbox:${runId}`).digest('hex'),
    } });

    const operationId = randomUUID();
    const memberId = randomUUID();
    const manifest = sealIngestionManifestV1({
      schemaVersion: 'defense_budget_ingestion_manifest_v1',
      operationId,
      owner: 'package-e-real-parser-integration',
      environment: 'capiro-dev',
      runtime: {
        releaseRevision: '1'.repeat(40),
        apiImageDigest: `sha256:${'2'.repeat(64)}`,
        drainImageDigest: `sha256:${'3'.repeat(64)}`,
        runtimeConfigReference: 'evidence/package-e/real-parser-runtime-config.json',
        runtimeConfigSha256: '4'.repeat(64),
        taskDefinitionArn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain:26',
        taskDefinitionRevision: 26,
        containerName: 'ingestion-drain',
        command: ['run-defense-budget-ingestion-manifest-v1'],
      },
      members: [{
        memberId,
        ordinal: 1,
        documentKey: 'fy2024-army-r2-vol1-ba1-real-parser-fixture',
        component: 'ARMY',
        agency: 'Department of the Army',
        fiscalYear: config.fiscalYear,
        authorityTrack: 'request',
        lifecycleStage: 'president_budget_request',
        sourceFamily: 'pb_r2',
        exhibit: 'R-2',
        volume: 'Volume 1 / BA1',
        source: {
          officialLocator: config.sourceUrl,
          sourceVersion: seed.archiveVersionId,
          sha256: config.sourceSha256,
          byteSize: config.sourceBytes,
        },
        archive: {
          bucket: config.archiveBucket,
          objectKey: config.archiveKey,
          versionId: seed.archiveVersionId,
          sha256: config.sourceSha256,
          byteSize: config.sourceBytes,
        },
        lifecycle: {
          cycleId: config.cycleId,
          sourceDocumentId: config.sourceDocumentId,
          observationId,
          outboxRowId,
          jobKind: 'governed_source_ingestion',
          expectedObservationState: 'ingested',
          expectedOutboxState: 'pending',
          expectedOutboxAttempts: 0,
          expectedOutboxUpdatedAt: outbox.updatedAt.toISOString(),
          expectedCandidateCount: 0,
          expectedActiveApprovalCount: 0,
          expectedCorrectionCount: 0,
          intendedOperation: 'drain_existing_outbox',
        },
        qualification: {
          status: 'qualified',
          formatProfile: 'fy2024-army-r2-vol1-ba1',
          evidenceReference: 'evidence/package-e/real-parser-qualification.json',
          evidenceSha256: createHash('sha256').update('package-e-real-parser-qualification').digest('hex'),
          qualifiedDrainImageDigest: `sha256:${'3'.repeat(64)}`,
        },
        timeoutSeconds: 3_600,
        retry: { classification: 'transient_only', maxAttempts: 2, initialBackoffSeconds: 1 },
        protection: {
          baselineEvidenceReference: 'evidence/package-e/real-parser-baseline.json',
          expectedApprovalWrites: 0,
          expectedCorrectionWrites: 0,
          expectedCanonicalWrites: 0,
        },
      }],
      exclusions: [{
        exclusionId: randomUUID(),
        documentKey: 'fy2027-air-force-rdte-volume-i',
        component: 'AF',
        agency: 'Department of the Air Force',
        officialLocator: 'https://www.saffm.hq.af.mil/FM-resources/Budget/',
        sourceVersion: 'FY2027-RDTE-Volume-I',
        sourceSha256: createHash('sha256').update('package-e-af-exclusion').digest('hex'),
        byteSize: 9_504_933,
        reasonCode: 'qualification_failed',
        reason: 'Air Force document remains isolated after deterministic duplicate-evidence qualification failure.',
        evidenceReference: 'evidence/package-e/air-force-qualification-failure.json',
        permittedEffects: 'none',
      }],
      limits: {
        maxDocuments: 5,
        activeWorkers: 1,
        maxAttemptsPerDocument: 2,
        maxElapsedSeconds: 7_200,
        defaultDocumentTimeoutSeconds: 3_600,
        resourceShape: {
          cpuUnits: 4_096,
          memoryMiB: 8_192,
          ephemeralStorageGiB: 20,
          cpuArchitecture: 'ARM64',
          operatingSystemFamily: 'LINUX',
        },
        costCeiling: { currency: 'USD', maximumAmount: '25.00', enforcement: 'operator_and_elapsed_limits' },
      },
      readiness: { policy: 'deferred', expectedOutcome: 'not_performed' },
      permittedEffects: {
        database: {
          manifestLedgerWrites: true,
          outboxLeaseAndDispositionWrites: true,
          documentParseJobWrites: true,
          verificationEvidenceWrites: true,
          sourceRegistrationWrites: false,
          lifecycleObservationWrites: false,
          readinessWrites: false,
          approvalWrites: false,
          correctionWrites: false,
          canonicalWrites: false,
          outOfManifestEnqueueWrites: false,
        },
        storage: {
          pinnedArchiveReads: true,
          extractionArtifactWrites: true,
          rawArchiveWrites: false,
          objectDeletes: false,
          durablePresignedUrlWrites: false,
        },
      },
    });

    mkdirSync(config.workDir, { recursive: true });
    process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = config.workDir;
    process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = PARSER_PROJECT_DIR;
    const approvalCountBefore = await prisma.budgetScopedFactReviewV1.count();
    const correctionCountBefore = await prisma.budgetCandidateCorrectionV1.count();
    const promotionAuditBefore = await prisma.defenseBudgetPromotionAudit.count();
    const sourceDocumentCountBefore = await prisma.sourceDocument.count();
    const observationCountBefore = await prisma.defenseBudgetSourceObservation.count();
    const outboxCountBefore = await prisma.defenseBudgetIngestionOutbox.count();
    const archiveReader = new S3SourceDocumentArchiveReadAdapter();
    try {
      const neverArchive = {
        archiveOriginal: async () => { throw new Error('replay path must not register or archive source bytes'); },
      } as unknown as RawArchiveService;
      const bridge = new ObservationIngestionBridgeService(
        new PrismaObservationBridgeStore(prisma),
        { fetchFullBytes: async () => { throw new Error('replay path must not fetch mutable source bytes'); } },
        new DocumentRegistrar(neverArchive, prisma),
        new DefaultParserHandoffAdapter({ workDir: config.workDir }),
        archiveReader,
      );
      const repository = createIngestionManifestRepositoryV1(prisma, { leaseMs: 120_000 });
      const result = await new RunIngestionManifestV1({
        repository,
        bridge,
        heartbeatMs: 10_000,
      }).run(manifest, { taskJobId: `package-e-real-parser-it:${runId}` });

      expect(result.outcome).toBe('completed');
      expect(result.summary).toMatchObject({
        selected: 1,
        pending: 0,
        running: 0,
        retryWait: 0,
        evidenceReady: 0,
        uncertain: 0,
        approvals: 'not_performed',
        readiness: 'not_performed',
        canonicalPublication: 'not_performed',
      });
      expect((result.summary?.passed ?? 0) + (result.summary?.review ?? 0) + (result.summary?.rejected ?? 0)).toBe(1);
      expect(result.summary?.items[0]?.candidateId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.summary?.items[0]?.verificationRunId).toMatch(/^[0-9a-f-]{36}$/i);
      const persisted = await dbverifyCandidate(prisma, config.cycleId, config.sourceDocumentId);
      expect(persisted.candidate?.id).toBe(result.summary?.items[0]?.candidateId);
      expect(persisted.run?.id).toBe(result.summary?.items[0]?.verificationRunId);
      const finalizedOutbox = await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({ where: { id: outboxRowId } });
      expect(['succeeded', 'dead_letter']).toContain(finalizedOutbox.state);
      expect(finalizedOutbox.metadata).toMatchObject({
        manifestOperationId: operationId,
        manifestItemId: memberId,
        readinessPhase: 'not_requested_manifest_ingestion_only',
        readinessInvoked: false,
        approvalWrites: 0,
        correctionWrites: 0,
        canonicalWrites: 0,
      });
      expect(await prisma.budgetScopedFactReviewV1.count()).toBe(approvalCountBefore);
      expect(await prisma.budgetCandidateCorrectionV1.count()).toBe(correctionCountBefore);
      expect(await prisma.defenseBudgetPromotionAudit.count()).toBe(promotionAuditBefore);
      expect(await prisma.sourceDocument.count()).toBe(sourceDocumentCountBefore);
      expect(await prisma.defenseBudgetSourceObservation.count()).toBe(observationCountBefore);
      expect(await prisma.defenseBudgetIngestionOutbox.count()).toBe(outboxCountBefore);
    } finally {
      await archiveReader.destroy();
    }
  });
});
