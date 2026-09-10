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
import { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../../verification/trusted-proof/trusted-proof-types.js';
import type { BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  R2_SOURCE_SHA,
  R2_SOURCE_DOCUMENT_ID,
  R2_SOURCE_URL,
  TARGET_PE,
  CYCLE_FISCAL_YEAR,
  buildRealR1Artifact,
  buildRealR2Artifact,
} from './r1-r2-real-artifacts-fixture.js';

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

    // Phase 10B-17 Part D/E: `rdte_summary_detail` (rdte-summary-detail.rules.ts)
    // used to match candidate vs. reference ONLY across `assertionKind ===
    // 'funding'` assertions on BOTH sides -- R-1's real extractor produces
    // a `funding`+field:'request' assertion (it has a literal
    // "Request"-labeled column); this real R-2 exhibit's current-year
    // value is legitimately a `document_fact` (`r2_total_component`),
    // never a `funding` assertion, by the deliberate, documented
    // `RDTE_ROLE_ALLOWED_DISPOSITIONS` policy in `rdte-column-role-v1.ts`
    // ("only `budget_year_request` may become `canonical_request_candidate`").
    // With zero `funding` assertions on the R-2 side, the rule previously
    // had nothing to match against and returned NOT_RUN.
    //
    // The Part D reconciliation bridge (additive, in the same rule file)
    // now recognizes narrowly-gated `r2_total_component`/`pe_total`
    // document_fact evidence -- whose OWN column-derived fiscal year
    // matches the exhibit's declared cycle year and whose source document
    // is a real PB-cycle R-2 exhibit -- as comparable to an R-1 request,
    // WITHOUT reclassifying it as a funding/canonical_request_candidate
    // assertion (see `r1-r2-reconciliation-bridge.spec.ts` for the explicit
    // regression proving canonical projection eligibility is unaffected).
    // All 5 real PEs in this one volume now reconcile exactly.
    expect(summaryDetail?.outcome).toBe('PASS');
    expect(summaryDetail?.details).toMatchObject({ bridgedComparableCount: 5, matchedAssertionCount: 5 });
  });
});
