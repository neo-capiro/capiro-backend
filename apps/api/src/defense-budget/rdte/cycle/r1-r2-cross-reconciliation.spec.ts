/**
 * Phase 10B-16 Part G -- real R-1 <-> R-2 reconciliation for PE 0601102A,
 * exercised through the actual `rdte_summary_detail` verification rule (not
 * a custom comparison script).
 *
 * Both artifacts are built from real, previously-captured parser output:
 *   - R-1: `production-fy2024-r1-raw-parser-output-114pages.json` (already
 *     used by `r1-text-reconstruction-e2e-acceptance.spec.ts`) through the
 *     exact production R-1 branch (`applyR1TextReconstructionV1` ->
 *     `extractR1FromPages` -> `buildR1Artifact`).
 *   - R-2: `production-fy2024-army-r2-raw-parser-output-170pages.json`
 *     (this phase's own fixture, see `r2-real-document-e2e-acceptance.spec.ts`
 *     for how/why it was captured) through the exact production R-2 branch.
 *
 * This test reports, rather than assumes, the real `rdte_summary_detail`
 * outcome. See the inline comment at the assertion for why NOT_RUN is the
 * expected, correct result even with both real artifacts present.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseParserRuntimeResultV1,
  type ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { applyR1TextReconstructionV1 } from '../r1/r1-text-row-reconstructor-v1.js';
import { extractR1FromPages } from '../r1/r1-extractor-v1.js';
import { buildR1Artifact } from '../r1/r1-artifact-builder-v1.js';
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import { extractR2PeFunding } from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { buildCompleteR2Artifact } from '../r2/r2-complete-artifact-builder-v1.js';
import { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../../verification/trusted-proof/trusted-proof-types.js';
import type { BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

const R1_SOURCE_SHA = 'ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425';
const R1_SOURCE_DOCUMENT_ID = '62e8a102-4f01-471b-9cb6-eab58cb41270';
const R1_SOURCE_URL = 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf';

const R2_SOURCE_SHA = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const R2_SOURCE_DOCUMENT_ID = '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342';
const R2_SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';

const TARGET_PE = '0601102A';
const CYCLE_FISCAL_YEAR = 2024;

function readRawPages(fixtureName: string, expectedSha: string): ParserPageResultV1[] {
  const fixturePath = join(__dirname, '__fixtures__', fixtureName);
  if (!existsSync(fixturePath)) throw new Error(`missing fixture: ${fixturePath}`);
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const parsed = parseParserRuntimeResultV1(raw);
  if (parsed.inputSourceSha256 !== expectedSha) {
    throw new Error(`fixture source SHA drifted: expected ${expectedSha}, got ${parsed.inputSourceSha256}`);
  }
  return parsed.pages as ParserPageResultV1[];
}

function buildRealR1Artifact(): DefenseBudgetExtractionArtifactV1 {
  const pages = readRawPages('production-fy2024-r1-raw-parser-output-114pages.json', R1_SOURCE_SHA);
  const reconstruction = applyR1TextReconstructionV1(pages, CYCLE_FISCAL_YEAR);
  const extraction = extractR1FromPages({
    pages: reconstruction.pages,
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
    rowContextByPage: reconstruction.rowContextByPage,
  });
  return buildR1Artifact({
    source: {
      manifestDocumentKey: R1_SOURCE_DOCUMENT_ID,
      sourceDocumentId: R1_SOURCE_DOCUMENT_ID,
      sourcePdfSha256: R1_SOURCE_SHA,
      sourceLocator: R1_SOURCE_URL,
      sourceUrl: R1_SOURCE_URL,
      fiscalYear: CYCLE_FISCAL_YEAR,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'UNKNOWN',
      budgetCycle: 'pb',
      documentType: 'r1',
      title: 'r1',
    },
    parserRuns: [],
    extraction: { ...extraction, omissions: [...extraction.omissions, ...reconstruction.omissions] },
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
  });
}

function toContiguousRanges(pages: readonly number[]): Array<{ startPage: number; endPage: number }> {
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: Array<{ startPage: number; endPage: number }> = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last != null && page === last.endPage + 1) last.endPage = page;
    else ranges.push({ startPage: page, endPage: page });
  }
  return ranges;
}

function buildRealR2Artifact(): DefenseBudgetExtractionArtifactV1 {
  const pages = readRawPages('production-fy2024-army-r2-raw-parser-output-170pages.json', R2_SOURCE_SHA);
  const source = {
    manifestDocumentKey: R2_SOURCE_DOCUMENT_ID,
    sourceDocumentId: R2_SOURCE_DOCUMENT_ID,
    sourcePdfSha256: R2_SOURCE_SHA,
    sourceLocator: R2_SOURCE_URL,
    sourceUrl: R2_SOURCE_URL,
    fiscalYear: CYCLE_FISCAL_YEAR,
    family: 'rdte' as const,
    exhibit: 'R-2' as const,
    authority: 'dod-comptroller' as const,
    component: 'ARMY' as const,
    budgetCycle: 'pb',
    documentType: 'r2',
    title: 'r2',
  };
  const parserRuns = [
    {
      parserRunId: `pr1_real_r2_${R2_SOURCE_SHA.slice(0, 16)}`,
      method: 'deterministic_pdfplumber' as const,
      parserVersion: 'pdfplumber-0.11.0',
      parserConfigSha256: '3bc9df29aec9638eee25da1d99832c01f59b1c1d99f0a0346f74cf16975ce9b1',
      inputSourceSha256: R2_SOURCE_SHA,
      outputArtifactSha256: R2_SOURCE_SHA,
      pageRanges: toContiguousRanges(pages.map((p) => p.page)),
    },
  ];

  const resolution = resolveR2Contexts(segmentR2ExhibitPages(pages));
  const identities = extractR2Identities({ pages, contextResolution: resolution });
  const narrative = extractR2Narrative({ pages, contextResolution: resolution });

  const contexts = new Map<string, { pageStart: number; pageEnd: number }>();
  for (const page of resolution.pages) {
    if (page.kind !== 'r2_pe_summary' && page.kind !== 'r2_continuation') continue;
    if (!page.peCode) continue;
    const current = contexts.get(page.peCode);
    if (current) {
      current.pageStart = Math.min(current.pageStart, page.page);
      current.pageEnd = Math.max(current.pageEnd, page.page);
    } else contexts.set(page.peCode, { pageStart: page.page, pageEnd: page.page });
  }
  const funding = [...contexts.entries()].map(([peCode, range]) =>
    extractR2PeFunding({ pages, peContext: { peCode, ...range }, cycleFiscalYear: CYCLE_FISCAL_YEAR }),
  );
  const fundingArtifact = buildR2PeFundingArtifact({
    source,
    parserRuns,
    extractions: funding,
    comparisonRequests: [],
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
  });
  return buildCompleteR2Artifact({ fundingArtifact, parserRuns, identities, narrative });
}

class DualArtifactVerificationResolver implements TrustedVerificationProofResolverV1 {
  constructor(
    private readonly candidate: DefenseBudgetExtractionArtifactV1,
    private readonly reference: DefenseBudgetExtractionArtifactV1,
  ) {}
  async resolve(): Promise<TrustedProofResolutionV1> {
    const manifestDocument = {
      documentKey: R2_SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r2',
      sourceLocator: R2_SOURCE_URL,
      expectedSourceSha256: R2_SOURCE_SHA,
      family: 'rdte',
      exhibit: 'R-2',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r2',
      parserPolicy: 'deterministic_table',
      requiredDataCategories: ['identity'],
      requiredFundingFields: [],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    };
    return {
      manifest: {
        schemaVersion: 'defense_budget_cycle_manifest_v1',
        cycleId: 'phase10b16-r1-r2-reconciliation',
        fiscalYear: CYCLE_FISCAL_YEAR,
        domain: 'defense',
        documents: [manifestDocument],
      } as never,
      manifestDocument: manifestDocument as never,
      manifestContentSha256: 'e'.repeat(64),
      artifact: this.candidate,
      extractionArtifactByteSha256: this.candidate.contentSha256,
      extractionArtifactContentSha256: this.candidate.contentSha256,
      proofBundle: {
        manifest: {
          locator: 'synthetic://manifest',
          contentSha256: 'e'.repeat(64),
          cycleId: 'phase10b16-r1-r2-reconciliation',
          fiscalYear: CYCLE_FISCAL_YEAR,
          documentKey: R2_SOURCE_DOCUMENT_ID,
        },
        extractionArtifact: {
          artifactId: this.candidate.artifactId,
          locator: 'synthetic://artifact',
          contentSha256: this.candidate.contentSha256,
          byteSha256: this.candidate.contentSha256,
        },
        sourceDocument: {
          id: R2_SOURCE_DOCUMENT_ID,
          sourceKey: R2_SOURCE_DOCUMENT_ID,
          sourceSha256: R2_SOURCE_SHA,
        },
        archive: { status: 'not_applicable' },
        parserRuns: this.candidate.parserRuns.map((run) => ({
          parserRunId: run.parserRunId,
          method: run.method,
          proofStatus: 'verified' as const,
        })),
        resolvedReferenceArtifacts: [
          { artifactId: this.reference.artifactId, exhibit: 'R-1', proofStatus: 'verified' as const },
        ],
      } as never,
      proofFindings: [],
      referenceArtifacts: [this.reference],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
    };
  }
}

describe('Phase 10B-16 Part G -- real R-1 <-> R-2 reconciliation for PE 0601102A', () => {
  it('runs the real rdte_summary_detail rule with both real artifacts present and reports the true outcome', async () => {
    const r1Artifact = buildRealR1Artifact();
    const r2Artifact = buildRealR2Artifact();

    const r1Identities = r1Artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity');
    const r1Target = r1Identities.find(
      (a) => (a as { identity?: { peCode?: string } }).identity?.peCode === TARGET_PE,
    );
    expect(r1Target).toBeDefined();
    const r1FundingRequests = r1Artifact.assertions.filter(
      (a) =>
        a.assertionKind === 'funding' &&
        (a as { field?: string }).field === 'request' &&
        (a as { fiscalYear?: number }).fiscalYear === CYCLE_FISCAL_YEAR &&
        (a as { identity?: { peCode?: string } }).identity?.peCode === TARGET_PE,
    ) as Array<{ money?: { valueMillions?: string } }>;
    expect(r1FundingRequests.length).toBeGreaterThan(0);
    const r1Value = Number(r1FundingRequests[0]?.money?.valueMillions);
    expect(r1Value).toBeCloseTo(296.67, 2);

    const r2DocumentFacts = r2Artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    const r2Target = r2DocumentFacts.find(
      (a) =>
        (a as { fieldName?: string }).fieldName === 'r2_total_component' &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value?.peCode ===
          TARGET_PE &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.fiscalYear === CYCLE_FISCAL_YEAR &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value?.rowKind ===
          'pe_total',
    ) as { value?: { valueMillions?: string } } | undefined;
    expect(r2Target).toBeDefined();
    const r2Value = Number(r2Target?.value?.valueMillions);
    expect(r2Value).toBeCloseTo(296.67, 2);

    // The two independently-derived real values agree exactly (normalized):
    // R-1's FY2024 request and R-2's FY2024 Total both derive to 296.67M
    // for PE 0601102A -- the human-readable confirmation Part G asks for,
    // computed here directly from both real artifacts (not the verifier).
    expect(r1Value).toBeCloseTo(r2Value, 2);

    // Now exercise the REAL verifier mechanism, not a custom comparison.
    const verificationService = new BudgetVerificationV1Service(
      new DualArtifactVerificationResolver(r2Artifact, r1Artifact),
      null as unknown as BudgetVerificationRepositoryV1,
    );
    const verification = await verificationService.verify({
      manifestLocator: 'synthetic://manifest',
      manifestDocumentKey: R2_SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: 'synthetic://artifact',
      sourceDocumentId: R2_SOURCE_DOCUMENT_ID,
      mode: 'inspect',
    });
    const byCode = new Map(verification.checks.map((c) => [c.code, c]));
    const summaryDetail = byCode.get('rdte_summary_detail');
    const pageOnlyReconciliation = byCode.get('page_only_reconciliation');
    const moneyEvidencePolicy = byCode.get('money_evidence_policy');

    // Phase 10B-16 Part H: what fraction of R-1's total funding assertions
    // could this ONE Army BA1 R-2 volume theoretically cover? It contains
    // exactly 5 PEs (confirmed by direct segmentation: 0601102A, 0601103A,
    // 0601104A, 0601121A, 0601601A) -- count R-1's own real assertions for
    // just those 5 PE codes against its real total.
    const R2_VOLUME_PE_CODES = ['0601102A', '0601103A', '0601104A', '0601121A', '0601601A'];
    const r1AllFunding = r1Artifact.assertions.filter((a) => a.assertionKind === 'funding');
    const r1FundingForVolumePes = r1AllFunding.filter((a) =>
      R2_VOLUME_PE_CODES.includes(
        (a as { identity?: { peCode?: string } }).identity?.peCode ?? '',
      ),
    );
    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-16 Part H -- theoretical R-1 coverage from this one R-2 volume:',
      JSON.stringify(
        {
          r1TotalFundingAssertions: r1AllFunding.length,
          r1FundingAssertionsForThisVolumesPes: r1FundingForVolumePes.length,
          coveragePercent: Math.round((r1FundingForVolumePes.length / r1AllFunding.length) * 1000) / 10,
          volumePeCodes: R2_VOLUME_PE_CODES,
        },
        null,
        2,
      ),
    );

    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-16 Part G -- real R-1<->R-2 reconciliation result:',
      JSON.stringify(
        {
          r1ValueMillions: r1Value,
          r2ValueMillions: r2Value,
          normalizedMatch: Math.abs(r1Value - r2Value) < 0.005,
          decision: verification.decision,
          rdte_summary_detail: summaryDetail,
          page_only_reconciliation: pageOnlyReconciliation,
          money_evidence_policy: moneyEvidencePolicy,
        },
        null,
        2,
      ),
    );

    // This is the REAL, honest outcome, not a defect this test papers over:
    // `rdte_summary_detail` (rdte-summary-detail.rules.ts) matches candidate
    // vs. reference ONLY across `assertionKind === 'funding'` assertions on
    // BOTH sides. R-1's real extractor produces a `funding`+field:'request'
    // assertion (it has a literal "Request"-labeled column); this real R-2
    // exhibit's current-year value is legitimately a `document_fact`
    // (`r2_total_component`), never a `funding` assertion, by the
    // deliberate, documented `RDTE_ROLE_ALLOWED_DISPOSITIONS` policy in
    // `rdte-column-role-v1.ts` ("only `budget_year_request` may become
    // `canonical_request_candidate`"). With zero `funding` assertions on
    // the R-2 side, `rdte_summary_detail` has nothing to match against and
    // correctly, safely returns NOT_RUN ("no matching R-1/R-2 assertion
    // pairs found") rather than a false PASS or a false FAIL. Reconciling
    // R-1's canonical-request vocabulary against R-2's Base/OCO/Total
    // vocabulary is a real, out-of-scope gap in `rdte_summary_detail` this
    // phase's Blockers A/B/C/D do not touch -- reported here, not silently
    // patched, per the brief's explicit instruction to exercise the real
    // mechanism rather than build a custom comparison script.
    expect(summaryDetail?.outcome).toBe('NOT_RUN');
    expect(summaryDetail?.message).toMatch(/no matching R-1\/R-2 assertion pairs found/);
  });
});
