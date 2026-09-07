/**
 * Phase 10B-31 -- ONE-OFF DIAGNOSTIC investigation (not a CI gate, not part
 * of `verify:pe-budget-phase-10b31`): drives the REAL, unmodified,
 * end-to-end lifecycle-bridge pipeline (`DefaultParserHandoffAdapter` ->
 * `runParserHandoffForSourceDocument` -> the REAL Python parser runtime ->
 * `ParserRouterV1Service` -> `BudgetVerificationV1Service` with
 * `CompositeProofResolver` in `production_proof` mode) against the REAL,
 * committed FY2024 Army R-2 canary PDF fixture
 * (apps/api/src/defense-budget/rdte/cycle/__fixtures__/production-fy2024-army-r2-vol1-ba1-official.pdf,
 * sha256 1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6 --
 * byte-identical to the real production canary, confirmed against the
 * DB-inspection evidence recovered by the prior stage), to check whether the
 * corrected metadata-agreement fix lets this candidate reach the
 * known-good REVIEW profile from PR #1486 / Phase 10B-28 (before the
 * metadata bug blocked it): 611 assertions, 5 identities, 467
 * ambiguous_layout omissions, PE 0601102A FY2024 $296.67M.
 *
 * This is a FRESH re-parse of the full 170-page document through the real
 * parser runtime (~minutes) -- NOT a reuse of any previously-recorded OCR
 * output, and NOT a release-image qualification claim.
 *
 * Unlike the permanent regression spec, THIS script sets real archive fields
 * on the local SourceDocument row -- the REAL production canary's own
 * archiveBucket/archiveS3Key/archiveVersionId, which point at bytes already
 * durably archived (Object-Lock, retained until 2033) by a prior, separately
 * authorized ingestion run. `CompositeProofResolver`'s archive-proof step
 * therefore makes a genuine, READ-ONLY HeadObject/GetObject call against
 * that ALREADY-EXISTING object through the approved `capiro-dev` AWS
 * profile -- confirmed reachable via `aws s3api head-object` before this
 * script existed. This is the ONE place in this phase's regression work that
 * makes a live AWS call; every other script in this phase (the permanent
 * spec, the mutation-regression runner) makes none. It writes nothing to
 * S3, replays no outbox row, and touches no production database.
 *
 * Requires: DATABASE_URL (local disposable Postgres, both prisma schemas
 * migrated), AWS_PROFILE=capiro-dev (or equivalent read-only credentials)
 * resolvable via the default AWS SDK credential chain, and
 * apps/defense-budget-parser pre-synced (`uv sync --locked`).
 *
 * Counts reported here are DIAGNOSTIC. A matching count is not, by itself,
 * proof of correctness -- see the mission notes on this point. Any deviation
 * from the known-good profile is reported, not silently reconciled.
 *
 * ── RESULT OF THE 2026-09-07 INVESTIGATION (recorded here for the next
 *    reader; rerun this script to reconfirm rather than trusting this
 *    comment indefinitely) ──────────────────────────────────────────────
 * The metadata-agreement fix itself is PROVEN correct against the real
 * canary: `proof_findings` evidence is an EMPTY array, and the `manifest`,
 * `source_document`, `extraction_artifact`, and (genuinely, via the real
 * read-only S3 check above) `archive` proofs are all `verified`. The
 * specific bug this phase fixed -- the sourceKey/component metadata
 * disagreement that originally blocked this exact candidate -- no longer
 * fires.
 *
 * However, overall `decision` resolves REJECT, not REVIEW, and the counts
 * deviate from the PR #1486 profile: 590 assertions (not 611), 466
 * ambiguous_layout omissions (not 467), plus 39 BLOCKING omissions (38
 * `missing_evidence` + 1 `missing_value`) that force REJECT via the
 * `completeness` check ("Phase 3 did not select a parser result for
 * physical page N" for several pages, plus a couple of genuine multi-PE-
 * header/narrative ambiguities). This is NOT a Phase 10B-31 regression: the
 * SAME 590/505-omission result is independently reproduced by
 * `src/defense-budget/rdte/cycle/r2-production-path-no-override.spec.ts` --
 * an already-existing, unrelated test this phase did not meaningfully touch
 * (a 1-line sourceKey addition only) -- confirming the parser/router
 * codebase's output for this PDF has genuinely drifted since the PR #1486
 * baseline was captured, for reasons entirely outside source-document
 * metadata agreement. The PE 0601102A FY2024 request value itself is exactly
 * right ($296.67M, cross-confirmed by that same existing spec). Repeated
 * runs of this script also produce a DIFFERENT candidateId each time despite
 * an identical 590/505/$296.67M substantive result, implying the artifact
 * schema embeds some non-substantive, run-varying value (e.g. a timestamp)
 * into what gets content-hashed -- also unrelated to this phase's fix, not
 * investigated further here.
 *
 * Bottom line for whoever eventually decides production remediation for
 * outbox row f57a3419-3d7b-404e-92e4-4932f5e3f524: once the Stage 2 fix is
 * merged/deployed and this row is reprocessed, expect REJECT (blocking
 * completeness failures from current parser/router behavior on specific
 * pages), not the REVIEW this investigation was checking for -- and that
 * REJECT has nothing to do with source-document metadata. Deciding whether
 * to fix that parser/router drift is separate, unauthorized-here work.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DefaultParserHandoffAdapter } from '../src/defense-budget/default-parser-handoff.adapter.js';

const REAL_CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
const REAL_SOURCE_DOCUMENT_ID = 'a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0';
const REAL_SOURCE_KEY =
  'defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4';
const REAL_SHA256 = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const REAL_SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';
const REAL_ARCHIVE_BUCKET = 'capiro-defense-budget-raw-dev-967807252336';
const REAL_ARCHIVE_KEY =
  'raw/public/dod-budget/fiscal_year=2024/source_authority=dod-comptroller/family=rdte/document_id=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4/sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6/original.bin';
const REAL_ARCHIVE_VERSION_ID = 'QN5S2.UB7ez8f6E4xrZxYoBrtW7Nf14s';
const FIXTURE_PDF_PATH = join(
  __dirname,
  '..',
  'src',
  'defense-budget',
  'rdte',
  'cycle',
  '__fixtures__',
  'production-fy2024-army-r2-vol1-ba1-official.pdf',
);
const KNOWN_GOOD_PROFILE = {
  decision: 'REVIEW',
  totalAssertions: 611,
  identityCount: 5,
  ambiguousLayoutOmissions: 467,
  targetPe: '0601102A',
  targetPeFiscalYear: 2024,
  targetPeTotalMillions: 296.67,
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required (local disposable Postgres).');
  try {
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(databaseUrl).hostname)) {
      throw new Error('refusing to run against a non-local DATABASE_URL');
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('refusing')) throw e;
    throw new Error(`DATABASE_URL is not a valid URL: ${databaseUrl}`);
  }

  if (!existsSync(FIXTURE_PDF_PATH)) throw new Error(`missing real-PDF fixture at ${FIXTURE_PDF_PATH}`);
  const pdfBytes = readFileSync(FIXTURE_PDF_PATH);
  const actualSha256 = createHash('sha256').update(pdfBytes).digest('hex');
  if (actualSha256 !== REAL_SHA256) {
    throw new Error(`fixture PDF SHA drifted: expected ${REAL_SHA256}, got ${actualSha256}`);
  }

  const outerDir = mkdtempSync(join(tmpdir(), 'phase10b31-real-canary-'));
  const parserArtifactRoot = join(outerDir, 'parser-artifact-root');
  mkdirSync(parserArtifactRoot, { recursive: true });
  process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = parserArtifactRoot;
  process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = join(__dirname, '..', '..', 'defense-budget-parser');
  const workDir = join(parserArtifactRoot, 'work');
  mkdirSync(workDir, { recursive: true });
  const sourcePath = join(workDir, 'source.pdf');
  writeFileSync(sourcePath, pdfBytes);

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();

  try {
    const existing = await prisma.sourceDocument.findUnique({ where: { id: REAL_SOURCE_DOCUMENT_ID } });
    if (!existing) {
      await prisma.sourceDocument.create({
        data: {
          id: REAL_SOURCE_DOCUMENT_ID,
          sourceKey: REAL_SOURCE_KEY,
          fiscalYear: 2024,
          budgetCycle: 'pb',
          component: 'ARMY',
          documentType: 'r2',
          title: 'FY2024 ARMY RDT&E R-2 exhibits (real canary, local mirror for diagnostic review)',
          sourceUrl: REAL_SOURCE_URL,
          sha256: REAL_SHA256,
          byteSize: pdfBytes.length,
          extractionMethod: 'llamaparse',
          archiveBucket: REAL_ARCHIVE_BUCKET,
          archiveS3Key: REAL_ARCHIVE_KEY,
          archiveVersionId: REAL_ARCHIVE_VERSION_ID,
        },
      });
      console.error(`Registered local mirror of the real canary SourceDocument (${REAL_SOURCE_DOCUMENT_ID}).`);
    } else {
      console.error(`Reusing already-registered local mirror of the real canary SourceDocument.`);
    }

    const adapter = new DefaultParserHandoffAdapter({ workDir, maxEscalationRounds: 4 });
    console.error('Running the REAL adapter against the full 170-page real canary PDF (this takes several minutes)...');
    const t0 = Date.now();
    const result = await adapter.handoff({
      cycleId: REAL_CYCLE_ID,
      sourceDocumentId: REAL_SOURCE_DOCUMENT_ID,
      sourceSha256: REAL_SHA256,
      sourcePath,
      fiscalYear: 2024,
      authorityTrack: 'request',
      stage: 'president_budget_request',
      sourceFamily: 'pb_r2',
      title: 'r2',
      sourceUrl: REAL_SOURCE_URL,
      sourceKey: REAL_SOURCE_KEY,
      component: 'ARMY',
    });
    const elapsedMs = Date.now() - t0;
    console.error(`handoff completed in ${Math.round(elapsedMs / 1000)}s: decision=${result.decision} finalState=${result.finalState}`);

    const artifact = JSON.parse(readFileSync(result.artifactLocator, 'utf8')) as {
      assertions: Array<{ assertionKind: string; identity?: { peCode?: string }; fieldName?: string; value?: { peCode?: string; fiscalYear?: number; rowKind?: string; valueMillions?: string }; fiscalYear?: number; field?: string; money?: { valueMillions?: string } }>;
      omissions: Array<{ reason: string }>;
    };
    const identities = artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity');
    const targetIdentity = identities.find((a) => a.identity?.peCode === KNOWN_GOOD_PROFILE.targetPe);
    // Mirrors r2-production-path-no-override.spec.ts's own lookup (the
    // R-2 total-component document_fact, not a raw funding assertion) --
    // that existing, unrelated test already proves this exact value is
    // correctly extracted for this PDF under the current parser.
    const targetTotalFact = artifact.assertions.find(
      (a) =>
        a.assertionKind === 'document_fact' &&
        a.fieldName === 'r2_total_component' &&
        a.value?.peCode === KNOWN_GOOD_PROFILE.targetPe &&
        a.value?.fiscalYear === KNOWN_GOOD_PROFILE.targetPeFiscalYear &&
        a.value?.rowKind === 'pe_total',
    );
    const ambiguousLayoutOmissions = artifact.omissions.filter((o) => o.reason === 'ambiguous_layout').length;
    const omissionsByReason: Record<string, number> = {};
    for (const o of artifact.omissions) omissionsByReason[o.reason] = (omissionsByReason[o.reason] ?? 0) + 1;
    console.error('omissionsByReason:', JSON.stringify(omissionsByReason));

    const candidateRows = await prisma.$queryRawUnsafe<
      Array<{ id: string; status: string; cycle_id: string }>
    >(
      `SELECT id, status, cycle_id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      REAL_SOURCE_DOCUMENT_ID,
    );
    const proofRows = candidateRows.length
      ? await prisma.$queryRawUnsafe<Array<{ proof_kind: string; status: string; evidence_jsonb: unknown }>>(
          `SELECT proof_kind, status, evidence_jsonb FROM budget_verification_proof
             WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id = $1::uuid)`,
          candidateRows[0]!.id,
        )
      : [];

    const observed = {
      decision: result.decision,
      totalAssertions: artifact.assertions.length,
      identityCount: identities.length,
      ambiguousLayoutOmissions,
      targetPeTitle: targetIdentity ? (targetIdentity as { title?: string }).title : null,
      targetPeTotalMillions: targetTotalFact?.value?.valueMillions
        ? Number(targetTotalFact.value.valueMillions)
        : null,
      elapsedSeconds: Math.round(elapsedMs / 1000),
      candidateId: candidateRows[0]?.id ?? null,
      candidateStatus: candidateRows[0]?.status ?? null,
      candidateCycleId: candidateRows[0]?.cycle_id ?? null,
    };

    const deviations: string[] = [];
    if (observed.decision !== KNOWN_GOOD_PROFILE.decision) {
      deviations.push(`decision: expected ${KNOWN_GOOD_PROFILE.decision}, got ${observed.decision}`);
    }
    if (observed.totalAssertions !== KNOWN_GOOD_PROFILE.totalAssertions) {
      deviations.push(`totalAssertions: expected ${KNOWN_GOOD_PROFILE.totalAssertions}, got ${observed.totalAssertions}`);
    }
    if (observed.identityCount !== KNOWN_GOOD_PROFILE.identityCount) {
      deviations.push(`identityCount: expected ${KNOWN_GOOD_PROFILE.identityCount}, got ${observed.identityCount}`);
    }
    if (observed.ambiguousLayoutOmissions !== KNOWN_GOOD_PROFILE.ambiguousLayoutOmissions) {
      deviations.push(
        `ambiguousLayoutOmissions: expected ${KNOWN_GOOD_PROFILE.ambiguousLayoutOmissions}, got ${observed.ambiguousLayoutOmissions}`,
      );
    }
    if (observed.targetPeTotalMillions !== null && Math.abs(observed.targetPeTotalMillions - KNOWN_GOOD_PROFILE.targetPeTotalMillions) > 0.005) {
      deviations.push(
        `targetPeTotalMillions: expected ${KNOWN_GOOD_PROFILE.targetPeTotalMillions}, got ${observed.targetPeTotalMillions}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          knownGoodProfile: KNOWN_GOOD_PROFILE,
          observed,
          deviations,
          proofSnapshots: proofRows,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
    rmSync(outerDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exitCode = 1;
});
