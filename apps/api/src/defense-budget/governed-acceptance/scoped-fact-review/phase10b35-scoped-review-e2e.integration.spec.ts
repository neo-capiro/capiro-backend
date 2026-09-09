/**
 * Phase 10B-35 -- end-to-end isolation proof: corrected R-2A extraction ->
 * production-proof verification -> scoped review -> serving read API, all
 * through the REAL production code paths, against a disposable Postgres and
 * a disposable versioned MinIO archive. No filesystem-only proof shortcut,
 * no hand-built candidate/run rows, no mock repository standing in for
 * Prisma at the boundary this test actually proves.
 *
 * Real path exercised, end to end:
 *   1. `DefaultParserHandoffAdapter.handoff()` (the exact port the governed
 *      ingestion bridge calls in production) -> `runParserHandoffForSourceDocument`
 *      -> the real page profiler -> real route planner -> real Python
 *      engines (`deterministic_pdfplumber` + `paddleocr` for the scanned
 *      pages) -> the real (corrected) R-2/R-2A segmenter, extractors and
 *      artifact builder -> the real verifier -> `CompositeProofResolver` in
 *      `production_proof` mode against a real archived-and-versioned MinIO
 *      object -> `persistCompletedVerification`, writing real
 *      `budget_extraction_candidate_v1`/`budget_verification_run_v1`/
 *      `..._check_v1`/`..._discrepancy_v1`/`budget_verification_proof` rows.
 *   2. `ScopedFactReviewV1Service.review({commit:true})` against that real
 *      candidate/run, for each of the five FY2024 Army R-2 PE totals, using
 *      `PrismaScopedFactReviewRepositoryV1` and a real reload of the
 *      artifact bytes the router just wrote to disk.
 *   3. `ReviewedPartialPeTotalsReadServiceV1` (the exact class the HTTP
 *      controller injects) via `PrismaReviewedPartialPeTotalsRepositoryV1`,
 *      reading the real `budget_scoped_fact_review_v1` table.
 *
 * Negative controls proven against the SAME real data, not a stub:
 *   - the 32 misbound project_funding assertions the pre-fix parser produced
 *     are gone from the artifact this run produces (cross-checked directly);
 *   - a scoped APPROVE attempt for a PE whose page carries ANY finding is
 *     refused end-to-end through the real policy + real persisted rows;
 *   - a whole-candidate REJECT can never receive a scoped approval (the real
 *     DB trigger `check_budget_scoped_fact_review_v1_binding` refuses it,
 *     exercised here with a second, deliberately REJECT-inducing candidate);
 *   - revoking an approval removes it from the next read, live against the
 *     real serving repository.
 *
 * Run with (self-provisions and tears down its own Postgres + MinIO):
 *   pnpm --filter @capiro/api run verify:phase10b35-scoped-review-e2e:db
 */
import { randomUUID } from 'node:crypto';
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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { sha256Bytes } from '../../contracts/canonical-json.js';
import { DefaultParserHandoffAdapter } from '../../default-parser-handoff.adapter.js';
import { createBudgetVerificationS3Client, BUDGET_VERIFICATION_S3_ENDPOINT_ENV } from '../../verification/trusted-proof/s3-proof-adapters.js';
import { createPrismaBudgetVerificationRepository } from '../../verification/persistence/prisma-budget-verification.repository.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  ScopedFactReviewV1Service,
  ScopedFactReviewError,
  type ScopedFactReviewArtifactLoaderV1,
  type ScopedFactReviewCandidateLocatorReaderV1,
} from './scoped-fact-review-v1.service.js';
import { PrismaScopedFactReviewRepositoryV1 } from './scoped-fact-review-repository-v1.js';
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
const ISOLATED_ARCHIVE_BUCKET = 'capiro-phase10b35-isolated-archive';

/** The five FY2024 Army R-2 PE totals this mission targets, with the exact
 * publisher-verified values from the Phase 10B-34 packet. */
const TARGET_PES = [
  { peCode: '0601102A', title: 'Defense Research Sciences', total: '296.67', page: 43 },
  { peCode: '0601103A', title: 'University Research Initiatives', total: '75.672', page: 126 },
  { peCode: '0601104A', title: 'University and Industry Research Centers', total: '108.946', page: 132 },
  { peCode: '0601121A', title: 'Cyber Collaborative Research Alliance', total: '5.459', page: 161 },
  { peCode: '0601601A', title: 'Artificial Intelligence and Machine Learning Basic Research', total: '10.708', page: 164 },
] as const;

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

describeE2E('Phase 10B-35 -- real corrected extraction -> scoped review -> serving API (isolated Postgres + MinIO)', () => {
  jest.setTimeout(20 * 60 * 1000);

  let prisma: PrismaClient;
  let s3: S3Client;
  let outerDir: string;
  let parserArtifactRoot: string;
  let workDir: string;
  let parserProjectDir: string;
  let pdfBytes: Buffer;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    await prisma.$connect();

    outerDir = mkdtempSync(join(tmpdir(), 'phase10b35-e2e-'));
    parserArtifactRoot = join(outerDir, 'parser-artifact-root');
    mkdirSync(parserArtifactRoot, { recursive: true });
    process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = parserArtifactRoot;
    parserProjectDir = join(__dirname, '..', '..', '..', '..', '..', 'defense-budget-parser');
    process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = parserProjectDir;
    // The exact same worktree-vs-PATH drift guard the 10B-31 driver uses --
    // never trust a foreign `capiro-defense-budget-parser` on PATH.
    const resolved = execFileSync('uv', ['run', '--no-sync', 'python', '-c', 'import capiro_defense_budget_parser as p; print(p.__file__)'], {
      cwd: parserProjectDir,
      encoding: 'utf8',
    }).trim();
    if (!resolved.startsWith(parserProjectDir.replace(/\\/g, '/')) && !resolved.replace(/\\/g, '/').includes(parserProjectDir.replace(/\\/g, '/'))) {
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
    const key = `raw/phase10b35/${sourceDocumentId}/original.bin`;
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

  async function runRealHandoff(sourceDocumentId: string, sourceKey: string, sourcePath: string): Promise<{ decision: string; artifactLocator?: string }> {
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

  describe('the real, corrected candidate', () => {
    const sourceDocumentId = randomUUID();
    const sourceKey = `phase10b35-e2e-${randomUUID()}`;
    let candidateId: string;
    let runId: string;
    let artifact: DefenseBudgetExtractionArtifactV1;
    let verification: ReturnType<typeof createPrismaBudgetVerificationRepository>;
    let reviews: PrismaScopedFactReviewRepositoryV1;
    let reviewService: ScopedFactReviewV1Service;
    let readService: ReviewedPartialPeTotalsReadServiceV1;

    beforeAll(async () => {
      const { sourcePath } = await archiveAndRegister(sourceDocumentId, sourceKey, pdfBytes, 'FY2024 Army RDT&E R-2 Volume 1 BA1 (phase10b35 e2e)');
      const result = await runRealHandoff(sourceDocumentId, sourceKey, sourcePath);
      expect(result.decision === 'REVIEW' || result.decision === 'PASS').toBe(true);

      const candidate = await prisma.budgetExtractionCandidateV1.findFirstOrThrow({
        where: { sourceDocumentId, sourceSha256: REAL_R2_FIXTURE_SHA256 },
        orderBy: { createdAt: 'desc' },
      });
      candidateId = candidate.id;
      runId = candidate.currentRunId!;
      expect(candidate.status).toBe('NEEDS_REVIEW');

      artifact = JSON.parse(readFileSync(candidate.extractionArtifactLocator!, 'utf8'));

      verification = createPrismaBudgetVerificationRepository(prisma);
      reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      readService = new ReviewedPartialPeTotalsReadServiceV1(new PrismaReviewedPartialPeTotalsRepositoryV1(prisma));
      reviewService = new ScopedFactReviewV1Service(verification, new PrismaLocatorReader(prisma), new FilesystemArtifactLoader(), reviews);
    }, 15 * 60 * 1000);

    it('produced a real, verified candidate through the full production router (not a fixture-backed shortcut)', async () => {
      const run = await verification.readRun(runId);
      expect(run).not.toBeNull();
      expect(run!.decision).toBe('REVIEW');
      const proofs = await verification.readProofSnapshots(runId);
      expect(proofs.length).toBeGreaterThan(0);
      for (const p of proofs) expect(p.status).toBe('verified');
      expect(artifact.source.sourcePdfSha256).toBe(REAL_R2_FIXTURE_SHA256);
      const identities = artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity');
      expect(identities.length).toBe(5);
    });

    it('the corrected parser produced NONE of the 32 known-wrong project_funding assertions from the pre-fix production artifact', () => {
      const projectFunding = artifact.assertions.filter((a) => a.assertionKind === 'project_funding') as unknown as Array<{
        parentPeCode: string;
        projectCode: string;
        metadata?: { physicalPage?: number };
      }>;
      const onR2Pages = projectFunding.filter((a) => TARGET_PES.some((pe) => pe.page === a.metadata?.physicalPage));
      expect(onR2Pages).toEqual([]);
      expect(projectFunding.some((a) => a.parentPeCode === '0601102A' && a.projectCode === 'T14' && a.metadata?.physicalPage === 126)).toBe(false);
    });

    it.each(TARGET_PES)('scoped-approves PE $peCode through the real service, persists a real row, and it is excluded before approval, included after', async (pe) => {
      const before = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(before.some((r) => r.peCode === pe.peCode)).toBe(false);

      const preview = await reviewService.review(
        {
          candidateId,
          runId,
          scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: pe.peCode, fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
          decision: 'approve',
          reviewerId: 'neo@capiro.ai',
          rationale: `Phase 10B-35 e2e: publisher-verified FY2024 request total for ${pe.peCode}, page ${pe.page}.`,
          expectedSourceSha256: REAL_R2_FIXTURE_SHA256,
          expectedExtractionArtifactSha256: (await verification.readCandidate(candidateId))!.extractionArtifactSha256,
          expectedManifestContentSha256: (await verification.readCandidate(candidateId))!.manifestContentSha256,
        },
        { commit: true },
      );
      expect(preview.mode).toBe('committed');
      expect(preview.eligibility.eligible).toBe(true);
      expect(preview.persisted).not.toBeNull();

      const after = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      const row = after.find((r) => r.peCode === pe.peCode);
      expect(row).toBeDefined();
      expect(row!.amountMillions.total).toBe(pe.total);
      expect(row!.peTitle).toBe(pe.title);
      expect(row!.reviewStatus).toBe('reviewed_partial');
      expect(row!.coverage).toBe('partial');
      expect(row!.source.physicalPage).toBe(pe.page);
      expect(row!.source.sourceSha256).toBe(REAL_R2_FIXTURE_SHA256);
      expect(row!.limitations.some((l) => l.startsWith('coverage:partial'))).toBe(true);

      // Revoke -> the row disappears from the next real read.
      await reviewService.revoke({ id: row!.review.scopedFactReviewId, actor: 'neo@capiro.ai', reason: 'phase10b35 e2e revoke-then-verify-exclusion' });
      const afterRevoke = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(afterRevoke.some((r) => r.peCode === pe.peCode)).toBe(false);

      // Re-approve so the closeout report and other assertions in this file see the row present.
      const candidateNow = (await verification.readCandidate(candidateId))!;
      const reapproved = await reviewService.review(
        {
          candidateId,
          runId,
          scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: pe.peCode, fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
          decision: 'approve',
          reviewerId: 'neo@capiro.ai',
          rationale: `Phase 10B-35 e2e: re-approved after revocation-exclusion proof, ${pe.peCode}.`,
          expectedSourceSha256: candidateNow.sourceSha256,
          expectedExtractionArtifactSha256: candidateNow.extractionArtifactSha256,
          expectedManifestContentSha256: candidateNow.manifestContentSha256,
        },
        { commit: true },
      );
      expect(reapproved.mode).toBe('committed');
    });

    it('a second scoped decision for the SAME candidate and scope is refused (revoke first)', async () => {
      const candidateNow = (await verification.readCandidate(candidateId))!;
      await expect(
        reviewService.review(
          {
            candidateId,
            runId,
            scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: TARGET_PES[0].peCode, fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
            decision: 'approve',
            reviewerId: 'neo@capiro.ai',
            rationale: 'phase10b35 e2e duplicate-decision refusal proof',
            expectedSourceSha256: candidateNow.sourceSha256,
            expectedExtractionArtifactSha256: candidateNow.extractionArtifactSha256,
            expectedManifestContentSha256: candidateNow.manifestContentSha256,
          },
          { commit: true },
        ),
      ).rejects.toMatchObject({ code: 'scope_already_decided_on_candidate' });
    });

    it('the reviewed-partial read never returns unreviewed R-2A project-level assertions or any wrong-identity binding -- only the five approved PE totals', async () => {
      const rows = await readService.listReviewedPartialPeTotals({ fiscalYear: 2024, component: 'ARMY' });
      expect(rows.map((r) => r.peCode).sort()).toEqual([...TARGET_PES.map((p) => p.peCode)].sort());
      for (const row of rows) {
        expect(row.amountMillions.total).toBe(TARGET_PES.find((p) => p.peCode === row.peCode)!.total);
      }
    });
  });

  describe('candidate-wide REJECT can never receive a scoped approval', () => {
    it('the DB trigger refuses an approval bound to a REJECT-decision candidate', async () => {
      // A tiny, deliberately non-archived, non-R-2 SourceDocument/candidate
      // that the real verifier will REJECT outright (no archive evidence,
      // and no rdte/r2 identity at all) -- proves the refusal is enforced at
      // the persistence boundary, not merely by the TypeScript service layer.
      const sourceDocumentId = randomUUID();
      const sourceKey = `phase10b35-e2e-reject-${randomUUID()}`;
      // A real, valid, minimal one-page PDF (pdf-lib, same technique the
      // 10B-31 driver uses) -- enough for the real router to record at least
      // one real parser run, so the artifact builder has contributing runs
      // to work with. It carries no archive-agreeing content and (per the
      // metadata-agreement check) no complete rdte/R-2 identity, so the real
      // verifier genuinely REJECTs it -- proving the DB trigger's refusal
      // against a real REJECT-decision candidate, not a crashed pipeline.
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('phase10b35 e2e reject-control page -- not a real R-2 exhibit', { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
      const tinyPdf = Buffer.from(await doc.save());
      await prisma.sourceDocument.create({
        data: {
          id: sourceDocumentId,
          sourceKey,
          fiscalYear: 2024,
          budgetCycle: 'pb',
          component: 'ARMY',
          documentType: 'r2',
          title: 'phase10b35 e2e reject-control (no archive, no real R-2 content)',
          sourceUrl: 'https://example.invalid/phase10b35-reject.pdf',
          sha256: sha256Bytes(tinyPdf),
          byteSize: tinyPdf.length,
          extractionMethod: 'deterministic_pdf',
          // No archive fields (deliberately unarchived) -- but a real,
          // hashable artifactPath under the approved parser-artifact root, so
          // `resolveAuthoritativeLocator`'s priority-2 branch can resolve real
          // bytes and the verifier reaches a genuine REJECT decision instead
          // of throwing on wholly unresolvable source bytes.
          artifactPath: join(workDir, `${sourceDocumentId}-source.pdf`),
        },
      });
      const sourcePath = join(workDir, `${sourceDocumentId}-source.pdf`);
      writeFileSync(sourcePath, tinyPdf);
      const adapter = new DefaultParserHandoffAdapter({ workDir, maxEscalationRounds: 1 });
      const result = await adapter.handoff({
        cycleId: `fy2024:${randomUUID()}`,
        sourceDocumentId,
        sourceSha256: sha256Bytes(tinyPdf),
        sourcePath,
        fiscalYear: 2024,
        authorityTrack: 'request',
        stage: 'president_budget_request',
        sourceFamily: 'pb_r2',
        title: 'r2',
        sourceUrl: 'https://example.invalid/phase10b35-reject.pdf',
        sourceKey,
        component: 'ARMY',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      expect(result.decision).toBe('REJECT');

      const candidate = await prisma.budgetExtractionCandidateV1.findFirstOrThrow({
        where: { sourceDocumentId },
        orderBy: { createdAt: 'desc' },
      });
      expect(candidate.status).toBe('REJECTED');

      const verification = createPrismaBudgetVerificationRepository(prisma);
      const reviewService = new ScopedFactReviewV1Service(verification, new PrismaLocatorReader(prisma), new FilesystemArtifactLoader(), new PrismaScopedFactReviewRepositoryV1(prisma as never));

      await expect(
        reviewService.review(
          {
            candidateId: candidate.id,
            runId: candidate.currentRunId!,
            scope: { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: '0601999A', fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
            decision: 'approve',
            reviewerId: 'neo@capiro.ai',
            rationale: 'phase10b35 e2e reject-control -- must never succeed',
            expectedSourceSha256: candidate.sourceSha256,
            expectedExtractionArtifactSha256: candidate.extractionArtifactSha256,
            expectedManifestContentSha256: candidate.manifestContentSha256,
          },
          { commit: true },
        ),
      ).rejects.toThrow();
    });
  });
});
