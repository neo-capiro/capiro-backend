/**
 * Phase 10B-35c -- end-to-end isolation proof: a corrected re-verification
 * candidate is formally linked as the correction of an older, tainted
 * candidate, through the REAL production code path, against a disposable
 * Postgres and a disposable versioned MinIO archive -- modeled directly on
 * `../scoped-fact-review/phase10b35-scoped-review-e2e.integration.spec.ts`
 * (same fixture, same real handoff adapter, same real services).
 *
 * The CORE scenario below models the actual production situation this
 * mechanism was built for: real production candidate `5522ea3b…` is
 * `NEEDS_REVIEW`, produced by the pre-fix parser, and (per the Phase 10B-35
 * packet) currently has ZERO active scoped-fact-review approvals. Two real
 * handoffs of the SAME archived fixture through the (already-fixed, on this
 * branch) parser produce two genuinely distinct candidates that this test
 * treats as "old" and "new" -- the mechanism itself does not care WHICH
 * parser version produced either row, only that they share source identity
 * and that old's status is correctable. Before running the correction, the
 * OLD candidate is given a real scoped approval (via the already-proven
 * `ScopedFactReviewV1Service`) so the SAME real handoffs also prove the
 * "old candidate DID have an active approval" case end to end, without a
 * third expensive real parser run.
 *
 * The remaining scenarios (wrong-status refusal, source-mismatch refusal,
 * and the concurrency race) do not need the real parser/paddleocr pipeline
 * at all -- `CandidateCorrectionV1Service` only ever reads candidate
 * identity/status via `BudgetVerificationRepositoryV1.readCandidate`, never
 * the extraction artifact -- so those use directly-inserted, real Postgres
 * rows in the SAME disposable database for speed. This is a deliberate
 * scoping choice: the expensive real pipeline proves the mechanism against
 * genuine production-shaped data for the scenario that matters (5522ea3b's
 * actual shape); the cheap real-DB rows prove the mechanism's own boundary
 * conditions against the real schema, real triggers, and real unique
 * indexes -- never against a mocked Prisma client.
 *
 * Run with (self-provisions and tears down its own Postgres + MinIO):
 *   pnpm --filter @capiro/api run verify:phase10b35c-candidate-correction-e2e:db
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { sha256Bytes } from '../../contracts/canonical-json.js';
import { DefaultParserHandoffAdapter } from '../../default-parser-handoff.adapter.js';
import { createBudgetVerificationS3Client, BUDGET_VERIFICATION_S3_ENDPOINT_ENV } from '../../verification/trusted-proof/s3-proof-adapters.js';
import { createPrismaBudgetVerificationRepository } from '../../verification/persistence/prisma-budget-verification.repository.js';
import {
  ScopedFactReviewV1Service,
  type ScopedFactReviewArtifactLoaderV1,
  type ScopedFactReviewCandidateLocatorReaderV1,
} from '../scoped-fact-review/scoped-fact-review-v1.service.js';
import { PrismaScopedFactReviewRepositoryV1 } from '../scoped-fact-review/scoped-fact-review-repository-v1.js';
import { PrismaReviewedPartialPeTotalsRepositoryV1 } from '../scoped-fact-review/reviewed-partial-pe-totals-prisma-repository-v1.js';
import { ReviewedPartialPeTotalsReadServiceV1 } from '../scoped-fact-review/reviewed-partial-pe-totals-read.service.js';
import { SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, scopedFactReviewScopeKeyV1 } from '../scoped-fact-review/scoped-fact-review-policy-v1.js';
import { CandidateCorrectionV1Service, CandidateCorrectionError } from './candidate-correction-v1.service.js';
import { PrismaCandidateCorrectionRepositoryV1 } from './candidate-correction-repository-v1.js';

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
  '..',
  'rdte',
  'cycle',
  '__fixtures__',
  'production-fy2024-army-r2-vol1-ba1-official.pdf',
);
const REAL_R2_FIXTURE_SHA256 = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const ISOLATED_ARCHIVE_BUCKET = 'capiro-phase10b35c-isolated-archive';
const TARGET_PE = { peCode: '0601102A', title: 'Defense Research Sciences', total: '296.67', page: 43 };

function fakeHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

class FilesystemArtifactLoader implements ScopedFactReviewArtifactLoaderV1 {
  async load(input: { locator: string }): Promise<Buffer> {
    return readFileSync(input.locator);
  }
}
class PrismaLocatorReader implements ScopedFactReviewCandidateLocatorReaderV1 {
  constructor(private readonly prisma: PrismaClient) {}
  async readExtractionArtifactLocator(candidateId: string): Promise<string | null> {
    const row = await this.prisma.budgetExtractionCandidateV1.findFirst({
      where: { id: candidateId },
      select: { extractionArtifactLocator: true },
    });
    return row?.extractionArtifactLocator ?? null;
  }
}

describeE2E('Phase 10B-35c -- candidate correction: real link, real supersession, real serving boundary (isolated Postgres + MinIO)', () => {
  jest.setTimeout(20 * 60 * 1000);

  let prisma: PrismaClient;
  let s3: S3Client;
  let outerDir: string;
  let parserArtifactRoot: string;
  let workDir: string;
  let pdfBytes: Buffer;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    await prisma.$connect();

    outerDir = mkdtempSync(join(tmpdir(), 'phase10b35c-e2e-'));
    parserArtifactRoot = join(outerDir, 'parser-artifact-root');
    mkdirSync(parserArtifactRoot, { recursive: true });
    process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = parserArtifactRoot;
    const parserProjectDir = join(__dirname, '..', '..', '..', '..', '..', 'defense-budget-parser');
    process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = parserProjectDir;
    const resolved = execFileSync('uv', ['run', '--no-sync', 'python', '-c', 'import capiro_defense_budget_parser as p; print(p.__file__)'], {
      cwd: parserProjectDir,
      encoding: 'utf8',
    }).trim();
    if (!resolved.replace(/\\/g, '/').includes(parserProjectDir.replace(/\\/g, '/'))) {
      throw new Error(`parser runtime resolved outside this worktree: ${resolved} (expected under ${parserProjectDir})`);
    }
    workDir = join(parserArtifactRoot, 'work');
    mkdirSync(workDir, { recursive: true });

    if (!existsSync(REAL_R2_FIXTURE_PATH)) throw new Error(`missing real-PDF fixture at ${REAL_R2_FIXTURE_PATH}`);
    pdfBytes = readFileSync(REAL_R2_FIXTURE_PATH);
    const sha = sha256Bytes(pdfBytes);
    if (sha !== REAL_R2_FIXTURE_SHA256) throw new Error(`real-PDF fixture SHA drifted: expected ${REAL_R2_FIXTURE_SHA256}, got ${sha}`);

    s3 = createBudgetVerificationS3Client(process.env);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: ISOLATED_ARCHIVE_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: ISOLATED_ARCHIVE_BUCKET }));
    }
    await s3.send(new PutBucketVersioningCommand({ Bucket: ISOLATED_ARCHIVE_BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
  }, 5 * 60 * 1000);

  afterAll(async () => {
    s3?.destroy();
    await prisma.$disconnect();
    rmSync(outerDir, { recursive: true, force: true });
  });

  async function archiveAndRegister(sourceDocumentId: string, sourceKey: string, bytes: Buffer, title: string): Promise<{ sourcePath: string }> {
    const key = `raw/phase10b35c/${sourceDocumentId}/original.bin`;
    const put = await s3.send(new PutObjectCommand({ Bucket: ISOLATED_ARCHIVE_BUCKET, Key: key, Body: bytes, ContentType: 'application/pdf', ChecksumAlgorithm: 'SHA256' }));
    if (!put.VersionId) throw new Error('archive store returned no VersionId');
    const sourcePath = join(workDir, `${sourceDocumentId}-source.pdf`);
    writeFileSync(sourcePath, bytes);
    await prisma.sourceDocument.create({
      data: {
        id: sourceDocumentId,
        sourceKey,
        fiscalYear: 2024,
        budgetCycle: 'pb',
        component: 'ARMY',
        documentType: 'r2',
        title,
        sourceUrl: 'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
        sha256: sha256Bytes(bytes),
        byteSize: bytes.length,
        extractionMethod: 'deterministic_pdf',
        archiveBucket: ISOLATED_ARCHIVE_BUCKET,
        archiveS3Key: key,
        archiveVersionId: put.VersionId,
        archivedAt: new Date(),
      },
    });
    return { sourcePath };
  }

  async function runRealHandoff(sourceDocumentId: string, sourceKey: string, sourcePath: string): Promise<{ decision: string }> {
    const adapter = new DefaultParserHandoffAdapter({ workDir, maxEscalationRounds: 4 });
    return adapter.handoff({
      cycleId: `fy2024:${randomUUID()}`,
      sourceDocumentId,
      sourceSha256: REAL_R2_FIXTURE_SHA256,
      sourcePath,
      fiscalYear: 2024,
      authorityTrack: 'request',
      stage: 'president_budget_request',
      sourceFamily: 'pb_r2',
      title: 'r2',
      sourceUrl: 'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
      sourceKey,
      component: 'ARMY',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /** Creates a minimal, directly-inserted, real Postgres candidate row (no
   * real run/artifact -- only used by scenarios that never touch the
   * extraction artifact: eligibility refusals and the concurrency race). */
  async function directCandidate(input: {
    sourceDocumentId: string;
    sourceSha256: string;
    status: string;
  }): Promise<string> {
    const id = randomUUID();
    const seed = `${id}:${input.sourceDocumentId}`;
    await prisma.budgetExtractionCandidateV1.create({
      data: {
        id,
        cycleId: `fy2024:${randomUUID()}`,
        manifestContentSha256: fakeHash(`manifest:${seed}`),
        manifestDocumentKey: `manifest-key:${seed}`,
        extractionArtifactId: `artifact:${seed}`,
        extractionArtifactSha256: fakeHash(`artifact-sha:${seed}`),
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        verifierVersion: 'phase10b35c-test-v1',
        policyVersion: '1.0.0',
        policySha256: fakeHash(`policy:${seed}`),
        status: input.status,
      },
    });
    return id;
  }

  async function directSourceDocument(overrides: { sourceSha256?: string } = {}): Promise<{ id: string; sourceSha256: string }> {
    const id = randomUUID();
    const sourceSha256 = overrides.sourceSha256 ?? fakeHash(`source:${id}`);
    await prisma.sourceDocument.create({
      data: {
        id,
        sourceKey: `phase10b35c-direct-${id}`,
        fiscalYear: 2024,
        budgetCycle: 'pb',
        component: 'ARMY',
        documentType: 'r2',
        title: 'phase10b35c e2e direct-insert fixture (no real archive)',
        sourceUrl: 'https://example.invalid/phase10b35c-direct.pdf',
        sha256: sourceSha256,
        extractionMethod: 'deterministic_pdf',
      },
    });
    return { id, sourceSha256 };
  }

  /** Directly-inserted, real `budget_verification_run_v1` row bound to a
   * given candidate (only used by scenarios that never touch the extraction
   * artifact -- same rationale as `directCandidate`). */
  async function directRun(candidateId: string, candidate: { sourceSha256: string; extractionArtifactSha256: string; manifestContentSha256: string }): Promise<string> {
    const id = randomUUID();
    await prisma.budgetVerificationRunV1.create({
      data: {
        id,
        candidateId,
        verifierVersion: 'phase10b35c-test-v1',
        policyVersion: '1.0.0',
        policySha256: fakeHash(`run-policy:${id}`),
        decision: 'REVIEW',
        status: 'NEEDS_REVIEW',
        route: 'human_review',
        riskScore: 0,
        startedAt: new Date(),
        completedAt: new Date(),
        manifestContentSha256: candidate.manifestContentSha256,
        extractionArtifactSha256: candidate.extractionArtifactSha256,
        sourceSha256: candidate.sourceSha256,
        resultSnapshot: {},
      },
    });
    return id;
  }

  /** Directly-inserted, real ACTIVE `budget_scoped_fact_review_v1` approval,
   * satisfying `check_budget_scoped_fact_review_v1_binding`'s real identity
   * checks against a real candidate/run -- used only by scenarios that don't
   * need the real parser pipeline (same rationale as `directCandidate`). */
  async function directActiveScopedApproval(input: {
    candidateId: string;
    runId: string;
    sourceDocumentId: string;
    sourceSha256: string;
    extractionArtifactId: string;
    extractionArtifactSha256: string;
    manifestContentSha256: string;
    peCode: string;
    reviewerId: string;
  }): Promise<string> {
    const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
    const scope = { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: input.peCode, fiscalYear: 2024, fundingField: 'request' as const, component: 'ARMY' };
    const result = await reviews.insertDecision({
      candidateId: input.candidateId,
      runId: input.runId,
      sourceDocumentId: input.sourceDocumentId,
      sourceSha256: input.sourceSha256,
      extractionArtifactId: input.extractionArtifactId,
      extractionArtifactSha256: input.extractionArtifactSha256,
      manifestContentSha256: input.manifestContentSha256,
      policyId: 'rdte_r2_pe_total_review_policy_v1',
      policyVersion: '1',
      policySha256: fakeHash(`review-policy:${input.candidateId}`),
      scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
      scopeKey: scopedFactReviewScopeKeyV1(scope),
      scope,
      assertionIds: [],
      evidenceIds: [],
      projection: null,
      independence: null,
      limitations: [],
      decision: 'approve',
      reviewerId: input.reviewerId,
      rationale: 'phase10b35c e2e regression: real active approval seeded directly for the different-old-candidates-same-new-candidate race',
      decisionHash: fakeHash(`decision:${input.candidateId}:${input.peCode}`),
      now: new Date().toISOString(),
    });
    return result.row.id;
  }

  describe('core + sweep: real corrected candidate, real link, real supersession of a real active approval, real serving boundary', () => {
    const sourceDocumentId = randomUUID();
    const sourceKey = `phase10b35c-e2e-${randomUUID()}`;
    let oldCandidateId: string;
    let newCandidateId: string;
    let verification: ReturnType<typeof createPrismaBudgetVerificationRepository>;
    let reviews: PrismaScopedFactReviewRepositoryV1;
    let corrections: PrismaCandidateCorrectionRepositoryV1;
    let correctionService: CandidateCorrectionV1Service;
    let reviewService: ScopedFactReviewV1Service;
    let readService: ReviewedPartialPeTotalsReadServiceV1;
    let approvedReviewId: string;
    let newApprovedReviewId: string;

    beforeAll(async () => {
      // ONE registered SourceDocument, TWO real handoffs against it -- this
      // is what a real "governed replay/re-ingestion" of the same document
      // actually looks like in production (the packet's own step 8.1 #8
      // re-runs the SAME source through the corrected drain to produce a
      // fresh candidate; it does not register a second SourceDocument row).
      // The candidate-correction mechanism's same-source-identity check
      // requires the OLD and NEW candidates to share `sourceDocumentId` for
      // exactly this reason: a correction re-reads the SAME registered
      // document, never a different one. `cycleId` (randomUUID per call,
      // inside `runRealHandoff`) is what keeps the two resulting candidate
      // rows distinct despite sharing every other identity field.
      const reg = await archiveAndRegister(sourceDocumentId, sourceKey, pdfBytes, 'FY2024 Army RDT&E R-2 Vol 1 BA1 (phase10b35c e2e -- registered once, re-processed twice)');

      const oldResult = await runRealHandoff(sourceDocumentId, sourceKey, reg.sourcePath);
      if (oldResult.decision !== 'REVIEW' && oldResult.decision !== 'PASS') {
        console.error('OLD handoff unexpected result:', JSON.stringify(oldResult, null, 2));
      }
      expect(oldResult.decision === 'REVIEW' || oldResult.decision === 'PASS').toBe(true);
      const oldCandidate = await prisma.budgetExtractionCandidateV1.findFirstOrThrow({
        where: { sourceDocumentId, sourceSha256: REAL_R2_FIXTURE_SHA256 },
        orderBy: { createdAt: 'desc' },
      });
      oldCandidateId = oldCandidate.id;
      expect(oldCandidate.status).toBe('NEEDS_REVIEW');

      const newResult = await runRealHandoff(sourceDocumentId, sourceKey, reg.sourcePath);
      if (newResult.decision !== 'REVIEW' && newResult.decision !== 'PASS') {
        console.error('NEW handoff unexpected result:', JSON.stringify(newResult, null, 2));
      }
      expect(newResult.decision === 'REVIEW' || newResult.decision === 'PASS').toBe(true);
      const newCandidate = await prisma.budgetExtractionCandidateV1.findFirstOrThrow({
        where: { sourceDocumentId, sourceSha256: REAL_R2_FIXTURE_SHA256 },
        orderBy: { createdAt: 'desc' },
      });
      newCandidateId = newCandidate.id;
      // NOTE: the parser is deterministic, so re-processing the identical
      // source bytes produces byte-identical extraction content -- the two
      // candidates' `extractionArtifactId` (a content hash) is therefore
      // EXPECTED to be the same. Candidate identity is still genuinely
      // distinct (`cycleId` differs per handoff call), which is all the
      // correction mechanism's own same-source-identity check requires.
      // Tests below distinguish old vs. new by scoped-fact-review id, not by
      // artifact id, for exactly this reason.
      expect(newCandidateId).not.toBe(oldCandidateId);
      expect(newCandidate.status).toBe('NEEDS_REVIEW');

      verification = createPrismaBudgetVerificationRepository(prisma);
      reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      corrections = new PrismaCandidateCorrectionRepositoryV1(prisma as never);
      correctionService = new CandidateCorrectionV1Service(verification, corrections);
      reviewService = new ScopedFactReviewV1Service(verification, new PrismaLocatorReader(prisma), new FilesystemArtifactLoader(), reviews);
      readService = new ReviewedPartialPeTotalsReadServiceV1(new PrismaReviewedPartialPeTotalsRepositoryV1(prisma));
    }, 15 * 60 * 1000);

    it('produced two distinct real NEEDS_REVIEW candidates sharing the same source document/bytes', async () => {
      expect(oldCandidateId).not.toBe(newCandidateId);
      const [oldC, newC] = await Promise.all([verification.readCandidate(oldCandidateId), verification.readCandidate(newCandidateId)]);
      expect(oldC!.sourceSha256).toBe(REAL_R2_FIXTURE_SHA256);
      expect(newC!.sourceSha256).toBe(REAL_R2_FIXTURE_SHA256);
    });

    it('sets up the "active approval" case: a real scoped approval is recorded on the OLD candidate before correction', async () => {
      const oldC = (await verification.readCandidate(oldCandidateId))!;
      const approved = await reviewService.review(
        {
          candidateId: oldCandidateId,
          runId: oldC.currentRunId!,
          scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: TARGET_PE.peCode, fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
          decision: 'approve',
          reviewerId: 'neo@capiro.ai',
          rationale: 'phase10b35c e2e: real approval on the OLD candidate, to be superseded by correction.',
          expectedSourceSha256: oldC.sourceSha256,
          expectedExtractionArtifactSha256: oldC.extractionArtifactSha256,
          expectedManifestContentSha256: oldC.manifestContentSha256,
        },
        { commit: true },
      );
      expect(approved.mode).toBe('committed');
      approvedReviewId = approved.persisted!.id;

      const served = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(served.some((r) => r.review.scopedFactReviewId === approvedReviewId)).toBe(true);
    });

    it('dry-run reports eligible:true and no existing link for this old candidate', async () => {
      const preview = await correctionService.correct({ oldCandidateId, newCandidateId, actor: 'neo@capiro.ai', reason: 'dry-run preview' }, { commit: false });
      expect(preview.mode).toBe('dry-run');
      expect(preview.eligibility.eligible).toBe(true);
      expect(preview.existingLinkForOldCandidate).toBeNull();
      expect(preview.persisted).toBeNull();
    });

    it('commit records exactly one link row, supersedes the OLD candidate real active approval, and the OLD candidate row/status is completely unchanged', async () => {
      const oldBefore = (await verification.readCandidate(oldCandidateId))!;

      const result = await correctionService.correct(
        { oldCandidateId, newCandidateId, actor: 'neo@capiro.ai', reason: 'phase10b35c e2e: corrected re-verification supersedes the pre-fix-modeled candidate' },
        { commit: true },
      );
      expect(result.mode).toBe('committed');
      expect(result.persisted).not.toBeNull();
      expect(result.persisted!.oldCandidateId).toBe(oldCandidateId);
      expect(result.persisted!.newCandidateId).toBe(newCandidateId);
      expect(result.supersededScopedFactReviewIds).toEqual([approvedReviewId]);

      const oldAfter = (await verification.readCandidate(oldCandidateId))!;
      expect(oldAfter.status).toBe(oldBefore.status);
      expect(oldAfter.status).toBe('NEEDS_REVIEW');
      expect(oldAfter.updatedAt).toBe(oldBefore.updatedAt); // the candidate row itself was never written

      const supersededRow = await reviews.readById(approvedReviewId);
      expect(supersededRow!.status).toBe('superseded');
      expect(supersededRow!.revokedBy).toBe('neo@capiro.ai');
      expect(supersededRow!.decision).toBe('approve'); // decision itself is immutable, only status/revocation columns changed
    });

    it('after correction, the OLD candidate approval is no longer served; the NEW candidate has not automatically inherited it', async () => {
      const served = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(served.some((r) => r.review.scopedFactReviewId === approvedReviewId)).toBe(false);
      // Nothing is served at all yet -- the correction only supersedes the
      // old approval; it never creates or inherits an approval on the new
      // candidate (that always requires its own real reviewer action, proven
      // in the next test).
      expect(served).toEqual([]);
    });

    it('a repeat commit for the SAME (old, new) pair is idempotent -- same link id, no new row, no double supersession', async () => {
      const before = await corrections.readByOldCandidateId(oldCandidateId);
      const replay = await correctionService.correct(
        { oldCandidateId, newCandidateId, actor: 'neo@capiro.ai', reason: 'phase10b35c e2e: deliberate retry of the same correction' },
        { commit: true },
      );
      expect(replay.mode).toBe('already_recorded');
      expect(replay.persisted!.id).toBe(before!.id);
      expect(replay.supersededScopedFactReviewIds).toEqual([approvedReviewId]);

      const allLinksForOld = await prisma.budgetCandidateCorrectionV1.findMany({ where: { oldCandidateId } });
      expect(allLinksForOld).toHaveLength(1);
    });

    it('a commit attempt for the SAME old candidate against a DIFFERENT real candidate is refused, naming the existing link -- not silently resolved', async () => {
      // A THIRD real handoff against the SAME registered source document --
      // eligible on its own terms (same source identity as `oldCandidateId`),
      // it simply arrives after `oldCandidateId` is already spoken for.
      const beforeThird = await prisma.budgetExtractionCandidateV1.findMany({ where: { sourceDocumentId }, select: { id: true } });
      await runRealHandoff(sourceDocumentId, sourceKey, join(workDir, `${sourceDocumentId}-source.pdf`));
      const thirdCandidate = await prisma.budgetExtractionCandidateV1.findFirstOrThrow({
        where: { sourceDocumentId, sourceSha256: REAL_R2_FIXTURE_SHA256, id: { notIn: beforeThird.map((c) => c.id) } },
        orderBy: { createdAt: 'desc' },
      });

      await expect(
        correctionService.correct(
          { oldCandidateId, newCandidateId: thirdCandidate.id, actor: 'neo@capiro.ai', reason: 'phase10b35c e2e: conflicting corrector, must be refused' },
          { commit: true },
        ),
      ).rejects.toMatchObject({ code: 'already_corrected_by_different_candidate' });

      // The conflict did not silently pick a winner: the ORIGINAL link is
      // still exactly what it was, and the third candidate's own row is
      // untouched (queryable, just not registered as THE correction).
      const stillTheOriginal = await corrections.readByOldCandidateId(oldCandidateId);
      expect(stillTheOriginal!.newCandidateId).toBe(newCandidateId);
      const thirdStillExists = await verification.readCandidate(thirdCandidate.id);
      expect(thirdStillExists).not.toBeNull();
    }, 15 * 60 * 1000);

    it('a fresh scoped approval on the NEW candidate (a real, separate reviewer action) is served correctly; old candidate contributes nothing', async () => {
      const newC = (await verification.readCandidate(newCandidateId))!;
      const approvedOnNew = await reviewService.review(
        {
          candidateId: newCandidateId,
          runId: newC.currentRunId!,
          scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: TARGET_PE.peCode, fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
          decision: 'approve',
          reviewerId: 'neo@capiro.ai',
          rationale: 'phase10b35c e2e: fresh, independent approval on the corrected candidate -- never inherited from the old one.',
          expectedSourceSha256: newC.sourceSha256,
          expectedExtractionArtifactSha256: newC.extractionArtifactSha256,
          expectedManifestContentSha256: newC.manifestContentSha256,
        },
        { commit: true },
      );
      expect(approvedOnNew.mode).toBe('committed');
      newApprovedReviewId = approvedOnNew.persisted!.id;

      const served = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(served).toHaveLength(1);
      expect(served[0]!.review.scopedFactReviewId).toBe(newApprovedReviewId);
      expect(served[0]!.amountMillions.total).toBe(TARGET_PE.total);
      expect(served.some((r) => r.review.scopedFactReviewId === approvedReviewId)).toBe(false);
    });

    it("history is fully queryable afterward: the link, the superseded row, and the old candidate's own audit trail are all still readable, nothing overwritten", async () => {
      const link = await correctionService.readByOldCandidateId(oldCandidateId);
      expect(link).not.toBeNull();
      expect(link!.newCandidateId).toBe(newCandidateId);
      expect(await correctionService.readByNewCandidateId(newCandidateId)).toEqual(link);

      const oldCandidateHistory = await reviews.listByCandidate(oldCandidateId);
      expect(oldCandidateHistory).toHaveLength(1);
      expect(oldCandidateHistory[0]!.id).toBe(approvedReviewId);
      expect(oldCandidateHistory[0]!.status).toBe('superseded');
      expect(oldCandidateHistory[0]!.decision).toBe('approve'); // original decision preserved, never rewritten
    });
  });

  describe('eligibility refusal: old candidate status is not correctable', () => {
    it('refuses to correct a REVIEW_ACCEPTED candidate, and performs no writes', async () => {
      const src = await directSourceDocument();
      const oldId = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'REVIEW_ACCEPTED' });
      const newId = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });

      const verification = createPrismaBudgetVerificationRepository(prisma);
      const service = new CandidateCorrectionV1Service(verification, new PrismaCandidateCorrectionRepositoryV1(prisma as never));

      const preview = await service.correct({ oldCandidateId: oldId, newCandidateId: newId, actor: 'neo@capiro.ai', reason: 'should be refused' }, { commit: false });
      expect(preview.eligibility.eligible).toBe(false);
      expect(preview.eligibility.refusalReasons.map((r) => r.code)).toEqual(['old_candidate_status_not_correctable']);

      await expect(
        service.correct({ oldCandidateId: oldId, newCandidateId: newId, actor: 'neo@capiro.ai', reason: 'should be refused' }, { commit: true }),
      ).rejects.toMatchObject({ code: 'ineligible' });

      const linkRows = await prisma.budgetCandidateCorrectionV1.findMany({ where: { oldCandidateId: oldId } });
      expect(linkRows).toEqual([]);
    });
  });

  describe('eligibility refusal: source identity mismatch', () => {
    it('refuses when old and new candidates do not share the same source document/bytes', async () => {
      const srcA = await directSourceDocument();
      const srcB = await directSourceDocument();
      const oldId = await directCandidate({ sourceDocumentId: srcA.id, sourceSha256: srcA.sourceSha256, status: 'NEEDS_REVIEW' });
      const newId = await directCandidate({ sourceDocumentId: srcB.id, sourceSha256: srcB.sourceSha256, status: 'NEEDS_REVIEW' });

      const verification = createPrismaBudgetVerificationRepository(prisma);
      const service = new CandidateCorrectionV1Service(verification, new PrismaCandidateCorrectionRepositoryV1(prisma as never));

      await expect(
        service.correct({ oldCandidateId: oldId, newCandidateId: newId, actor: 'neo@capiro.ai', reason: 'should be refused: different source' }, { commit: true }),
      ).rejects.toMatchObject({ code: 'ineligible' });

      const linkRows = await prisma.budgetCandidateCorrectionV1.findMany({ where: { oldCandidateId: oldId } });
      expect(linkRows).toEqual([]);
    });
  });

  describe('concurrency: two simultaneous correction attempts for the same old candidate', () => {
    it('exactly one of two concurrent commits wins; the other is refused with an explicit, auditable conflict naming the winner', async () => {
      const src = await directSourceDocument();
      const oldId = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });
      const candidateA = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });
      const candidateB = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });

      const verification = createPrismaBudgetVerificationRepository(prisma);
      // Two independent service instances (as two concurrent CLI invocations
      // would each construct their own), sharing only the real database --
      // the real unique index is the only thing that can arbitrate this, not
      // any in-process lock.
      const serviceA = new CandidateCorrectionV1Service(verification, new PrismaCandidateCorrectionRepositoryV1(prisma as never));
      const serviceB = new CandidateCorrectionV1Service(verification, new PrismaCandidateCorrectionRepositoryV1(prisma as never));

      const [resultA, resultB] = await Promise.allSettled([
        serviceA.correct({ oldCandidateId: oldId, newCandidateId: candidateA, actor: 'operator-a', reason: 'race attempt A' }, { commit: true }),
        serviceB.correct({ oldCandidateId: oldId, newCandidateId: candidateB, actor: 'operator-b', reason: 'race attempt B' }, { commit: true }),
      ]);

      const outcomes = [resultA, resultB];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      // Exactly one side committed; the other was explicitly refused.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winnerNewCandidateId = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof serviceA.correct>>>).value.persisted!.newCandidateId;
      expect([candidateA, candidateB]).toContain(winnerNewCandidateId);

      const loserError = (rejected[0] as PromiseRejectedResult).reason;
      expect(loserError).toBeInstanceOf(CandidateCorrectionError);
      expect((loserError as CandidateCorrectionError).code).toBe('already_corrected_by_different_candidate');
      expect((loserError as CandidateCorrectionError).existingLink?.newCandidateId).toBe(winnerNewCandidateId);

      // Exactly one link row exists for this old candidate -- never two.
      const linkRows = await prisma.budgetCandidateCorrectionV1.findMany({ where: { oldCandidateId: oldId } });
      expect(linkRows).toHaveLength(1);
      expect(linkRows[0]!.newCandidateId).toBe(winnerNewCandidateId);

      // The losing candidate's own row was never deleted or altered -- it
      // simply never became THE correction.
      const loserCandidateId = winnerNewCandidateId === candidateA ? candidateB : candidateA;
      const loserCandidateRow = await verification.readCandidate(loserCandidateId);
      expect(loserCandidateRow).not.toBeNull();
      expect(loserCandidateRow!.status).toBe('NEEDS_REVIEW');
    });
  });

  describe('regression (2026-09-09): two DIFFERENT old candidates, each holding a real active decision, racing to correct into the SAME new candidate', () => {
    it('the LOSING attempt performs ZERO writes -- its own active decision is never superseded by a correction that never got recorded', async () => {
      // This is the exact scenario independent review found broken pre-fix:
      // supersedeAllForCandidate() used to run as its own committed statement
      // BEFORE the link insert, so a losing insert (here: the new_candidate_id
      // unique index, not old_candidate_id -- these are two DIFFERENT old
      // candidates) left the loser's real decision already flipped to
      // 'superseded' with no link row to explain why. commitCorrection now
      // runs both in one transaction, so a losing attempt must roll back
      // BOTH writes.
      const src = await directSourceDocument();
      const old1 = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });
      const old2 = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });
      const sharedNew = await directCandidate({ sourceDocumentId: src.id, sourceSha256: src.sourceSha256, status: 'NEEDS_REVIEW' });

      const verification = createPrismaBudgetVerificationRepository(prisma);
      const old1Row = (await verification.readCandidate(old1))!;
      const old2Row = (await verification.readCandidate(old2))!;
      const run1 = await directRun(old1, old1Row);
      const run2 = await directRun(old2, old2Row);

      // Different scope keys (different PE codes) so both approvals can be
      // simultaneously active -- the "one active approve per scope" index is
      // per-scope, not what this test is about.
      const approval1 = await directActiveScopedApproval({
        candidateId: old1,
        runId: run1,
        sourceDocumentId: old1Row.sourceDocumentId,
        sourceSha256: old1Row.sourceSha256,
        extractionArtifactId: old1Row.extractionArtifactId,
        extractionArtifactSha256: old1Row.extractionArtifactSha256,
        manifestContentSha256: old1Row.manifestContentSha256,
        // Deliberately NOT TARGET_PE.peCode ('0601102A') -- that scope has a
        // real active approval elsewhere in this same shared-Postgres file
        // (the "fresh scoped approval on the NEW candidate" test above), and
        // the one-active-approval-per-scope index is database-wide, not
        // per-candidate. Use scope keys unique to this regression test.
        peCode: '0609991A',
        reviewerId: 'operator-a',
      });
      const approval2 = await directActiveScopedApproval({
        candidateId: old2,
        runId: run2,
        sourceDocumentId: old2Row.sourceDocumentId,
        sourceSha256: old2Row.sourceSha256,
        extractionArtifactId: old2Row.extractionArtifactId,
        extractionArtifactSha256: old2Row.extractionArtifactSha256,
        manifestContentSha256: old2Row.manifestContentSha256,
        peCode: '0609992A',
        reviewerId: 'operator-b',
      });

      const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      const serviceA = new CandidateCorrectionV1Service(verification, new PrismaCandidateCorrectionRepositoryV1(prisma as never));
      const serviceB = new CandidateCorrectionV1Service(verification, new PrismaCandidateCorrectionRepositoryV1(prisma as never));

      const [resultA, resultB] = await Promise.allSettled([
        serviceA.correct({ oldCandidateId: old1, newCandidateId: sharedNew, actor: 'operator-a', reason: 'race: old1 claims sharedNew' }, { commit: true }),
        serviceB.correct({ oldCandidateId: old2, newCandidateId: sharedNew, actor: 'operator-b', reason: 'race: old2 claims sharedNew' }, { commit: true }),
      ]);

      const fulfilled = [resultA, resultB].filter((o) => o.status === 'fulfilled');
      const rejected = [resultA, resultB].filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winnerIsA = resultA.status === 'fulfilled';
      const winnerOld = winnerIsA ? old1 : old2;
      const loserOld = winnerIsA ? old2 : old1;
      const winnerApprovalId = winnerIsA ? approval1 : approval2;
      const loserApprovalId = winnerIsA ? approval2 : approval1;

      // THE regression proof: the loser's own real decision must remain
      // exactly as it was -- 'active', never touched.
      const loserApproval = await reviews.readById(loserApprovalId);
      expect(loserApproval!.status).toBe('active');
      expect(loserApproval!.revokedAt).toBeNull();
      expect(loserApproval!.revokedBy).toBeNull();
      expect(loserApproval!.revocationReason).toBeNull();

      const winnerApproval = await reviews.readById(winnerApprovalId);
      expect(winnerApproval!.status).toBe('superseded');

      const loserLinkRows = await prisma.budgetCandidateCorrectionV1.findMany({ where: { oldCandidateId: loserOld } });
      expect(loserLinkRows).toEqual([]);

      const winnerLinkRows = await prisma.budgetCandidateCorrectionV1.findMany({ where: { oldCandidateId: winnerOld } });
      expect(winnerLinkRows).toHaveLength(1);
      expect(winnerLinkRows[0]!.newCandidateId).toBe(sharedNew);

      const loserError = (rejected[0] as PromiseRejectedResult).reason;
      expect(loserError).toBeInstanceOf(CandidateCorrectionError);
      expect((loserError as CandidateCorrectionError).code).toBe('already_corrected_by_different_candidate');
    });
  });
});
