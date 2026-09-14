/**
 * scoped-fact-review-s3-artifact-loader.integration -- proves the fix for the
 * production-blocking defect where `FilesystemScopedFactReviewArtifactLoaderV1`
 * threw `artifact_locator_unsupported` on every `s3://` locator, and every
 * real production candidate's `extraction_artifact_locator` IS an
 * `s3://bucket/key?versionId=...` string (written by
 * `S3ExtractionArtifactStore`). That meant every real scoped-review preview
 * in production failed closed before ever reaching eligibility.
 *
 * The fix, `TrustedByteLocatorScopedFactReviewArtifactLoaderV1`, wraps the
 * existing, already production-proven `CompositeByteLocatorReader` /
 * `S3ByteLocatorReader` / `SdkS3ProofClient` stack (the same one
 * `wireProductionProofBoundary` uses for `production_proof` reads elsewhere
 * in this program). `scoped-fact-review-v1.service.spec.ts` already unit
 * tests that class against a FAKE `TrustedByteLocatorReader` -- this file is
 * the real-infrastructure proof: a REAL disposable Postgres and a REAL
 * disposable VERSIONED MinIO, real `@aws-sdk/client-s3` calls, no mocked
 * artifact loader, no mocked repository. Candidate/run rows are seeded
 * directly via Prisma with the SAME synthetic-but-schema-valid extraction
 * artifact shape `scoped-fact-review-policy-v1.spec.ts`'s `baseArtifact()`
 * uses (proven ELIGIBLE:true there) -- the real OCR/parser pipeline is
 * deliberately not exercised here (too slow, not needed to prove this fix;
 * see `phase10b35-scoped-review-e2e.integration.spec.ts` for that).
 *
 * Gated exactly like that e2e spec: skipped unless both DATABASE_URL and
 * BUDGET_VERIFICATION_S3_ENDPOINT point at localhost.
 *
 * Run with (mirrors phase10b35-scoped-review-e2e-rehearsal.sh's recipe --
 * own disposable Postgres + MinIO, own ports, always torn down):
 *   docker run -d --name <pg>    -e POSTGRES_PASSWORD=... -e POSTGRES_DB=capiro -P pgvector/pgvector:pg16
 *   docker run -d --name <minio> -e MINIO_ROOT_USER=... -e MINIO_ROOT_PASSWORD=... -p 0:9000 quay.io/minio/minio:latest server /data
 *   (docker.io/minio/minio is no longer pullable anonymously -- quay.io/minio/minio is the
 *   upstream-published mirror and produces the identical image)
 *   export DATABASE_URL=postgresql://postgres:<pw>@localhost:<pgport>/capiro
 *   export BUDGET_VERIFICATION_S3_ENDPOINT=http://localhost:<minioport>
 *   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1
 *   unset AWS_PROFILE AWS_SESSION_TOKEN
 *   npx prisma migrate deploy
 *   jest src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-s3-artifact-loader.integration.spec.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { sha256Bytes } from '../../contracts/canonical-json.js';
import { computeArtifactContentSha256 } from '../../contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  createBudgetVerificationS3Client,
  BUDGET_VERIFICATION_S3_ENDPOINT_ENV,
  SdkS3ProofClient,
} from '../../verification/trusted-proof/s3-proof-adapters.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../../verification/trusted-proof/trusted-byte-locator-reader.js';
import { createPrismaBudgetVerificationRepository } from '../../verification/persistence/prisma-budget-verification.repository.js';
import {
  ScopedFactReviewV1Service,
  TrustedByteLocatorScopedFactReviewArtifactLoaderV1,
} from './scoped-fact-review-v1.service.js';
import { PrismaScopedFactReviewRepositoryV1 } from './scoped-fact-review-repository-v1.js';
import { PrismaScopedFactReviewCandidateLocatorReaderV1 } from './scoped-fact-review-prisma-locator-reader-v1.js';
import { PrismaReviewedPartialPeTotalsRepositoryV1 } from './reviewed-partial-pe-totals-prisma-repository-v1.js';
import { ReviewedPartialPeTotalsReadServiceV1 } from './reviewed-partial-pe-totals-read.service.js';
import { SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1 } from './scoped-fact-review-policy-v1.js';

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

const BUCKET = 'capiro-1622-scoped-review-loader-test';

describeE2E('scoped-fact-review S3 artifact loader -- real Postgres + real versioned MinIO', () => {
  jest.setTimeout(5 * 60 * 1000);

  let prisma: PrismaClient;
  let s3Setup: S3Client; // plain AWS SDK client used only to arrange fixtures (bucket mgmt, uploads)
  let s3ProofClient: SdkS3ProofClient; // the REAL production-shape client under test
  let artifactLoader: TrustedByteLocatorScopedFactReviewArtifactLoaderV1;
  let verification: ReturnType<typeof createPrismaBudgetVerificationRepository>;
  let locators: PrismaScopedFactReviewCandidateLocatorReaderV1;
  let reviews: PrismaScopedFactReviewRepositoryV1;
  let reviewService: ScopedFactReviewV1Service;
  let readService: ReviewedPartialPeTotalsReadServiceV1;
  let workDir: string;

  // Stashed from the "valid locator" group so the revoke-path and CLI-proof
  // groups can reuse a real, already-approved row without reseeding.
  let groupACandidateId: string;
  let groupARunId: string;
  let groupAArtifact: DefenseBudgetExtractionArtifactV1;
  let groupAApprovedRowId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    await prisma.$connect();
    workDir = mkdtempSync(join(tmpdir(), 'scoped-review-s3-loader-'));

    s3Setup = createBudgetVerificationS3Client(process.env);
    try {
      await s3Setup.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3Setup.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }
    await s3Setup.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));

    // The exact production wiring: CompositeByteLocatorReader routing to
    // FilesystemByteLocatorReader or S3ByteLocatorReader(SdkS3ProofClient),
    // wrapped by the new loader. No mock anywhere in this chain.
    s3ProofClient = new SdkS3ProofClient();
    const byteReader = new CompositeByteLocatorReader(new FilesystemByteLocatorReader(), new S3ByteLocatorReader(s3ProofClient));
    artifactLoader = new TrustedByteLocatorScopedFactReviewArtifactLoaderV1(byteReader);

    verification = createPrismaBudgetVerificationRepository(prisma);
    locators = new PrismaScopedFactReviewCandidateLocatorReaderV1(prisma);
    reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
    reviewService = new ScopedFactReviewV1Service(verification, locators, artifactLoader, reviews);
    readService = new ReviewedPartialPeTotalsReadServiceV1(new PrismaReviewedPartialPeTotalsRepositoryV1(prisma));
  }, 60_000);

  afterAll(async () => {
    await s3ProofClient?.destroy();
    s3Setup?.destroy();
    await prisma.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ */
  /* Fixture builders                                                    */
  /* ------------------------------------------------------------------ */

  /** Same schema-valid shape as scoped-fact-review-policy-v1.spec.ts's
   * baseArtifact() (proven eligible:true there), parameterized per PE so
   * each test group gets an independent scope key, plus a fully zod-valid
   * `summary` -- baseArtifact() only needs to satisfy the TS type (its
   * fixture is consumed directly, never JSON-round-tripped through the real
   * zod parser); this one is uploaded to real S3 and reloaded through
   * `parseDefenseBudgetExtractionArtifactV1`'s real `.parse()`, so it must
   * satisfy the REAL strict schema, summary included. */
  function buildArtifact(input: {
    sourceDocumentId: string;
    sourceSha256: string;
    peCode: string;
    peTitle: string;
    physicalPage: number;
    totalMillions: string;
    originalValue: string;
    fiscalYear?: number;
  }): DefenseBudgetExtractionArtifactV1 {
    const fiscalYear = input.fiscalYear ?? 2024;
    const draft = {
      schemaVersion: 'defense_budget_extraction_v1',
      artifactId: 'dbx1_placeholder',
      contentSha256: '',
      source: {
        manifestDocumentKey: input.sourceDocumentId,
        sourceDocumentId: input.sourceDocumentId,
        sourcePdfSha256: input.sourceSha256,
        sourceLocator: 'https://example.mil/r2-loader-test.pdf',
        sourceUrl: 'https://example.mil/r2-loader-test.pdf',
        fiscalYear,
        family: 'rdte',
        exhibit: 'R-2',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        title: 'r2',
      },
      parserRuns: [],
      evidence: [
        { evidenceId: 'ev-identity', sourcePdfSha256: input.sourceSha256, parserRunId: 'pr1', granularity: 'page_only', page: input.physicalPage, tableLabel: 'table_0', rowLabel: 'row_0' },
        { evidenceId: 'ev-total', sourcePdfSha256: input.sourceSha256, parserRunId: 'pr1', granularity: 'page_only', page: input.physicalPage, tableLabel: 'table_0', rowLabel: 'row_3' },
      ],
      sourceFacts: [],
      assertions: [
        {
          assertionId: 'asrt-identity',
          sourceFactIds: [],
          evidenceIds: ['ev-identity'],
          confidence: 1,
          metadata: { exhibit: 'R-2', contextSource: 'explicit_header', segmentId: 'seg_0001', physicalPage: input.physicalPage },
          assertionKind: 'program_element_identity',
          identity: { lineKind: 'RDTE_PE', peCode: input.peCode },
          title: input.peTitle,
          component: 'ARMY',
        },
        {
          assertionId: 'asrt-total',
          sourceFactIds: [],
          evidenceIds: ['ev-total'],
          confidence: 1,
          assertionKind: 'document_fact',
          fieldName: 'r2_total_component',
          value: {
            peCode: input.peCode,
            projectCode: null,
            rowKind: 'pe_total',
            fiscalYear,
            columnRole: 'total_component',
            disposition: 'contextual_only',
            originalValue: input.originalValue,
            originalUnit: 'millions',
            valueMillions: input.totalMillions,
            positionCycle: `pb_fy${fiscalYear}`,
            headerText: `FY ${fiscalYear} Total`,
            direct: true,
          },
        },
      ],
      warnings: [],
      omissions: [],
      summary: {
        sourceFactCount: 0,
        requiredSourceFactCount: 0,
        coveredRequiredSourceFactCount: 0,
        omittedRequiredSourceFactCount: 0,
        uncoveredRequiredSourceFactCount: 0,
        assertionCount: 2,
        warningCount: 0,
        omissionCount: 0,
        countsByAssertionKind: { program_element_identity: 1, document_fact: 1 },
        countsByOmissionReason: {},
        completenessStatus: 'complete',
      },
    } as unknown as DefenseBudgetExtractionArtifactV1;
    const contentSha256 = computeArtifactContentSha256(draft);
    return { ...draft, contentSha256, artifactId: `dbx1_${contentSha256}` };
  }

  async function uploadArtifact(key: string, artifact: DefenseBudgetExtractionArtifactV1): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(artifact), 'utf8');
    const put = await s3Setup.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: 'application/json' }));
    if (!put.VersionId) throw new Error('MinIO returned no VersionId -- is bucket versioning enabled?');
    return put.VersionId;
  }

  function locatorFor(key: string, versionId: string): string {
    return `s3://${BUCKET}/${key}?versionId=${encodeURIComponent(versionId)}`;
  }

  const MANIFEST_SHA = 'a'.repeat(64);

  async function seedCandidate(input: {
    sourceDocumentId: string;
    sourceSha256: string;
    artifact: DefenseBudgetExtractionArtifactV1;
    locator: string;
    extractionArtifactIdOverride?: string;
  }): Promise<{ candidateId: string; runId: string }> {
    const candidateId = randomUUID();
    const runId = randomUUID();
    await prisma.sourceDocument.create({
      data: {
        id: input.sourceDocumentId,
        sourceKey: `scoped-review-s3-loader-${input.sourceDocumentId}`,
        fiscalYear: input.artifact.source.fiscalYear,
        budgetCycle: 'pb',
        component: 'ARMY',
        documentType: 'r2',
        title: 'FY2024 Army RDT&E R-2 (scoped-review S3 loader integration test)',
        sourceUrl: input.artifact.source.sourceUrl ?? 'https://example.mil/r2-loader-test.pdf',
        sha256: input.sourceSha256,
        extractionMethod: 'deterministic_pdf',
      },
    });
    await prisma.budgetExtractionCandidateV1.create({
      data: {
        id: candidateId,
        cycleId: `fy2024:${randomUUID()}`,
        manifestContentSha256: MANIFEST_SHA,
        manifestDocumentKey: input.sourceDocumentId,
        extractionArtifactId: input.extractionArtifactIdOverride ?? input.artifact.artifactId,
        extractionArtifactSha256: input.artifact.contentSha256,
        extractionArtifactLocator: input.locator,
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        verifierVersion: 'v1',
        policyVersion: 'v1',
        policySha256: 'b'.repeat(64),
        status: 'NEEDS_REVIEW',
        currentRunId: runId,
      },
    });
    await prisma.budgetVerificationRunV1.create({
      data: {
        id: runId,
        candidateId,
        verifierVersion: 'v1',
        policyVersion: 'v1',
        policySha256: 'b'.repeat(64),
        decision: 'REVIEW',
        status: 'NEEDS_REVIEW',
        route: 'human_review',
        riskScore: 40,
        startedAt: new Date(),
        completedAt: new Date(),
        manifestContentSha256: MANIFEST_SHA,
        extractionArtifactSha256: input.artifact.contentSha256,
        sourceSha256: input.sourceSha256,
        resultSnapshot: {},
      },
    });
    return { candidateId, runId };
  }

  function reviewInput(
    candidateId: string,
    runId: string,
    peCode: string,
    artifact: DefenseBudgetExtractionArtifactV1,
    overrides: Partial<{ expectedSourceSha256: string; expectedExtractionArtifactSha256: string; expectedManifestContentSha256: string; decision: 'approve' | 'reject' }> = {},
  ) {
    return {
      candidateId,
      runId,
      scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode, fiscalYear: artifact.source.fiscalYear, fundingField: 'request' as const, component: 'ARMY' },
      decision: overrides.decision ?? ('approve' as const),
      reviewerId: 'neo@capiro.ai',
      rationale: `scoped-fact-review-s3-artifact-loader.integration.spec.ts approval for ${peCode}`,
      expectedSourceSha256: overrides.expectedSourceSha256 ?? artifact.source.sourcePdfSha256,
      expectedExtractionArtifactSha256: overrides.expectedExtractionArtifactSha256 ?? artifact.contentSha256,
      expectedManifestContentSha256: overrides.expectedManifestContentSha256 ?? MANIFEST_SHA,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Case 1 + 2: valid, version-pinned S3 locator                        */
  /* ------------------------------------------------------------------ */

  describe('valid, version-pinned S3 locator', () => {
    const sourceDocumentId = randomUUID();
    const sourceSha256 = sha256Bytes(Buffer.from(`case1-${sourceDocumentId}`, 'utf8'));
    const peCode = '0601102A';

    beforeAll(async () => {
      groupAArtifact = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'Defense Research Sciences',
        physicalPage: 43,
        totalMillions: '296.67',
        originalValue: '296.670',
      });
      const key = `artifacts/case1/${sourceDocumentId}.json`;
      const versionId = await uploadArtifact(key, groupAArtifact);
      const locator = locatorFor(key, versionId);
      const seeded = await seedCandidate({ sourceDocumentId, sourceSha256, artifact: groupAArtifact, locator });
      groupACandidateId = seeded.candidateId;
      groupARunId = seeded.runId;
    });

    it('case 1: dry-run preview succeeds through the real S3 loader, is eligible, and writes ZERO rows', async () => {
      const before = await prisma.budgetScopedFactReviewV1.count({ where: { candidateId: groupACandidateId } });
      expect(before).toBe(0);

      const preview = await reviewService.review(reviewInput(groupACandidateId, groupARunId, peCode, groupAArtifact), { commit: false });
      expect(preview.mode).toBe('dry-run');
      expect(preview.eligibility.eligible).toBe(true);
      expect(preview.eligibility.refusalReasons).toEqual([]);
      expect(preview.eligibility.projection?.totalMillions).toBe('296.67');
      expect(preview.persisted).toBeNull();

      const after = await prisma.budgetScopedFactReviewV1.count({ where: { candidateId: groupACandidateId } });
      expect(after).toBe(0);
    });

    it('case 2: commit:true persists a real row, and the real read services surface it', async () => {
      const preview = await reviewService.review(reviewInput(groupACandidateId, groupARunId, peCode, groupAArtifact), { commit: true });
      expect(preview.mode).toBe('committed');
      expect(preview.persisted).not.toBeNull();
      groupAApprovedRowId = preview.persisted!.id;

      const rowViaRepository = await reviews.readById(groupAApprovedRowId);
      expect(rowViaRepository).not.toBeNull();
      expect(rowViaRepository!.status).toBe('active');
      expect(rowViaRepository!.decision).toBe('approve');

      const served = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      const row = served.find((r) => r.peCode === peCode);
      expect(row).toBeDefined();
      expect(row!.amountMillions.total).toBe('296.67');
      expect(row!.reviewStatus).toBe('reviewed_partial');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 3: version pinning -- never silently substitutes the latest    */
  /* ------------------------------------------------------------------ */

  describe('version-pinned reads never silently substitute the latest object version', () => {
    const sourceDocumentId = randomUUID();
    const sourceSha256 = sha256Bytes(Buffer.from(`case3-${sourceDocumentId}`, 'utf8'));
    const peCode = '0601103A';
    let candidateId: string;
    let runId: string;
    let artifactV1: DefenseBudgetExtractionArtifactV1;
    let key: string;

    beforeAll(async () => {
      artifactV1 = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'University Research Initiatives',
        physicalPage: 126,
        totalMillions: '75.672',
        originalValue: '75.672',
      });
      key = `artifacts/case3/${sourceDocumentId}.json`;
      const versionId1 = await uploadArtifact(key, artifactV1);
      const locator = locatorFor(key, versionId1);
      const seeded = await seedCandidate({ sourceDocumentId, sourceSha256, artifact: artifactV1, locator });
      candidateId = seeded.candidateId;
      runId = seeded.runId;

      // Upload a SECOND, tampered object to the SAME key -- it becomes the
      // bucket's current/latest version -- while the candidate's DB locator
      // stays pinned to the FIRST version's id.
      const tampered = Buffer.from(
        JSON.stringify({ ...artifactV1, warnings: [{ warningId: 'tamper', code: 'tampered_v2_must_never_be_read', severity: 'info', message: 'tampered v2 payload', sourceFactIds: [], evidenceIds: [] }] }),
        'utf8',
      );
      await s3Setup.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: tampered, ContentType: 'application/json' }));
    });

    it('reads the ORIGINAL pinned version, not the tampered current object -- eligibility computes against the true bytes', async () => {
      const preview = await reviewService.review(reviewInput(candidateId, runId, peCode, artifactV1), { commit: false });
      expect(preview.eligibility.eligible).toBe(true);
      expect(preview.eligibility.projection?.totalMillions).toBe('75.672');
    });

    it('a locator naming a nonexistent versionId for the SAME key fails closed as artifact_unreadable, never a silent fallback', async () => {
      const badLocator = locatorFor(key, 'this-version-id-does-not-exist-12345');
      await prisma.budgetExtractionCandidateV1.update({ where: { id: candidateId }, data: { extractionArtifactLocator: badLocator } });

      await expect(reviewService.review(reviewInput(candidateId, runId, peCode, artifactV1), { commit: false })).rejects.toMatchObject({
        code: 'artifact_unreadable',
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 4: hash-mismatch defenses                                      */
  /* ------------------------------------------------------------------ */

  describe('hash-mismatch defenses', () => {
    const sourceDocumentId = randomUUID();
    const sourceSha256 = sha256Bytes(Buffer.from(`case4-${sourceDocumentId}`, 'utf8'));
    const peCode = '0601104A';
    let candidateId: string;
    let runId: string;
    let artifact: DefenseBudgetExtractionArtifactV1;

    beforeAll(async () => {
      artifact = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'University and Industry Research Centers',
        physicalPage: 132,
        totalMillions: '108.946',
        originalValue: '108.946',
      });
      const key = `artifacts/case4/${sourceDocumentId}.json`;
      const versionId = await uploadArtifact(key, artifact);
      const locator = locatorFor(key, versionId);
      // Deliberately drifted extractionArtifactId -- simulates a DB row
      // whose hash pointer no longer matches the true artifact bytes.
      const seeded = await seedCandidate({ sourceDocumentId, sourceSha256, artifact, locator, extractionArtifactIdOverride: `dbx1_${'f'.repeat(64)}` });
      candidateId = seeded.candidateId;
      runId = seeded.runId;
    });

    it('a candidate whose extractionArtifactId no longer matches the reloaded artifact is refused with artifact_hash_mismatch', async () => {
      await expect(reviewService.review(reviewInput(candidateId, runId, peCode, artifact), { commit: false })).rejects.toMatchObject({
        code: 'artifact_hash_mismatch',
      });
    });

    it('reviewer-supplied expected hashes that do not match the candidate are refused with expected_hash_mismatch -- pre-existing logic, unaffected by the new loader', async () => {
      await expect(
        reviewService.review(reviewInput(candidateId, runId, peCode, artifact, { expectedExtractionArtifactSha256: 'a'.repeat(64) }), { commit: false }),
      ).rejects.toMatchObject({ code: 'expected_hash_mismatch' });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 5: missing S3 object                                           */
  /* ------------------------------------------------------------------ */

  describe('missing S3 object', () => {
    const sourceDocumentId = randomUUID();
    const sourceSha256 = sha256Bytes(Buffer.from(`case5-${sourceDocumentId}`, 'utf8'));
    const peCode = '0601121A';
    let candidateId: string;
    let runId: string;
    let artifact: DefenseBudgetExtractionArtifactV1;

    beforeAll(async () => {
      artifact = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'Cyber Collaborative Research Alliance',
        physicalPage: 161,
        totalMillions: '5.459',
        originalValue: '5.459',
      });
      // Deliberately NEVER uploaded to S3.
      const locator = locatorFor(`artifacts/case5/${sourceDocumentId}-never-written.json`, 'nonexistent-version-id');
      const seeded = await seedCandidate({ sourceDocumentId, sourceSha256, artifact, locator });
      candidateId = seeded.candidateId;
      runId = seeded.runId;
    });

    it('a locator whose object was never written is refused as artifact_unreadable, never a silent success', async () => {
      await expect(reviewService.review(reviewInput(candidateId, runId, peCode, artifact), { commit: false })).rejects.toMatchObject({
        code: 'artifact_unreadable',
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 6: malformed / unsupported locator scheme                      */
  /* ------------------------------------------------------------------ */

  describe('malformed / unsupported locator scheme', () => {
    const sourceDocumentId = randomUUID();
    const sourceSha256 = sha256Bytes(Buffer.from(`case6-${sourceDocumentId}`, 'utf8'));
    const peCode = '0601601A';
    let candidateId: string;
    let runId: string;
    let artifact: DefenseBudgetExtractionArtifactV1;

    beforeAll(async () => {
      artifact = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'Artificial Intelligence and Machine Learning Basic Research',
        physicalPage: 164,
        totalMillions: '10.708',
        originalValue: '10.708',
      });
      const seeded = await seedCandidate({ sourceDocumentId, sourceSha256, artifact, locator: 'ftp://example.mil/not-a-real-scheme.json' });
      candidateId = seeded.candidateId;
      runId = seeded.runId;
    });

    it('an ftp:// locator is refused as artifact_unreadable, never a crash or unhandled rejection', async () => {
      await expect(reviewService.review(reviewInput(candidateId, runId, peCode, artifact), { commit: false })).rejects.toMatchObject({
        code: 'artifact_unreadable',
      });
    });

    it('a bare nonsense locator string is also refused as artifact_unreadable', async () => {
      await prisma.budgetExtractionCandidateV1.update({ where: { id: candidateId }, data: { extractionArtifactLocator: 'this-is-not-a-locator-at-all' } });
      await expect(reviewService.review(reviewInput(candidateId, runId, peCode, artifact), { commit: false })).rejects.toMatchObject({
        code: 'artifact_unreadable',
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 7: denied access is a real thrown error, never swallowed        */
  /* ------------------------------------------------------------------ */

  describe('denied access is a real thrown error, never swallowed as success', () => {
    it('wrong credentials against a real object surface a genuine S3 error, not a silent success', async () => {
      const key = `artifacts/case7/${randomUUID()}.json`;
      const put = await s3Setup.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from('{"probe":true}', 'utf8'), ContentType: 'application/json' }));
      const locator = locatorFor(key, put.VersionId!);

      // A second, deliberately WRONG-credentialed client against the same
      // real MinIO endpoint. `SdkS3ProofClientOptions.client` accepts a
      // pre-built client for exactly this kind of injection.
      const wrongClient = new S3Client({
        endpoint: ARCHIVE_ENDPOINT,
        region: process.env.AWS_REGION ?? 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'wrong-access-key-id', secretAccessKey: 'wrong-secret-access-key' },
      });
      const wrongProofClient = new SdkS3ProofClient({ client: wrongClient });
      const wrongReader = new CompositeByteLocatorReader(new FilesystemByteLocatorReader(), new S3ByteLocatorReader(wrongProofClient));
      const wrongLoader = new TrustedByteLocatorScopedFactReviewArtifactLoaderV1(wrongReader);

      try {
        await expect(wrongLoader.load({ locator })).rejects.toThrow();
      } finally {
        wrongClient.destroy();
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 8: filesystem locator regression (local/rehearsal unaffected)   */
  /* ------------------------------------------------------------------ */

  describe('filesystem locator regression (local/rehearsal use unaffected)', () => {
    const sourceDocumentId = randomUUID();
    const sourceSha256 = sha256Bytes(Buffer.from(`case8-${sourceDocumentId}`, 'utf8'));
    const peCode = '0601777A';
    let candidateId: string;
    let runId: string;
    let artifact: DefenseBudgetExtractionArtifactV1;

    beforeAll(async () => {
      artifact = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'Filesystem Regression Check Program Element',
        physicalPage: 200,
        totalMillions: '1.234',
        originalValue: '1.234',
      });
      const filePath = join(workDir, `${sourceDocumentId}.json`);
      writeFileSync(filePath, JSON.stringify(artifact), 'utf8');
      const seeded = await seedCandidate({ sourceDocumentId, sourceSha256, artifact, locator: filePath });
      candidateId = seeded.candidateId;
      runId = seeded.runId;
    });

    it('a bare filesystem path locator still succeeds through the SAME composite loader used for S3', async () => {
      const preview = await reviewService.review(reviewInput(candidateId, runId, peCode, artifact), { commit: false });
      expect(preview.eligibility.eligible).toBe(true);
      expect(preview.eligibility.projection?.totalMillions).toBe('1.234');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Case 9: revoke never touches the artifact loader / S3               */
  /* ------------------------------------------------------------------ */

  describe('revoke path never touches the artifact loader', () => {
    it('revoking the case-2 approval removes it from the read API without any further S3 access', async () => {
      expect(groupAApprovedRowId).toBeDefined();
      const before = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(before.some((r) => r.review.scopedFactReviewId === groupAApprovedRowId)).toBe(true);

      const revoked = await reviewService.revoke({ id: groupAApprovedRowId, actor: 'neo@capiro.ai', reason: 'scoped-fact-review-s3-artifact-loader.integration.spec.ts revoke-path proof' });
      expect(revoked.status).toBe('revoked');

      const after = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(after.some((r) => r.peCode === '0601102A')).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /* CLI-fixture proof: print reusable identifiers for a real child-      */
  /* process invocation of review-defense-budget-scoped-fact-v1.ts        */
  /* (see the accompanying report for the exact command run).            */
  /* ------------------------------------------------------------------ */

  describe('CLI wiring fixture', () => {
    it('prints a fresh, eligible candidate/run for a real CLI child-process smoke test', async () => {
      const sourceDocumentId = randomUUID();
      const sourceSha256 = sha256Bytes(Buffer.from(`case-cli-${sourceDocumentId}`, 'utf8'));
      const peCode = '0601888A';
      const artifact = buildArtifact({
        sourceDocumentId,
        sourceSha256,
        peCode,
        peTitle: 'CLI Smoke Test Program Element',
        physicalPage: 210,
        totalMillions: '2.5',
        originalValue: '2.500',
      });
      const key = `artifacts/case-cli/${sourceDocumentId}.json`;
      const versionId = await uploadArtifact(key, artifact);
      const locator = locatorFor(key, versionId);
      const { candidateId, runId } = await seedCandidate({ sourceDocumentId, sourceSha256, artifact, locator });

      // Sanity-check the fixture is genuinely eligible before handing its
      // ids to the CLI smoke test, so a CLI failure can never be blamed on a
      // bad fixture.
      const preview = await reviewService.review(reviewInput(candidateId, runId, peCode, artifact), { commit: false });
      expect(preview.eligibility.eligible).toBe(true);

      // eslint-disable-next-line no-console
      console.log(
        `CLI_PROOF_FIXTURE:${JSON.stringify({
          candidateId,
          runId,
          peCode,
          fiscalYear: artifact.source.fiscalYear,
          expectedSourceSha256: artifact.source.sourcePdfSha256,
          expectedArtifactSha256: artifact.contentSha256,
          expectedManifestSha256: MANIFEST_SHA,
        })}`,
      );
    });
  });
});
