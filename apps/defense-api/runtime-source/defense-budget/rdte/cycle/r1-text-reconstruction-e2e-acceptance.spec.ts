/**
 * Phase 10B-11 -- production-equivalent E2E acceptance gate for R-1 text
 * reconstruction. The hand-constructed `ParsedTableV1` regression in PR
 * #1350 (`rdte-durable-semantic-artifact-factory-v1.spec.ts`) was explicitly
 * insufficient to prove the production canary is fixed, because it never
 * exercised the real parser's actual output shape.
 *
 * This test does NOT synthesize table cells. It:
 *   1. Materializes the exact archived FY2024 R-1 SourceDocument bytes
 *      (SHA-verified against the production archive before this test ran),
 *   2. Drives them through the REAL `deterministic_pdfplumber` /
 *      pdfplumber-0.11.0 parser runtime -- the same
 *      `runParserHandoffForSourceDocument` entrypoint
 *      `DefaultParserHandoffAdapter` calls in production, so the REAL
 *      `ParserRouterV1Service` performs profiling, execution, composition,
 *      Phase 2 verification, AND this PR's `artifactFactory` wiring exactly
 *      as production would (`persistVerificationAudit: false` only to avoid
 *      needing a live database/S3 for this local proof -- nothing about the
 *      parser, compositor, or semantic-extraction code path is bypassed).
 *
 * Production recorded this exact source SHA against a real
 * `deterministic_pdfplumber` DocumentParseJob (parserConfigSha256
 * 3bc9df29aec9638eee25da1d99832c01f59b1c1d99f0a0346f74cf16975ce9b1, 114/114
 * pages succeeded) -- but only its hash fingerprint, not durable output
 * bytes, survived (the /tmp scratch path died with that ephemeral
 * container). Preferred-input-order option 1 (reuse the exact durable
 * output) is therefore unavailable; this is option 2 -- re-running the
 * identical parser version/config against the identical archived bytes.
 * `PDFPLUMBER_ENGINE_VERSION` in engine_versions.py is a hardcoded label
 * ('pdfplumber-0.11.0'), not derived from the installed package version, so
 * there is no meaningful engine-identity drift between what this checkout
 * runs and what production ran.
 *
 * Uses `component: undefined` (-> 'UNKNOWN'), matching what production
 * actually recorded for this consolidated, multi-service DoD-wide R-1 --
 * this proof must not depend on stamping the document ARMY.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runParserHandoffForSourceDocument } from '../../parser-router/source-document-parser-handoff.js';
import { reconstructR1TablesFromTextV1 } from '../r1/r1-text-row-reconstructor-v1.js';
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../../verification/trusted-proof/trusted-proof-types.js';
import type { BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

const SOURCE_SHA = 'ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425';
const SOURCE_DOCUMENT_ID = '62e8a102-4f01-471b-9cb6-eab58cb41270';
const CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
const SOURCE_URL = 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf';
const FIXTURE_PDF_PATH = join(
  __dirname,
  '__fixtures__',
  'production-fy2024-r1-official.pdf',
);
const PARSER_PROJECT_DIR = resolve(__dirname, '../../../../..', 'defense-budget-parser');

function requireRealPdfFixture(): string {
  if (!existsSync(FIXTURE_PDF_PATH)) {
    throw new Error(
      `missing real-PDF fixture at ${FIXTURE_PDF_PATH} -- this acceptance test requires the ` +
        `actual archived FY2024 R-1 bytes, not a placeholder; materialize them from the ` +
        `production archive (sha256=${SOURCE_SHA}) before running`,
    );
  }
  const bytes = readFileSync(FIXTURE_PDF_PATH);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== SOURCE_SHA) {
    throw new Error(`real-PDF fixture SHA drifted: expected ${SOURCE_SHA}, got ${sha}`);
  }
  return FIXTURE_PDF_PATH;
}

class RealArtifactVerificationResolver implements TrustedVerificationProofResolverV1 {
  constructor(private readonly artifact: DefenseBudgetExtractionArtifactV1) {}
  async resolve(): Promise<TrustedProofResolutionV1> {
    const manifestDocument = {
      documentKey: SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r1',
      sourceLocator: SOURCE_URL,
      expectedSourceSha256: SOURCE_SHA,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'UNKNOWN',
      budgetCycle: 'pb',
      documentType: 'r1',
      parserPolicy: 'deterministic_table',
      requiredDataCategories: ['identity', 'funding'],
      requiredFundingFields: ['request'],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    };
    return {
      manifest: {
        schemaVersion: 'defense_budget_cycle_manifest_v1',
        cycleId: CYCLE_ID,
        fiscalYear: 2024,
        domain: 'defense',
        documents: [manifestDocument],
      } as never,
      manifestDocument: manifestDocument as never,
      manifestContentSha256: 'e'.repeat(64),
      artifact: this.artifact,
      extractionArtifactByteSha256: this.artifact.contentSha256,
      extractionArtifactContentSha256: this.artifact.contentSha256,
      proofBundle: {
        manifest: {
          locator: 'synthetic://manifest',
          contentSha256: 'e'.repeat(64),
          cycleId: CYCLE_ID,
          fiscalYear: 2024,
          documentKey: SOURCE_DOCUMENT_ID,
        },
        extractionArtifact: {
          artifactId: this.artifact.artifactId,
          locator: 'synthetic://artifact',
          contentSha256: this.artifact.contentSha256,
          byteSha256: this.artifact.contentSha256,
        },
        sourceDocument: { id: SOURCE_DOCUMENT_ID, sourceKey: SOURCE_DOCUMENT_ID, sourceSha256: SOURCE_SHA },
        archive: { status: 'not_applicable' },
        parserRuns: this.artifact.parserRuns.map((run) => ({
          parserRunId: run.parserRunId,
          method: run.method,
          proofStatus: 'verified' as const,
        })),
        resolvedReferenceArtifacts: [],
      } as never,
      proofFindings: [],
      referenceArtifacts: [],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
    };
  }
}

describe('Phase 10B-11 acceptance -- real deterministic_pdfplumber output through the real pipeline, WITH R-1 text reconstruction wired in', () => {
  jest.setTimeout(180_000);

  it('extracts real PE identities and FY2024 request funding from the real archived PDF, and resolves the production defect through the real verifier', async () => {
    const pdfPath = requireRealPdfFixture();
    const workDir = mkdtempSync(join(tmpdir(), 'phase10b10-real-parser-'));
    const sourcePath = join(workDir, 'source.pdf');
    writeFileSync(sourcePath, readFileSync(pdfPath));

    const result = await runParserHandoffForSourceDocument({
      executionId: 'phase10b10-part-a2-real-parser',
      cycleId: CYCLE_ID,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourcePath,
      sourceSha256: SOURCE_SHA,
      sourceLocator: SOURCE_URL,
      sourceUrl: SOURCE_URL,
      sourceKey: SOURCE_DOCUMENT_ID,
      parserPolicy: 'deterministic_table',
      exhibitType: 'R-1',
      budgetFamily: 'rdte',
      fiscalYear: 2024,
      authority: 'dod-comptroller',
      // Deliberately omitted: production recorded component=UNKNOWN for this
      // consolidated, multi-service document. This proof must not depend on
      // (and must not silently launder in) component=ARMY.
      budgetCycle: 'pb',
      documentType: 'r1',
      title: 'r1',
      workDir,
      persistVerificationAudit: false,
      allowPaidParse: false,
      maxPaidPages: 0,
      parserProjectDir: PARSER_PROJECT_DIR,
    });

    const artifact = JSON.parse(readFileSync(result.outputPath, 'utf8')) as DefenseBudgetExtractionArtifactV1;

    // --- source identity ---
    expect(artifact.source.sourcePdfSha256).toBe(SOURCE_SHA);
    expect(artifact.source.component).toBe('UNKNOWN');

    // --- real extraction, not synthetic ---
    expect(artifact.assertions.length).toBeGreaterThan(0);
    const identities = artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity');
    expect(identities.length).toBeGreaterThan(0);
    const fundingRequests = artifact.assertions.filter(
      (a) => a.assertionKind === 'funding' && (a as { field?: string }).field === 'request' && (a as { fiscalYear?: number }).fiscalYear === 2024,
    );
    expect(fundingRequests.length).toBeGreaterThan(0);

    // Real PE identities from the official document -- not a hand-built
    // fixture value. 0601102A / Defense Research Sciences is the row this
    // workstream's forensics already confirmed on archived page 9; asserting
    // it here proves the REAL parser+extractor chain reproduces it, rather
    // than assuming a single hand-picked row generalizes.
    const knownRealPe = identities.find(
      (a) => (a as { identity?: { peCode?: string } }).identity?.peCode === '0601102A',
    ) as { title?: string } | undefined;
    expect(knownRealPe).toBeDefined();
    expect(knownRealPe?.title).toBe('Defense Research Sciences');

    // Same golden row's FY2024 request value: 296,670 (thousands) on the
    // real archived page = 296.67 million. A single identity match is not
    // sufficient acceptance on its own -- this proves the money column
    // mapping (not just the PE-code/title columns) survives the real
    // parser -> reconstructor -> extractor chain for a known-correct row.
    const knownRealFunding = fundingRequests.find(
      (a) => (a as { identity?: { peCode?: string } }).identity?.peCode === '0601102A',
    ) as { money?: { valueMillions?: string } } | undefined;
    expect(knownRealFunding).toBeDefined();
    expect(Number(knownRealFunding?.money?.valueMillions)).toBeCloseTo(296.67, 2);

    // --- original production defect resolved ---
    const verificationService = new BudgetVerificationV1Service(
      new RealArtifactVerificationResolver(artifact),
      null as unknown as BudgetVerificationRepositoryV1,
    );
    const verification = await verificationService.verify({
      manifestLocator: 'synthetic://manifest',
      manifestDocumentKey: SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: 'synthetic://artifact',
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      mode: 'inspect',
    });
    const byCode = new Map(verification.checks.map((c) => [c.code, c]));

    // --- the R-1 semantic extraction defect itself is resolved, not merely
    // masked: completeness must not fail from zero assertions, and
    // r1_specific must not fail from zero PE identities. This is the exact,
    // narrower claim this PR is required to prove -- NOT that every check
    // passes overall (see below: the remaining check failures are real,
    // pre-existing data/policy conditions, not extraction defects). ---
    expect(byCode.get('completeness')?.outcome).not.toBe('FAIL');
    expect(byCode.get('completeness')?.message).not.toMatch(/zero assertions/);
    const r1ZeroIdentityDiscrepancies = verification.discrepancies.filter(
      (d) => d.code === 'r1_zero_pe_identities',
    );
    expect(r1ZeroIdentityDiscrepancies).toHaveLength(0);

    // --- Phase 10B-12: r1_specific no longer treats PE 0604201F as "a
    // conflict" -- it is a real, legitimate cross-budget-activity split
    // (page 41 BA04 request 18,041; page 43 BA05 request 163,156; proven
    // from document structure, not inferred from the numbers -- a real
    // BA04 subtotal line ["Advanced Component Development & Prototypes"]
    // appears between the two rows, and each is independently rolled into
    // its own budget-activity subtotal). "Different legitimate BA/
    // component row identity is not automatically a conflict" (brief, Step
    // 6): the extractor's OWN conflict mechanism is now row-identity-aware
    // and no longer fires for this case. Reconciling it into one canonical
    // ProgramElementYear.request is deliberately left to the projection
    // layer (see the projection dry-run below), never resolved here. ---
    const r1SpecificConflicts = verification.discrepancies.filter(
      (d) => d.code === 'r1_duplicate_conflicting_value',
    );
    expect(r1SpecificConflicts).toHaveLength(0);
    expect(byCode.get('r1_specific')?.outcome).not.toBe('FAIL');

    // --- warning_policy: the same fix removes the only blocking extraction
    // warning that existed (r1_duplicate_conflicting_value for 0604201F),
    // so warning_policy no longer fails either. ---
    const blockingWarningDiscrepancies = verification.discrepancies.filter(
      (d) => d.code === 'blocking_extraction_warning',
    );
    expect(blockingWarningDiscrepancies).toHaveLength(0);
    expect(byCode.get('warning_policy')?.outcome).not.toBe('FAIL');

    // --- duplicate_detection now fully PASSES on the real document
    // (Phase 10B-13 part 2: verification-layer fix, stacked on this
    // branch). Before Phase 10B-12, 182 cross-page PE pairs collided here
    // (mostly the Defense-Wide roll-up volume restating an agency's own
    // chapter row, identical values -- a false alarm); Phase 10B-12's
    // extractor-level provenance merge eliminated 181 of those, leaving
    // exactly one genuine, real value difference (PE 0604201F, BA04
    // request 18,041 vs BA05 request 163,156). Phase 10B-13 proves that
    // remaining case is ALSO not a duplicate -- it is two truthfully
    // represented, independent constituent rows under different budget
    // activities, each rolling into its own real budget-activity subtotal
    // -- and makes the generic verifier's funding natural key row-aware
    // for `exhibit === 'R-1'` ONLY (never weakening it for any other
    // family, and never for an R-1 row missing this context). With that
    // fix, zero `duplicate_funding_natural_key` discrepancies remain. ---
    const naturalKeyDiscrepancies = verification.discrepancies.filter(
      (d) => d.code === 'duplicate_funding_natural_key',
    );
    expect(naturalKeyDiscrepancies).toHaveLength(0);
    expect(byCode.get('duplicate_detection')?.outcome).not.toBe('FAIL');

    // --- page_only_reconciliation resolves NOT_RUN, never FAIL: every
    // page-only money assertion this module produces is legitimately
    // unreconciled (no independently proved R-2 companion reference
    // artifact exists for this single-document test), which the rule
    // itself only ever treats as review-severity / NOT_RUN, matching the
    // brief's own named acceptable outcome ("page-only reconciliation ...
    // that is success for this PR"). ---
    expect(byCode.get('page_only_reconciliation')?.outcome).not.toBe('FAIL');

    // Reprint deduplication proof: 258 real PE codes appear on 2+ physical
    // pages (Phase 10B-12 forensics), but only ONE of them (0604201F) has a
    // genuine value difference. Every other cross-page PE with a resolved
    // FY2024 request must now produce exactly ONE funding assertion (the
    // provenance merge), not one per physical occurrence.
    const requestPeCodes = fundingRequests.map(
      (a) => (a as { identity?: { peCode?: string } }).identity?.peCode,
    );
    const distinctRequestPeCodes = new Set(requestPeCodes);
    expect(requestPeCodes.length - distinctRequestPeCodes.size).toBe(1); // only 0604201F duplicates

    // Deliberately NOT asserting overall verifier PASS, per the brief.
    const uniquePages = new Set(identities.map((a) => (a as { metadata?: { physicalPage?: number } }).metadata?.physicalPage));
    const conflictWarnings = artifact.warnings.filter((w) => w.code === 'r1_duplicate_conflicting_value');
    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-13 real-parser acceptance -- aggregate result:',
      JSON.stringify(
        {
          decision: verification.decision,
          totalAssertions: artifact.assertions.length,
          identityCount: identities.length,
          fundingRequestCount: fundingRequests.length,
          distinctPeCodesWithRequest: distinctRequestPeCodes.size,
          documentFactAssertionCount: artifact.assertions.filter((a) => a.assertionKind === 'document_fact').length,
          omissionCount: artifact.omissions.length,
          conflictCount: conflictWarnings.length,
          pagesWithRecognizedIdentities: uniquePages.size,
          requiredChecks: [
            'completeness',
            'r1_specific',
            'duplicate_detection',
            'warning_policy',
            'identity_validation',
            'numeric_validation',
            'money_evidence_policy',
            'page_only_reconciliation',
            'rdte_summary_detail',
          ].map((code) => {
            const check = byCode.get(code);
            return { code, outcome: check?.outcome ?? 'MISSING', message: check?.message };
          }),
          allNonPassChecks: verification.checks
            .filter((c) => c.outcome === 'FAIL' || c.outcome === 'NOT_RUN')
            .map((c) => ({ code: c.code, outcome: c.outcome, message: c.message })),
        },
        null,
        2,
      ),
    );
  });

  it('real-parser output, reconstructed directly: per-page component/section context is evidence-based, never document-wide ARMY default', () => {
    // Uses the same real deterministic_pdfplumber output captured from a
    // prior real run against the identical archived PDF (fixture below),
    // so this proof is decoupled from needing a live parser subprocess
    // while still being real parser output, not synthesized geometry.
    // Cross-checked against the offline full-document profiling report
    // (`profile_r1_pages.py`) produced before any reconstruction code was
    // written: 114 pages total, 91 with at least one recognizable data row.
    const rawFixturePath = join(
      __dirname,
      '__fixtures__',
      'production-fy2024-r1-raw-parser-output-114pages.json',
    );
    const raw = JSON.parse(readFileSync(rawFixturePath, 'utf8')) as {
      pages: ParserPageResultV1[];
    };
    const sha = createHash('sha256')
      .update(readFileSync(rawFixturePath))
      .digest('hex');
    // eslint-disable-next-line no-console
    console.log('raw parser output fixture sha256:', sha);

    const { pages: reconstructedPages, omissions } = reconstructR1TablesFromTextV1(
      raw.pages,
      2024,
    );

    expect(reconstructedPages.length).toBe(91);

    const componentCounts = new Map<string, number>();
    for (const page of reconstructedPages) {
      componentCounts.set(page.component, (componentCounts.get(page.component) ?? 0) + 1);
    }
    // Never a single document-wide default: at least 3 distinct component
    // contexts recognized from real appropriation/heading evidence, and
    // component is not stamped ARMY on every page just because Army pages
    // occur first in the document.
    expect(componentCounts.size).toBeGreaterThanOrEqual(3);
    expect(componentCounts.get('ARMY')).toBeLessThan(reconstructedPages.length);

    const totalDataRows = reconstructedPages.reduce((sum, p) => sum + p.dataRowCount, 0);
    const totalConfidentFundingRows = reconstructedPages.reduce(
      (sum, p) => sum + p.confidentFundingRowCount,
      0,
    );

    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-11 reconstructor-direct aggregate (component/section context):',
      JSON.stringify(
        {
          totalPages: raw.pages.length,
          pagesWithRecognizedRows: reconstructedPages.length,
          componentContextCounts: Object.fromEntries(componentCounts),
          totalDataRows,
          totalConfidentFundingRows,
          ambiguousOmissionCount: omissions.length,
        },
        null,
        2,
      ),
    );
  });
});
