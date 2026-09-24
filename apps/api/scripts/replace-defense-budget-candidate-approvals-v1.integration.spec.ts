/**
 * replace-defense-budget-candidate-approvals-v1.integration.spec -- proves,
 * against a REAL disposable Postgres and through the REAL, unmodified
 * `CandidateCorrectionV1Service` and `ScopedFactReviewV1Service` (no mocks,
 * no fakes standing in for Prisma), that the orchestrator script:
 *
 *   1. is a true no-op on a dry run (zero writes);
 *   2. survives a REAL SIGKILL of the actual running process partway through
 *      the reapproval loop, leaving a database state a re-run can resume
 *      from -- never a double-commit, never a lost approval;
 *   3. re-running the SAME script with the SAME manifest against the same
 *      candidate pair completes the remainder and reaches N of N, without
 *      touching (or re-superseding) anything already done.
 *
 * This does not spin up MinIO -- every candidate here uses a plain
 * filesystem extraction-artifact locator (`FilesystemByteLocatorReader`,
 * exactly as `TrustedByteLocatorScopedFactReviewArtifactLoaderV1` already
 * supports in production for local paths), which is sufficient because the
 * orchestrator's OWN logic (dry-run pre-check, step ordering, ledger,
 * resumability) does not depend on which byte-locator scheme the candidate
 * happens to use -- only `ScopedFactReviewV1Service.review()`'s artifact
 * reload does, and that class is exercised completely unmodified here.
 *
 * Run with (self-provisions and tears down its own disposable Postgres):
 *   pnpm --filter @capiro/api run verify:replace-defense-budget-candidate-approvals-v1:db
 */
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  computeArtifactContentSha256,
  parseDefenseBudgetExtractionArtifactV1,
} from '../src/defense-budget/contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { createPrismaBudgetVerificationRepository } from '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js';
import {
  ScopedFactReviewV1Service,
  type ScopedFactReviewArtifactLoaderV1,
  type ScopedFactReviewCandidateLocatorReaderV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-v1.service.js';
import { PrismaScopedFactReviewRepositoryV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import {
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  scopedFactReviewScopeKeyV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-policy-v1.js';

// CLI scenarios spawn the real process and assert its real exit/stdout/stderr
// contract. Pure reconciliation table tests import only the guarded helper in
// a separate unit spec; `main()` runs solely when this file is the entrypoint.

/** This script's own exit codes (not exported -- they are this CLI's stable
 * contract, asserted here by value; see its top-of-file doc comment). */
const EXIT_RECONCILIATION_FAILED = 3;
const EXIT_PARTIAL = 2;

const DATABASE_URL = process.env.DATABASE_URL?.trim();

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

const describeE2E = isLocalUrl(DATABASE_URL) ? describe : describe.skip;

const SCRIPT_PATH = join(__dirname, 'replace-defense-budget-candidate-approvals-v1.ts');
const PE_COUNT = 17; // BA2-shaped: 17 PEs, matching the real BA2 approval-replacement scenario.
const FISCAL_YEAR = 2024;
const COMPONENT = 'ARMY';

function fakeHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

class FilesystemArtifactLoader implements ScopedFactReviewArtifactLoaderV1 {
  async load(input: { locator: string }): Promise<Buffer> {
    return fs.promises.readFile(input.locator);
  }
}
class LocatorReader implements ScopedFactReviewCandidateLocatorReaderV1 {
  constructor(private readonly prisma: PrismaClient) {}
  async readExtractionArtifactLocator(candidateId: string): Promise<string | null> {
    const row = await this.prisma.budgetExtractionCandidateV1.findFirst({
      where: { id: candidateId },
      select: { extractionArtifactLocator: true },
    });
    return row?.extractionArtifactLocator ?? null;
  }
}

/** Builds a schema-valid, policy-eligible synthetic artifact with PE_COUNT
 * distinct PE totals, each on its own physical page (so none of them can
 * cross-contaminate the independence analysis in
 * `evaluateScopedFactReviewEligibilityV1`). `peBase` keeps PE codes disjoint
 * across test runs/files sharing one disposable Postgres, since the
 * "one active approval per scope" index is GLOBAL, not per source document. */
function buildArtifact(
  sourceDocumentId: string,
  sourceSha256: string,
  peBase: number,
  peCount = PE_COUNT,
): { artifact: DefenseBudgetExtractionArtifactV1; peCodes: string[] } {
  const peCodes: string[] = [];
  const evidence: DefenseBudgetExtractionArtifactV1['evidence'] = [];
  const assertions: DefenseBudgetExtractionArtifactV1['assertions'] = [];
  for (let i = 0; i < peCount; i++) {
    const pe = `06${String(peBase + i).padStart(5, '0')}A`; // 7 digits + 'A'
    peCodes.push(pe);
    const page = 100 + i;
    evidence.push(
      {
        evidenceId: `ev-identity-${i}`,
        sourcePdfSha256: sourceSha256,
        parserRunId: 'run-1',
        granularity: 'page_only',
        page,
      },
      {
        evidenceId: `ev-total-${i}`,
        sourcePdfSha256: sourceSha256,
        parserRunId: 'run-1',
        granularity: 'page_only',
        page,
      },
    );
    assertions.push(
      {
        assertionId: `ident-${i}`,
        sourceFactIds: [],
        evidenceIds: [`ev-identity-${i}`],
        confidence: 1,
        metadata: { physicalPage: page, contextSource: 'explicit_header' },
        assertionKind: 'program_element_identity',
        identity: { lineKind: 'RDTE_PE', peCode: pe },
        title: `fixture PE ${pe}`,
        component: COMPONENT,
      } as DefenseBudgetExtractionArtifactV1['assertions'][number],
      {
        assertionId: `total-${i}`,
        sourceFactIds: [],
        evidenceIds: [`ev-total-${i}`],
        confidence: 1,
        metadata: { physicalPage: page, rowIndex: 0 },
        assertionKind: 'document_fact',
        fieldName: 'r2_total_component',
        value: {
          rowKind: 'pe_total',
          peCode: pe,
          fiscalYear: FISCAL_YEAR,
          positionCycle: `pb_fy${FISCAL_YEAR}`,
          valueMillions: `${10 + i}.5`,
        },
      } as DefenseBudgetExtractionArtifactV1['assertions'][number],
    );
  }
  const base = {
    schemaVersion: 'defense_budget_extraction_v1' as const,
    source: {
      manifestDocumentKey: `fixture-manifest-key-${sourceDocumentId}`,
      sourceDocumentId,
      sourcePdfSha256: sourceSha256,
      sourceLocator: `fixture-locator-${sourceDocumentId}`,
      fiscalYear: FISCAL_YEAR,
      family: 'rdte' as const,
      exhibit: 'R-2' as const,
      authority: 'dod-comptroller' as const,
      component: COMPONENT,
      budgetCycle: 'pb',
      documentType: 'r2',
    },
    parserRuns: [
      {
        parserRunId: 'run-1',
        method: 'deterministic_pdfplumber' as const,
        parserVersion: 'replace-approvals-fixture-v1',
        parserConfigSha256: fakeHash('config'),
        inputSourceSha256: sourceSha256,
        outputArtifactSha256: fakeHash('output'),
        pageRanges: [{ startPage: 1, endPage: 400 }],
      },
    ],
    evidence,
    sourceFacts: [],
    assertions,
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: assertions.length,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete' as const,
    },
  };
  const contentSha256 = computeArtifactContentSha256({
    ...base,
    artifactId: 'placeholder',
    contentSha256: '0'.repeat(64),
  } as DefenseBudgetExtractionArtifactV1);
  const artifact = parseDefenseBudgetExtractionArtifactV1({
    ...base,
    artifactId: `dbx1_${contentSha256}`,
    contentSha256,
  });
  return { artifact, peCodes };
}

describeE2E(
  'replace-defense-budget-candidate-approvals-v1 -- real Postgres, real services, real process kill',
  () => {
    jest.setTimeout(3 * 60 * 1000);

    let prisma: PrismaClient;
    let workDir: string;

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
      await prisma.$connect();
      workDir = mkdtempSync(join(tmpdir(), 'replace-approvals-e2e-'));
    });

    afterAll(async () => {
      await prisma.$disconnect();
      rmSync(workDir, { recursive: true, force: true });
    });

    async function buildFixture(
      peBase: number,
      peCount = PE_COUNT,
    ): Promise<{
      oldCandidateId: string;
      newCandidateId: string;
      oldRunId: string;
      newRunId: string;
      manifestPath: string;
      reasonPath: string;
      artifactPath: string;
      peCodes: string[];
    }> {
      const verification = createPrismaBudgetVerificationRepository(prisma);
      const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      const reviewService = new ScopedFactReviewV1Service(
        verification,
        new LocatorReader(prisma),
        new FilesystemArtifactLoader(),
        reviews,
      );

      const sourceDocumentId = randomUUID();
      const sourceSha256 = fakeHash(`replace-approvals-fixture-source:${sourceDocumentId}`);
      await prisma.sourceDocument.create({
        data: {
          id: sourceDocumentId,
          sourceKey: `replace-approvals-fixture-${sourceDocumentId}`,
          fiscalYear: FISCAL_YEAR,
          budgetCycle: 'pb',
          component: COMPONENT,
          documentType: 'r2',
          title:
            'replace-defense-budget-candidate-approvals-v1 fixture (synthetic, not real production data)',
          sourceUrl: 'https://example.invalid/replace-approvals-fixture.pdf',
          sha256: sourceSha256,
          extractionMethod: 'deterministic_pdf',
        },
      });

      const { artifact, peCodes } = buildArtifact(sourceDocumentId, sourceSha256, peBase, peCount);
      const artifactPath = join(workDir, `${sourceDocumentId}-artifact.json`);
      fs.writeFileSync(artifactPath, JSON.stringify(artifact));

      async function createCandidateAndRun(): Promise<{ candidateId: string; runId: string }> {
        const candidateId = randomUUID();
        await prisma.budgetExtractionCandidateV1.create({
          data: {
            id: candidateId,
            cycleId: `fy${FISCAL_YEAR}:${randomUUID()}`,
            manifestContentSha256: fakeHash(`manifest:${candidateId}`),
            manifestDocumentKey: `manifest-key:${candidateId}`,
            extractionArtifactId: artifact.artifactId,
            extractionArtifactSha256: artifact.contentSha256,
            extractionArtifactLocator: artifactPath,
            sourceDocumentId,
            sourceSha256,
            verifierVersion: 'replace-approvals-fixture-v1',
            policyVersion: '1.0.0',
            policySha256: fakeHash(`policy:${candidateId}`),
            status: 'NEEDS_REVIEW',
          },
        });
        const runId = randomUUID();
        await prisma.budgetVerificationRunV1.create({
          data: {
            id: runId,
            candidateId,
            verifierVersion: 'replace-approvals-fixture-v1',
            policyVersion: '1.0.0',
            policySha256: fakeHash(`run-policy:${runId}`),
            decision: 'REVIEW',
            status: 'NEEDS_REVIEW',
            route: 'human_review',
            riskScore: 0,
            startedAt: new Date(),
            completedAt: new Date(),
            manifestContentSha256: fakeHash(`manifest:${candidateId}`),
            extractionArtifactSha256: artifact.contentSha256,
            sourceSha256,
            resultSnapshot: {},
          },
        });
        await prisma.budgetExtractionCandidateV1.update({
          where: { id: candidateId },
          data: { currentRunId: runId },
        });
        return { candidateId, runId };
      }

      const old = await createCandidateAndRun();
      const oldCandidateRow = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
        where: { id: old.candidateId },
      });

      for (const pe of peCodes) {
        const scope = {
          scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
          peCode: pe,
          fiscalYear: FISCAL_YEAR,
          fundingField: 'request' as const,
          component: COMPONENT,
        };
        const result = await reviewService.review(
          {
            candidateId: old.candidateId,
            runId: old.runId,
            scope,
            decision: 'approve',
            reviewerId: 'neo@capiro.ai',
            rationale: `fixture: initial approval for ${pe}, to be lost by a simulated re-extraction and replaced`,
            expectedSourceSha256: oldCandidateRow.sourceSha256,
            expectedExtractionArtifactSha256: oldCandidateRow.extractionArtifactSha256,
            expectedManifestContentSha256: oldCandidateRow.manifestContentSha256,
          },
          { commit: true },
        );
        if (result.mode !== 'committed')
          throw new Error(
            `fixture setup: approval for ${pe} did not commit: ${JSON.stringify(result)}`,
          );
      }

      const fresh = await createCandidateAndRun();
      const freshCandidateRow = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
        where: { id: fresh.candidateId },
      });

      // Matches buildArtifact's own fixture values exactly: PE i sits on physical
      // page 100+i with total valueMillions `${10+i}.5` -- these are the
      // "operator's claim" fields the script's pre-flight/execution-time
      // manifest-binding check verifies against the new candidate's real,
      // freshly-computed projection before ever committing.
      const identity = (candidate: typeof oldCandidateRow, currentRunId: string) => ({
        candidateId: candidate.id,
        currentRunId,
        sourceDocumentId: candidate.sourceDocumentId,
        sourceSha256: candidate.sourceSha256,
        extractionArtifactId: candidate.extractionArtifactId,
        extractionArtifactSha256: candidate.extractionArtifactSha256,
        manifestContentSha256: candidate.manifestContentSha256,
      });
      const manifest = {
        schemaVersion: 'defense_budget_approval_replacement_v1',
        oldCandidate: identity(oldCandidateRow, old.runId),
        newCandidate: identity(freshCandidateRow, fresh.runId),
        entries: peCodes.map((pe, i) => ({
          peCode: pe,
          fiscalYear: FISCAL_YEAR,
          component: COMPONENT,
          rationale: `fixture: replacement approval for ${pe} on the corrected candidate`,
          expectedTotalMillions: `${10 + i}.5`,
          expectedPhysicalPage: 100 + i,
          expectedAssertionIds: [`ident-${i}`, `total-${i}`],
          expectedEvidenceIds: [`ev-identity-${i}`, `ev-total-${i}`],
        })),
      };
      const manifestPath = join(workDir, `${sourceDocumentId}-manifest.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const reasonPath = join(workDir, `${sourceDocumentId}-reason.txt`);
      fs.writeFileSync(
        reasonPath,
        'fixture: simulated re-extraction fixed a defect, correcting the old candidate',
      );

      return {
        oldCandidateId: old.candidateId,
        newCandidateId: fresh.candidateId,
        oldRunId: old.runId,
        newRunId: fresh.runId,
        manifestPath,
        reasonPath,
        artifactPath,
        peCodes,
      };
    }

    function runScriptSync(args: string[]): {
      status: number | null;
      stdout: string;
      stderr: string;
    } {
      const result = require('node:child_process').spawnSync(
        process.execPath,
        ['--import', 'tsx', SCRIPT_PATH, ...args],
        {
          cwd: join(__dirname, '..'),
          env: { ...process.env },
          encoding: 'utf8',
        },
      );
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }

    it('dry run (no --commit) performs ZERO writes', async () => {
      const fx = await buildFixture(90000);
      const result = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"mode": "dry-run"');

      const corrections = await prisma.budgetCandidateCorrectionV1.findMany({
        where: { oldCandidateId: fx.oldCandidateId },
      });
      expect(corrections).toHaveLength(0);
      const oldRows = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.oldCandidateId },
      });
      expect(oldRows.every((r) => r.status === 'active')).toBe(true);
      expect(oldRows).toHaveLength(PE_COUNT);
      const newRows = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId },
      });
      expect(newRows).toHaveLength(0);
    });

    it("refuses to proceed -- even with --commit -- when a manifest entry claims an amount that does not match the new candidate's real fact", async () => {
      const fx = await buildFixture(92000);
      // Corrupt exactly one entry's claimed amount so it no longer matches
      // what the real ScopedFactReviewV1Service will compute from the new
      // candidate's actual artifact -- simulates an operator manifest built
      // against a stale/lost old approval that no longer reflects reality.
      const manifest = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
      manifest.entries[3].expectedTotalMillions = '999999.99';
      fs.writeFileSync(fx.manifestPath, JSON.stringify(manifest, null, 2));

      const result = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit', // even WITH --commit, the pre-flight check must refuse before step 1 runs
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('MISMATCH');
      expect(result.stderr).toContain('Refusing to proceed');
      expect(result.stderr).toContain('999999.99');

      // Step 1 (the correction) must NEVER have been attempted -- zero writes
      // anywhere, exactly like the plain dry-run case.
      const corrections = await prisma.budgetCandidateCorrectionV1.findMany({
        where: { oldCandidateId: fx.oldCandidateId },
      });
      expect(corrections).toHaveLength(0);
      const oldRows = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.oldCandidateId },
      });
      expect(oldRows.every((r) => r.status === 'active')).toBe(true);
      expect(oldRows).toHaveLength(PE_COUNT);
      const newRows = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId },
      });
      expect(newRows).toHaveLength(0);
    });

    it('preflight refuses an ineligible candidate even when every manifest fact/citation matches, leaving correction and approvals untouched', async () => {
      const fx = await buildFixture(92300);
      await prisma.budgetVerificationCheckV1.create({
        data: {
          runId: fx.newRunId,
          checkId: `preflight-blocking-${randomUUID()}`,
          code: 'preflight_blocking_check',
          ruleVersion: '1',
          outcome: 'FAIL',
          required: true,
          blocking: true,
          riskPoints: 100,
          message: 'projection still matches, but policy must refuse before correction',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
          details: { exactFactsStillMatch: true },
          passed: false,
        },
      });

      const result = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('candidate is ineligible for approval');
      expect(result.stderr).toContain('pre-flight manifest-binding ledger');
      expect(
        await prisma.budgetCandidateCorrectionV1.count({
          where: { oldCandidateId: fx.oldCandidateId },
        }),
      ).toBe(0);
      expect(
        await prisma.budgetScopedFactReviewV1.count({ where: { candidateId: fx.newCandidateId } }),
      ).toBe(0);
      expect(
        await prisma.budgetScopedFactReviewV1.count({
          where: { candidateId: fx.oldCandidateId, status: 'active' },
        }),
      ).toBe(PE_COUNT);
    });

    it('an artifact fact change after preflight yields a recoverable 0-of-N replacement interruption', async () => {
      const fx = await buildFixture(92500);
      const originalArtifactText = fs.readFileSync(fx.artifactPath, 'utf8');
      let signalGraphHeld!: () => void;
      const graphHeld = new Promise<void>((resolve) => {
        signalGraphHeld = resolve;
      });
      let releaseGraph!: () => void;
      const graphMayCommit = new Promise<void>((resolve) => {
        releaseGraph = resolve;
      });
      const blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0))) AS acquired`,
          );
          signalGraphHeld();
          await graphMayCommit;
        },
        {
          maxWait: 30_000,
          timeout: 60_000,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );
      await graphHeld;

      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          SCRIPT_PATH,
          '--old-candidate-id',
          fx.oldCandidateId,
          '--new-candidate-id',
          fx.newCandidateId,
          '--reapproval-manifest',
          fx.manifestPath,
          '--actor',
          'neo@capiro.ai',
          '--reviewer-id',
          'neo@capiro.ai',
          '--correction-reason-file',
          fx.reasonPath,
          '--commit',
        ],
        { cwd: join(__dirname, '..'), env: { ...process.env } },
      );
      const childExit = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      let stdout = '';
      let stderr = '';
      let signalPreviewPrinted!: () => void;
      const previewPrinted = new Promise<void>((resolve) => {
        signalPreviewPrinted = resolve;
      });
      let sawPreview = false;
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (
          !sawPreview &&
          stdout.includes('"step": "correction"') &&
          stdout.includes('"mode": "dry-run"')
        ) {
          sawPreview = true;
          signalPreviewPrinted();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      try {
        await Promise.race([
          previewPrinted,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error('replacement child never completed preflight/correction preview')),
              60_000,
            ),
          ),
        ]);
        let childWaiting = false;
        const waitDeadline = Date.now() + 20_000;
        while (Date.now() < waitDeadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            SELECT count(*)::bigint AS count
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'
          `);
          if ((waiting[0]?.count ?? 0n) > 0n) {
            childWaiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(childWaiting).toBe(true);

        // Keep the database candidate/run/hash identity unchanged but change
        // the reviewed fact after preflight. The fresh execution read must
        // fail closed on the exact reviewed-fact binding before any review
        // insert, even though the artifact remains structurally readable.
        const changedArtifact = JSON.parse(
          originalArtifactText,
        ) as DefenseBudgetExtractionArtifactV1;
        const firstTotal = changedArtifact.assertions.find(
          (assertion) => assertion.assertionId === 'total-0',
        ) as { value: { valueMillions: string } } | undefined;
        if (firstTotal == null) throw new Error('fixture first total assertion missing');
        firstTotal.value.valueMillions = '999.5';
        fs.writeFileSync(fx.artifactPath, JSON.stringify(changedArtifact));
      } finally {
        releaseGraph();
      }

      const exitCode = await childExit;
      await blocker;
      expect(exitCode).toBe(EXIT_PARTIAL);
      const firstScopeKey = scopedFactReviewScopeKeyV1({
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: fx.peCodes[0]!,
        fiscalYear: FISCAL_YEAR,
        fundingField: 'request',
        component: COMPONENT,
      });
      expect(stdout).toContain(`FAILED  ${firstScopeKey}  EXECUTION_PREVIEW_REFUSED:`);
      expect(stdout).toContain('(code: reviewed_fact_mismatch)');
      // The extraction artifact is one immutable evidence object shared by
      // every scope. Once its bytes drift from the operator-reviewed
      // artifact identity, the safe outcome is to fail the whole remainder,
      // not to treat the other projections from those bytes as trustworthy.
      expect(stderr).toContain('0 of 17 manifest scopes were observed active');
      expect(stderr).toContain('remain incomplete');
      expect(
        await prisma.budgetScopedFactReviewV1.count({
          where: { candidateId: fx.newCandidateId, scopeKey: firstScopeKey },
        }),
      ).toBe(0);
      expect(
        await prisma.budgetScopedFactReviewV1.count({ where: { candidateId: fx.newCandidateId } }),
      ).toBe(0);

      // The CLI is intentionally sequential: step 1 is already durable even
      // though replacement review progress is 0-of-N. Record that exact
      // interruption state rather than implying an atomic rollback.
      const correctionAtInterruption = await prisma.budgetCandidateCorrectionV1.findUniqueOrThrow({
        where: { oldCandidateId: fx.oldCandidateId },
      });
      expect(correctionAtInterruption.newCandidateId).toBe(fx.newCandidateId);
      const oldRowsAtInterruption = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.oldCandidateId },
      });
      expect(oldRowsAtInterruption).toHaveLength(PE_COUNT);
      expect(oldRowsAtInterruption.every((row) => row.status === 'superseded')).toBe(true);

      // Restore the exact reviewed artifact and replay the exact immutable
      // operation intent. Recovery must reuse the correction link and reach
      // N-of-N without rewriting the supersession ledger.
      fs.writeFileSync(fx.artifactPath, originalArtifactText);
      const recovery = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ]);
      expect(recovery.status).toBe(0);
      expect(`${recovery.stdout}\n${recovery.stderr}`).toContain(
        `${PE_COUNT} of ${PE_COUNT} manifest scopes were observed active`,
      );
      expect(
        await prisma.budgetScopedFactReviewV1.count({
          where: { candidateId: fx.newCandidateId, status: 'active' },
        }),
      ).toBe(PE_COUNT);
      const correctionAfterRecovery = await prisma.budgetCandidateCorrectionV1.findUniqueOrThrow({
        where: { oldCandidateId: fx.oldCandidateId },
      });
      expect(correctionAfterRecovery.id).toBe(correctionAtInterruption.id);
      expect(correctionAfterRecovery.supersededScopedFactReviewIds).toEqual(
        correctionAtInterruption.supersededScopedFactReviewIds,
      );
    }, 120_000);

    it('a REAL SIGKILL mid-manifest, then a re-run with the SAME manifest: exactly-once supersession, no double-commit, ends at N of N', async () => {
      const fx = await buildFixture(91000);
      const logPath = join(workDir, 'kill-test-run1.log');
      fs.writeFileSync(logPath, '');

      const args = [
        '--import',
        'tsx',
        SCRIPT_PATH,
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ];

      // Run 1: spawn the REAL script as a REAL OS process (not in-process,
      // not a mock) and SIGKILL it after real evidence of partial progress
      // (>= 5 of 17 committed), proving actual process-crash recovery, not
      // just an in-process exception path.
      const approvedCountFrom = (text: string): number =>
        (text.match(/^APPROVED\b/gm) ?? []).length;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: join(__dirname, '..'),
          env: { ...process.env },
        });
        let out = '';
        let killed = false;
        const timeout = setTimeout(
          () => reject(new Error('run 1 never produced 5 APPROVED lines within the timeout')),
          60_000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          fs.appendFileSync(logPath, chunk);
          if (!killed && approvedCountFrom(out) >= 5) {
            killed = true;
            clearTimeout(timeout);
            child.kill('SIGKILL');
          }
        });
        child.on('exit', () => resolve());
        child.on('error', (err) => reject(err));
      });

      // Real, mid-crash state: the correction step (its own single
      // transaction) always runs to completion first, so the OLD candidate
      // is already fully superseded; the reapproval loop is genuinely
      // partial.
      const oldRowsAfterKill = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.oldCandidateId },
      });
      expect(oldRowsAfterKill).toHaveLength(PE_COUNT);
      expect(oldRowsAfterKill.every((r) => r.status === 'superseded')).toBe(true);
      const distinctRevokedAt = new Set(oldRowsAfterKill.map((r) => r.revokedAt?.toISOString()));
      expect(distinctRevokedAt.size).toBe(1); // superseded exactly once, in one commit

      const newRowsAfterKill = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId },
      });
      expect(newRowsAfterKill.length).toBeGreaterThanOrEqual(5);
      expect(newRowsAfterKill.length).toBeLessThan(PE_COUNT); // genuinely partial -- the kill landed mid-loop
      expect(newRowsAfterKill.every((r) => r.status === 'active')).toBe(true);

      const correctionsAfterKill = await prisma.budgetCandidateCorrectionV1.findMany({
        where: { oldCandidateId: fx.oldCandidateId },
      });
      expect(correctionsAfterKill).toHaveLength(1);

      // Run 2: the SAME script, SAME manifest, SAME candidate pair -- must
      // complete the remainder and reach N of N, with ZERO double-commits
      // and ZERO re-supersession of the already-superseded old rows.
      const run2 = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ]);
      expect(run2.status).toBe(0);
      // The per-PE ledger (APPROVED/ALREADY_APPROVED/FAILED) and the JSON
      // preview go to stdout; the correction-step and final-summary lines
      // go to stderr (see the script's own `console.error` calls) -- check
      // the combined transcript, exactly as an operator watching a terminal
      // would read it.
      const run2Transcript = `${run2.stdout}\n${run2.stderr}`;
      expect(run2Transcript).toContain(
        `${PE_COUNT} of ${PE_COUNT} manifest scopes were observed active`,
      );
      expect(run2Transcript).toContain('already_recorded'); // step 1 replayed as a no-op

      const oldRowsFinal = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.oldCandidateId },
      });
      expect(oldRowsFinal).toHaveLength(PE_COUNT);
      expect(oldRowsFinal.every((r) => r.status === 'superseded')).toBe(true);
      // Exactly-once supersession, even across TWO `correct({commit:true})`
      // calls (the killed run's own attempt, plus this resume's replay):
      // the revocation timestamp must be identical to what run 1 already
      // produced, never advanced by the idempotent replay.
      expect(new Set(oldRowsFinal.map((r) => r.revokedAt?.toISOString()))).toEqual(
        distinctRevokedAt,
      );

      const newRowsFinal = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId },
      });
      expect(newRowsFinal).toHaveLength(PE_COUNT);
      expect(newRowsFinal.every((r) => r.status === 'active')).toBe(true);
      expect(new Set(newRowsFinal.map((r) => r.scopeKey)).size).toBe(PE_COUNT); // no duplicates

      // Every review id present after the kill is STILL present, unchanged,
      // after the resume -- run 2 never re-committed (and thus never
      // recreated) anything run 1 already did.
      const idsAfterKill = new Set(newRowsAfterKill.map((r) => r.id));
      const idsFinal = new Set(newRowsFinal.map((r) => r.id));
      for (const id of idsAfterKill) expect(idsFinal.has(id)).toBe(true);

      const correctionsFinal = await prisma.budgetCandidateCorrectionV1.findMany({
        where: { oldCandidateId: fx.oldCandidateId },
      });
      expect(correctionsFinal).toHaveLength(1);
      expect(correctionsFinal[0]!.id).toBe(correctionsAfterKill[0]!.id); // same link, never a second one
    }, 120_000);

    it('an ALREADY_APPROVED entry revoked after resume skips it is caught by all-scope observed-at reconciliation', async () => {
      const fx = await buildFixture(93000);

      // Seed a genuine crash/resume state with the SAME full manifest. Exact
      // correction intent includes the selected scope set, so a one-scope
      // seed followed by a 17-scope resume is (correctly) a different
      // operation. Kill the real process after its first durable approval
      // instead, then choose a scope that is still missing as the blocker.
      const seedArgs = [
        '--import',
        'tsx',
        SCRIPT_PATH,
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, seedArgs, {
          cwd: join(__dirname, '..'),
          env: { ...process.env },
        });
        let stdout = '';
        let killed = false;
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('seed run never produced an APPROVED line'));
        }, 60_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (!killed && /^APPROVED\b/m.test(stdout)) {
            killed = true;
            clearTimeout(timeout);
            child.kill('SIGKILL');
          }
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          if (!killed) reject(new Error('seed run exited before its first durable approval'));
          else resolve();
        });
        child.once('error', reject);
      });

      const firstScope = {
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: fx.peCodes[0]!,
        fiscalYear: FISCAL_YEAR,
        fundingField: 'request' as const,
        component: COMPONENT,
      };
      const firstScopeKey = scopedFactReviewScopeKeyV1(firstScope);
      const firstReview = await prisma.budgetScopedFactReviewV1.findFirstOrThrow({
        where: { candidateId: fx.newCandidateId, scopeKey: firstScopeKey, status: 'active' },
      });
      const activeAfterSeed = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId, status: 'active' },
        select: { scopeKey: true },
      });
      expect(activeAfterSeed.length).toBeGreaterThanOrEqual(1);
      expect(activeAfterSeed.length).toBeLessThan(PE_COUNT);
      const activeScopeKeys = new Set(activeAfterSeed.map((row) => row.scopeKey));
      const blockedIndex = fx.peCodes.findIndex(
        (peCode) =>
          !activeScopeKeys.has(
            scopedFactReviewScopeKeyV1({
              scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
              peCode,
              fiscalYear: FISCAL_YEAR,
              fundingField: 'request',
              component: COMPONENT,
            }),
          ),
      );
      expect(blockedIndex).toBeGreaterThanOrEqual(0);
      const blockedScope = {
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: fx.peCodes[blockedIndex]!,
        fiscalYear: FISCAL_YEAR,
        fundingField: 'request' as const,
        component: COMPONENT,
      };
      const blockedScopeKey = scopedFactReviewScopeKeyV1(blockedScope);
      // Deterministic interleaving: hold an exact missing-scope advisory lock
      // without touching the candidate row. The resumed CLI can record its
      // correction replay and classify the first scope ALREADY_APPROVED, but
      // its second-scope commit cannot cross the authoritative write boundary
      // until this transaction releases that lock. We revoke the skipped
      // first review during that controlled interval, then release the child
      // to finish and reconcile.
      let signalBlockerReady!: () => void;
      const blockerReady = new Promise<void>((resolve) => {
        signalBlockerReady = resolve;
      });
      let releaseBlocker!: () => void;
      const blockerMayRollback = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      const blockerTx = prisma.$transaction(
        async (tx) => {
          const lockKey = `budget_scoped_fact_review_v1:${SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1}:${blockedScopeKey}`;
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS acquired`,
          );
          signalBlockerReady();
          await blockerMayRollback;
        },
        { timeout: 60_000, maxWait: 30_000 },
      );
      await blockerReady;

      const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      const args = [
        '--import',
        'tsx',
        SCRIPT_PATH,
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ];

      let stdout = '';
      let stderr = '';
      let revocationStarted = false;
      let revocationPromise: Promise<unknown> = Promise.resolve();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: join(__dirname, '..'),
          env: { ...process.env },
        });
        const timeout = setTimeout(() => {
          releaseBlocker();
          reject(new Error('resume never emitted the expected ALREADY_APPROVED line'));
        }, 60_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (
            !revocationStarted &&
            stdout.includes(`ALREADY_APPROVED  ${firstScopeKey}  review=${firstReview.id}`)
          ) {
            revocationStarted = true;
            clearTimeout(timeout);
            revocationPromise = (async () => {
              try {
                let childObservedWaiting = false;
                const waitDeadline = Date.now() + 20_000;
                while (Date.now() < waitDeadline) {
                  const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
                    SELECT count(*)::bigint AS count
                      FROM pg_stat_activity
                     WHERE datname = current_database()
                       AND pid <> pg_backend_pid()
                       AND wait_event_type = 'Lock'
                  `);
                  if ((waiting[0]?.count ?? 0n) > 0n) {
                    childObservedWaiting = true;
                    break;
                  }
                  await new Promise((waitResolve) => setTimeout(waitResolve, 20));
                }
                expect(childObservedWaiting).toBe(true);
                const row = await reviews.revoke({
                  id: firstReview.id,
                  actor: 'human-after-skip@capiro.ai',
                  reason:
                    'deterministic known-gap proof: revoked after resume skipped this active row',
                  now: new Date().toISOString(),
                });
                expect(row?.status).toBe('revoked');
              } finally {
                releaseBlocker();
              }
            })();
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('exit', (code) => resolve(code));
        child.on('error', (error) => {
          releaseBlocker();
          reject(error);
        });
      });
      await Promise.all([revocationPromise, blockerTx]);

      expect(revocationStarted).toBe(true);
      expect(exitCode).toBe(EXIT_RECONCILIATION_FAILED);
      expect(`${stdout}\n${stderr}`).toContain(firstScopeKey);
      const finalFirst = await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({
        where: { id: firstReview.id },
      });
      expect(finalFirst.status).toBe('revoked');
      expect(finalFirst.revokedBy).toBe('human-after-skip@capiro.ai');
    }, 120_000);

    it("HARDENING (2026-09-19): a human revoking one of THIS RUN's own approvals refuses to silently re-create it on re-run -- requires --acknowledge-revoked-scope", async () => {
      const fx = await buildFixture(94000);
      const run1 = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ]);
      expect(run1.status).toBe(0);

      const scope = {
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: fx.peCodes[0]!,
        fiscalYear: FISCAL_YEAR,
        fundingField: 'request' as const,
        component: COMPONENT,
      };
      const scopeKey = scopedFactReviewScopeKeyV1(scope);
      const targetReview = await prisma.budgetScopedFactReviewV1.findFirstOrThrow({
        where: { candidateId: fx.newCandidateId, scopeKey, status: 'active' },
      });

      // A real human, via the real revoke path -- not a mock, not a raw SQL
      // shortcut -- decides this specific approved total was wrong.
      const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      const revoked = await reviews.revoke({
        id: targetReview.id,
        actor: 'human-reviewer@capiro.ai',
        reason: 'discovered this PE total was miscomputed after approval',
        now: new Date().toISOString(),
      });
      expect(revoked?.status).toBe('revoked');

      // Re-run the SAME manifest, SAME candidate pair, WITHOUT acknowledging
      // the revocation -- must NOT silently recreate the approval.
      const run2 = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ]);
      expect(run2.status).toBe(EXIT_PARTIAL);
      const run2Transcript = `${run2.stdout}\n${run2.stderr}`;
      expect(run2Transcript).toContain('REFUSED_UNACKNOWLEDGED_REVOCATION');
      expect(run2Transcript).toContain(scopeKey);
      expect(run2Transcript).toContain('--acknowledge-revoked-scope');

      // Still no NEW active approval for this scope -- the revoked row is
      // exactly as the human left it, and nothing silently replaced it.
      const stillNoActive = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId, scopeKey, status: 'active' },
      });
      expect(stillNoActive).toHaveLength(0);
      const revokedRowUnchanged = await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({
        where: { id: targetReview.id },
      });
      expect(revokedRowUnchanged.status).toBe('revoked');
      expect(revokedRowUnchanged.revokedBy).toBe('human-reviewer@capiro.ai');

      // Re-run a THIRD time, this time WITH the explicit, scope-named
      // acknowledgment -- the documented, forward-only way to intentionally
      // re-approve it (never a rollback of the revocation itself).
      const freshIntentManifest = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
      freshIntentManifest.entries[0].rationale =
        'fixture: fresh reviewer action after reading the recorded revocation and correcting the reviewed scope';
      fs.writeFileSync(fx.manifestPath, JSON.stringify(freshIntentManifest, null, 2));
      const run3 = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
        '--acknowledge-revoked-scope',
        `${scopeKey}=${targetReview.id}`,
      ]);
      expect(run3.status).toBe(0);

      const newActive = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId, scopeKey, status: 'active' },
      });
      expect(newActive).toHaveLength(1);
      expect(newActive[0]!.id).not.toBe(targetReview.id); // a NEW row, forward reconstruction -- never an undo of the revocation

      const allForScope = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId, scopeKey },
        orderBy: { createdAt: 'asc' },
      });
      expect(allForScope).toHaveLength(2); // the original (now revoked) row, plus the new acknowledged one -- full history preserved
      expect(allForScope[0]!.status).toBe('revoked');
      expect(allForScope[1]!.status).toBe('active');
      expect(allForScope[1]!.acknowledgedRevokedReviewId).toBe(targetReview.id);
    }, 120_000);

    it('HARDENING (2026-09-19): a human revokes an approval WHILE this run is still committing the rest -- the run refuses to declare success and names the scope (exit 3)', async () => {
      const fx = await buildFixture(96000);
      const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      const blockedScope = {
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: fx.peCodes[3]!,
        fiscalYear: FISCAL_YEAR,
        fundingField: 'request' as const,
        component: COMPONENT,
      };
      const blockedScopeKey = scopedFactReviewScopeKeyV1(blockedScope);
      let signalBlockerReady!: () => void;
      const blockerReady = new Promise<void>((resolve) => {
        signalBlockerReady = resolve;
      });
      let releaseBlocker!: () => void;
      const blockerMayCommit = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      const blocker = prisma.$transaction(
        async (tx) => {
          const lockKey = `budget_scoped_fact_review_v1:${SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1}:${blockedScopeKey}`;
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS acquired`,
          );
          signalBlockerReady();
          await blockerMayCommit;
        },
        {
          maxWait: 30_000,
          timeout: 60_000,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );
      await blockerReady;

      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          SCRIPT_PATH,
          '--old-candidate-id',
          fx.oldCandidateId,
          '--new-candidate-id',
          fx.newCandidateId,
          '--reapproval-manifest',
          fx.manifestPath,
          '--actor',
          'neo@capiro.ai',
          '--reviewer-id',
          'neo@capiro.ai',
          '--correction-reason-file',
          fx.reasonPath,
          '--commit',
        ],
        { cwd: join(__dirname, '..'), env: { ...process.env } },
      );
      const childExit = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      let stdout = '';
      let stderr = '';
      let signalFirstApproval!: (value: { scopeKey: string; reviewId: string }) => void;
      const firstApproval = new Promise<{ scopeKey: string; reviewId: string }>((resolve) => {
        signalFirstApproval = resolve;
      });
      let firstApprovalObserved = false;
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (!firstApprovalObserved) {
          const match = /^APPROVED\s+(\S+)\s+review=(\S+)/m.exec(stdout);
          if (match != null) {
            firstApprovalObserved = true;
            signalFirstApproval({ scopeKey: match[1]!, reviewId: match[2]! });
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      let revokedScopeKey: string;
      let revokedReviewId: string;
      try {
        const first = await Promise.race([
          firstApproval,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('run never produced its first APPROVED line')),
              60_000,
            ),
          ),
        ]);
        revokedScopeKey = first.scopeKey;
        revokedReviewId = first.reviewId;
        let childWaiting = false;
        const waitDeadline = Date.now() + 20_000;
        while (Date.now() < waitDeadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            SELECT count(*)::bigint AS count
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'
          `);
          if ((waiting[0]?.count ?? 0n) > 0n) {
            childWaiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(childWaiting).toBe(true);
        const revoked = await reviews.revoke({
          id: revokedReviewId,
          actor: 'human-mid-run@capiro.ai',
          reason: 'operator caught this one while the exact fourth scope was blocked',
          now: new Date().toISOString(),
        });
        expect(revoked?.status).toBe('revoked');
      } finally {
        releaseBlocker();
      }

      const exitCode = await childExit;
      await blocker;
      expect(exitCode).toBe(EXIT_RECONCILIATION_FAILED);
      expect(stderr).toContain(
        `RECONCILIATION_CONFLICT  ${revokedScopeKey}  review=${revokedReviewId}`,
      );
      expect(stdout).toContain('--- ledger summary ---');
      expect(stdout).toContain(`RECONCILIATION_CONFLICT  ${revokedScopeKey}`);
      expect(stderr).toContain(`Named scope keys: [${revokedScopeKey}]`);
      const finalRow = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId, scopeKey: revokedScopeKey },
      });
      expect(finalRow).toHaveLength(1);
      expect(finalRow[0]!.status).toBe('revoked');
      expect(finalRow[0]!.revokedBy).toBe('human-mid-run@capiro.ai');
    }, 120_000);

    it('BA3-shaped disposable rehearsal: 21 explicitly bound scopes complete and reconcile from one observed snapshot', async () => {
      const fx = await buildFixture(97000, 21);
      const run = runScriptSync([
        '--old-candidate-id',
        fx.oldCandidateId,
        '--new-candidate-id',
        fx.newCandidateId,
        '--reapproval-manifest',
        fx.manifestPath,
        '--actor',
        'neo@capiro.ai',
        '--reviewer-id',
        'neo@capiro.ai',
        '--correction-reason-file',
        fx.reasonPath,
        '--commit',
      ]);
      expect(run.status).toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toContain(
        '21 of 21 manifest scopes were observed active',
      );
      const rows = await prisma.budgetScopedFactReviewV1.findMany({
        where: { candidateId: fx.newCandidateId },
      });
      expect(rows).toHaveLength(21);
      expect(rows.every((row) => row.status === 'active' && row.decision === 'approve')).toBe(true);
      expect(new Set(rows.map((row) => row.scopeKey)).size).toBe(21);
    }, 120_000);
  },
);
