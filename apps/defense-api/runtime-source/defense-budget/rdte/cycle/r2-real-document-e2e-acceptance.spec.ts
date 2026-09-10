/**
 * Phase 10B-16 Part E -- production-equivalent E2E acceptance gate for the
 * real R-2 semantic pipeline (PE identity + funding extraction from the
 * exact official Army FY2024 R-2 Volume 1 Budget Activity 1 PDF).
 *
 * This test does NOT synthesize tables or hardcode the expected funding
 * value. It drives:
 *
 *   real PDF bytes -> deterministic_pdfplumber (pdfplumber-0.11.0, the same
 *   engine version/config production uses) -> the real Zod schema boundary
 *   (`parseParserRuntimeResultV1`, Blocker A's `.nullish()` fix) -> the real
 *   `segmentR2ExhibitPages` (Part D's body-text fallback fix) ->
 *   `resolveR2Contexts` -> `extractR2Identities` / `extractR2Narrative` ->
 *   `extractR2PeFunding` -> `buildR2PeFundingArtifact` ->
 *   `buildCompleteR2Artifact` -- the exact same function sequence
 *   `rdte-phase3-semantic-artifact-factory-v1.ts`'s R-2 branch calls in
 *   production.
 *
 * One deliberate, disclosed deviation from `runParserHandoffForSourceDocument`
 * (the pattern `r1-text-reconstruction-e2e-acceptance.spec.ts` uses for R-1):
 * this document's real page-profiling pass mis-estimates physical pages
 * 11-37 as needing OCR escalation and routes them straight to the paddleocr
 * engine tier without ever attempting `deterministic_pdfplumber` on them --
 * a genuine, reproducible router/profiler defect, independent of Blockers
 * A/B/C, confirmed by directly invoking `deterministic_pdfplumber` against
 * pages 11-37 in isolation (see Phase 10B-16 report): all 27 pages succeed
 * with zero failures. Chasing that defect, or the separate paddleocr
 * 2.10.0/'PP-StructureV3' engine-version incompatibility it exposes, is out
 * of scope for the null-schema/heading-classifier/segmenter fixes this
 * phase is scoped to. This test instead drives `deterministic_pdfplumber`
 * directly for the full 170-page document (bypassing ONLY the profiler's
 * escalation-routing decision, never the parser or any semantic-layer
 * function), which reproduces the brief's own known-good ground truth
 * exactly: 164/170 pages succeed (the 6 failures -- physical pages 2, 4,
 * 10, 38, 40, 42 -- are genuinely blank/no-embedded-text separator pages,
 * confirmed independently), and 143 real structural tables / 7,905 real
 * cells are produced, matching the brief's stated facts precisely.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseParserRuntimeResultV1,
  type ParserPageResultV1,
  type ParserRuntimeResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import {
  composePageResults,
  type ParserRunResultEntry,
} from '../../parser-router/page-result-compositor.js';
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import { extractR2PeFunding } from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { buildCompleteR2Artifact } from '../r2/r2-complete-artifact-builder-v1.js';
import { createRdteSemanticArtifactFactory } from './rdte-phase3-semantic-artifact-factory-v1.js';
import { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../../verification/trusted-proof/trusted-proof-types.js';
import type { BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';

const SOURCE_SHA = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const SOURCE_DOCUMENT_ID = '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342';
const SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';
const PARSER_CONFIG_SHA = '3bc9df29aec9638eee25da1d99832c01f59b1c1d99f0a0346f74cf16975ce9b1';
const TARGET_PE = '0601102A';
const CYCLE_FISCAL_YEAR = 2024;

const RAW_FIXTURE_PATH = join(
  __dirname,
  '__fixtures__',
  'production-fy2024-army-r2-raw-parser-output-170pages.json',
);

/** The complete parsed raw-parser-output, including the `failedPages`
 * records (page + typed failure code) that `requireRawFixture` below
 * discards -- needed to drive the REAL Phase 3 compositor/factory seam,
 * not just the succeeded-pages array. */
function requireFullRawParserResult(): ParserRuntimeResultV1 {
  if (!existsSync(RAW_FIXTURE_PATH)) {
    throw new Error(`missing real raw-parser-output fixture at ${RAW_FIXTURE_PATH}`);
  }
  const raw = JSON.parse(readFileSync(RAW_FIXTURE_PATH, 'utf8')) as unknown;
  const parsed = parseParserRuntimeResultV1(raw);
  if (parsed.inputSourceSha256 !== SOURCE_SHA) {
    throw new Error(
      `raw fixture source SHA drifted: expected ${SOURCE_SHA}, got ${parsed.inputSourceSha256}`,
    );
  }
  return parsed;
}

function requireRawFixture(): { pages: ParserPageResultV1[]; contentSha256: string } {
  const parsed = requireFullRawParserResult();
  return { pages: parsed.pages as ParserPageResultV1[], contentSha256: parsed.contentSha256 };
}

/** Compact ascending physical pages into contiguous [start,end] ranges. */
function toContiguousRanges(
  pages: readonly number[],
): Array<{ startPage: number; endPage: number }> {
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: Array<{ startPage: number; endPage: number }> = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last != null && page === last.endPage + 1) {
      last.endPage = page;
    } else {
      ranges.push({ startPage: page, endPage: page });
    }
  }
  return ranges;
}

function buildRealSource(): ExtractionSourceV1 & { sourceDocumentId: string } {
  return {
    manifestDocumentKey: SOURCE_DOCUMENT_ID,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: SOURCE_URL,
    sourceUrl: SOURCE_URL,
    fiscalYear: CYCLE_FISCAL_YEAR,
    family: 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r2',
    title: 'r2',
  };
}

function buildRealParserRuns(input: {
  pages: readonly ParserPageResultV1[];
  outputArtifactSha256: string;
}): ParserRunV1[] {
  const pageRanges = toContiguousRanges(input.pages.map((page) => page.page));
  return [
    {
      parserRunId: `pr1_real_r2_${SOURCE_SHA.slice(0, 16)}`,
      method: 'deterministic_pdfplumber',
      parserVersion: 'pdfplumber-0.11.0',
      parserConfigSha256: PARSER_CONFIG_SHA,
      inputSourceSha256: SOURCE_SHA,
      outputArtifactSha256: input.outputArtifactSha256,
      pageRanges,
    },
  ];
}

/** Mirrors `buildSemanticArtifact`'s R-2 branch in
 * `rdte-phase3-semantic-artifact-factory-v1.ts` exactly (that function is
 * not exported), driving the real production functions directly against
 * real parser output rather than through the full router/profiler seam. */
function buildRealR2Artifact(input: {
  pages: readonly ParserPageResultV1[];
  source: ExtractionSourceV1 & { sourceDocumentId: string };
  parserRuns: readonly ParserRunV1[];
}): DefenseBudgetExtractionArtifactV1 {
  const resolution = resolveR2Contexts(segmentR2ExhibitPages(input.pages));
  const identities = extractR2Identities({ pages: input.pages, contextResolution: resolution });
  const narrative = extractR2Narrative({ pages: input.pages, contextResolution: resolution });

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
    extractR2PeFunding({
      pages: input.pages,
      peContext: { peCode, ...range },
      cycleFiscalYear: CYCLE_FISCAL_YEAR,
    }),
  );

  const fundingArtifact = buildR2PeFundingArtifact({
    source: input.source,
    parserRuns: input.parserRuns,
    extractions: funding,
    comparisonRequests: [],
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
  });

  return buildCompleteR2Artifact({
    fundingArtifact,
    parserRuns: input.parserRuns,
    identities,
    narrative,
  });
}

class RealR2ArtifactVerificationResolver implements TrustedVerificationProofResolverV1 {
  constructor(private readonly artifact: DefenseBudgetExtractionArtifactV1) {}
  async resolve(): Promise<TrustedProofResolutionV1> {
    const manifestDocument = {
      documentKey: SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r2',
      sourceLocator: SOURCE_URL,
      expectedSourceSha256: SOURCE_SHA,
      family: 'rdte',
      exhibit: 'R-2',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r2',
      parserPolicy: 'deterministic_table',
      // Deliberately NOT requiring the 'funding' category here: this real
      // R-2 exhibit prints its current budget year as Base/OCO/Total
      // component columns, which `r2-pe-funding-builder.ts` correctly
      // routes to `document_fact` assertions (`RDTE_ROLE_ALLOWED_DISPOSITIONS`
      // in `rdte-column-role-v1.ts` -- "only `budget_year_request` may
      // become `canonical_request_candidate`", the only disposition that
      // becomes an `assertionKind: 'funding'` assertion). Requiring
      // 'funding' here would fail completeness for correct, intentional
      // reasons unrelated to Blockers A/B/C/D -- this is not a real
      // production manifest, so this test does not assert a requirement
      // the real R-2 extractor architecture does not promise to satisfy.
      requiredDataCategories: ['identity'],
      requiredFundingFields: [],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    };
    return {
      manifest: {
        schemaVersion: 'defense_budget_cycle_manifest_v1',
        cycleId: 'phase10b16-r2-real-e2e',
        fiscalYear: CYCLE_FISCAL_YEAR,
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
          cycleId: 'phase10b16-r2-real-e2e',
          fiscalYear: CYCLE_FISCAL_YEAR,
          documentKey: SOURCE_DOCUMENT_ID,
        },
        extractionArtifact: {
          artifactId: this.artifact.artifactId,
          locator: 'synthetic://artifact',
          contentSha256: this.artifact.contentSha256,
          byteSha256: this.artifact.contentSha256,
        },
        sourceDocument: {
          id: SOURCE_DOCUMENT_ID,
          sourceKey: SOURCE_DOCUMENT_ID,
          sourceSha256: SOURCE_SHA,
        },
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

describe('Phase 10B-16 Part E -- real R-2 semantic pipeline acceptance (PE 0601102A)', () => {
  jest.setTimeout(60_000);

  it('derives real PE identities and the FY2024 request funding value from the real Army R-2 document', () => {
    const { pages, contentSha256 } = requireRawFixture();

    // Ground truth from the brief, reproduced exactly by the real engine.
    expect(pages.length).toBe(164);
    const totalTables = pages.reduce((sum, page) => sum + page.tables.length, 0);
    const totalCells = pages.reduce(
      (sum, page) => sum + page.tables.reduce((s, table) => s + table.cells.length, 0),
      0,
    );
    expect(totalTables).toBe(143);
    expect(totalCells).toBe(7905);

    const source = buildRealSource();
    const parserRuns = buildRealParserRuns({ pages, outputArtifactSha256: contentSha256 });
    const artifact = buildRealR2Artifact({ pages, source, parserRuns });

    expect(artifact.source.sourcePdfSha256).toBe(SOURCE_SHA);
    expect(artifact.source.component).toBe('ARMY');

    // --- real extraction, not synthetic ---
    expect(artifact.assertions.length).toBeGreaterThan(0);
    const identities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(identities.length).toBeGreaterThan(0);

    // PE 0601102A must be present, with its real title.
    const targetIdentity = identities.find(
      (a) => (a as { identity?: { peCode?: string } }).identity?.peCode === TARGET_PE,
    ) as { title?: string } | undefined;
    expect(targetIdentity).toBeDefined();
    expect(targetIdentity?.title).toBe('Defense Research Sciences');

    // This real R-2 table prints the current budget year as Base/OCO/Total
    // component columns (Base 296.670 / OCO "-" / Total 296.670), not a
    // single column literally labeled "Request" -- confirmed against the
    // raw cell grid on physical page 43. `rdte-column-role-v1.ts`'s
    // role->disposition policy is explicit and deliberate: "only
    // `budget_year_request` may become `canonical_request_candidate`" (the
    // only disposition that becomes a `funding` assertion in
    // `r2-pe-funding-builder.ts`) -- Base/OCO/Total component columns are
    // `contextual_only` by design and become `document_fact` assertions
    // instead ("the printed value is preserved truthfully without
    // canonical-stage contamination"). This is real, correct, intentional
    // R-2 semantics, not a defect: asserting on `document_fact` here is the
    // faithful way to check the FY2024 value was actually derived.
    const documentFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(documentFacts.length).toBeGreaterThan(0);
    const targetTotalComponent = documentFacts.find(
      (a) =>
        (a as { fieldName?: string }).fieldName === 'r2_total_component' &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.peCode === TARGET_PE &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.fiscalYear === CYCLE_FISCAL_YEAR &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.rowKind === 'pe_total',
    ) as { value?: { valueMillions?: string }; metadata?: { physicalPage?: number } } | undefined;
    expect(targetTotalComponent).toBeDefined();
    expect(Number(targetTotalComponent?.value?.valueMillions)).toBeCloseTo(296.67, 2);

    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-16 Part E -- real R-2 aggregate result:',
      JSON.stringify(
        {
          pageCount: pages.length,
          totalTables,
          totalCells,
          totalAssertions: artifact.assertions.length,
          identityCount: identities.length,
          documentFactCount: documentFacts.length,
          targetPe: TARGET_PE,
          targetPeTitle: targetIdentity?.title,
          targetPeFy2024TotalMillions: targetTotalComponent?.value?.valueMillions,
          omissionCount: artifact.omissions.length,
          warningCount: artifact.warnings.length,
        },
        null,
        2,
      ),
    );
  });

  it('produces a REVIEW/PASS-eligible verifier decision through the real verifier, not a custom comparison script', async () => {
    const { pages, contentSha256 } = requireRawFixture();
    const source = buildRealSource();
    const parserRuns = buildRealParserRuns({ pages, outputArtifactSha256: contentSha256 });
    const artifact = buildRealR2Artifact({ pages, source, parserRuns });

    const verificationService = new BudgetVerificationV1Service(
      new RealR2ArtifactVerificationResolver(artifact),
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

    // Phase 10B-21 Part H: the 36 pages this volume's front matter spans
    // (cover, blanks, tables of contents, appropriation-language boilerplate,
    // and roman-numeral-paginated introduction/index sections) are proven
    // non-semantic by `segmentR2ExhibitPages` using deterministic structural
    // evidence (heading text, blank content, roman-vs-arabic pagination --
    // never a page number or fiscal year), so `extractR2Identities` no
    // longer raises a required-identity omission for any of them. This is
    // the fix for the Phase 10B-16 finding this test used to document as
    // intentional fail-closed behavior: those 36 pages were never actually a
    // completeness gap, they simply never contained a PE to begin with.
    // Still NOT asserting overall PASS (Part H: "Do not require PASS. A
    // truthful REVIEW is acceptable.") -- only that fixing real front-matter
    // false positives does not leave the verifier at REJECT.
    expect(byCode.get('completeness')).toBeDefined();
    expect(verification.decision).not.toBe('REJECT');
    const blockingIdentityOmissions = artifact.omissions.filter(
      (o) => o.severity === 'blocking' && o.message.includes('R-2 identity omission'),
    );
    expect(blockingIdentityOmissions).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-16 Part E -- real R-2 verifier decision:',
      JSON.stringify(
        {
          decision: verification.decision,
          checks: verification.checks.map((c) => ({ code: c.code, outcome: c.outcome, message: c.message })),
          discrepancyCount: verification.discrepancies.length,
        },
        null,
        2,
      ),
    );
  });

  it('does not REJECT through the REAL production Phase 3 seam (compositor + rdteDocumentInputFromPhase3 + appendUnresolvedPageOmissions), not only the bypassed direct-call helper above (Phase 10B-21, 3rd independent review, Area 8)', async () => {
    // The two tests above call `resolveR2Contexts`/`extractR2Identities`/
    // `buildCompleteR2Artifact` directly against ONLY the 164 succeeded
    // pages, so they never exercise `rdteDocumentInputFromPhase3` or
    // `appendUnresolvedPageOmissions` -- the actual functions
    // `createRdteSemanticArtifactFactory` (the real Phase 3 seam every
    // production import calls) uses to decide `unresolvedPages` and turn
    // them into blocking omissions. Before the Area 8 fix, those two
    // functions unconditionally treated every one of this document's 6
    // genuinely blank separator pages (2, 4, 10, 38, 40, 42 -- every engine
    // agreed `no_embedded_text`, confirmed by the raw fixture's own
    // `failedPages`) as a blocking completeness gap, so the real production
    // path still REJECTed even after the segmenter false-positive fix. This
    // test drives the REAL compositor (`composePageResults`) and the REAL
    // factory (`createRdteSemanticArtifactFactory`) end to end against the
    // same raw fixture, so a regression in either fix shows up here even if
    // the narrower tests above still pass.
    const rawResult = requireFullRawParserResult();
    const source = buildRealSource();
    const parserRunEntry: ParserRunResultEntry = {
      parserRunId: `pr1_real_r2_${SOURCE_SHA.slice(0, 16)}`,
      result: rawResult,
      method: 'deterministic_pdfplumber',
      parserVersion: 'pdfplumber-0.11.0',
      parserConfigSha256: PARSER_CONFIG_SHA,
      sourceSha256: SOURCE_SHA,
      outputArtifactSha256: rawResult.contentSha256,
    };
    const composedOutput = composePageResults({
      executionId: 'phase10b21-area8-real-prod-path',
      sourceSha256: SOURCE_SHA,
      requestedPages: [...rawResult.requestedPages],
      parserRunEntries: [parserRunEntry],
    });

    // The compositor itself, not this test, decides which pages have no
    // selected result -- assert against what it actually produced rather
    // than hardcoding page numbers, but confirm it is non-empty so the
    // omission-skip path below is genuinely exercised.
    const noResultPages = composedOutput.pages
      .filter((page) => page.selectedResult == null)
      .map((page) => page.page)
      .sort((a, b) => a - b);
    expect(noResultPages.length).toBeGreaterThan(0);
    expect(
      noResultPages.every((page) =>
        (composedOutput.pages.find((p) => p.page === page)?.failures ?? []).every(
          (failure) => failure.code === 'no_embedded_text',
        ),
      ),
    ).toBe(true);

    const manifestDocument: BudgetCycleManifestDocumentV1 = {
      documentKey: SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r2',
      sourceLocator: SOURCE_URL,
      family: 'rdte',
      exhibit: 'R-2',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r2',
      parserPolicy: 'deterministic_table',
      requiredDataCategories: ['identity'],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    };

    const { capture, factory } = createRdteSemanticArtifactFactory({
      document: manifestDocument,
      source,
      fiscalYear: CYCLE_FISCAL_YEAR,
    });

    const outputDir = mkdtempSync(join(tmpdir(), 'phase10b21-area8-real-prod-'));
    try {
      factory(
        {
          executionId: 'phase10b21-area8-real-prod-path',
          cycleId: 'phase10b21-area8-real-prod-cycle',
          manifestDocumentKey: SOURCE_DOCUMENT_ID,
          sourceDocumentId: SOURCE_DOCUMENT_ID,
          sourceSha256: SOURCE_SHA,
          sourceLocator: SOURCE_URL,
          sourceUrl: SOURCE_URL,
          composedOutput,
          exhibitType: 'R-2',
          budgetFamily: 'rdte',
          fiscalYear: CYCLE_FISCAL_YEAR,
          authority: 'dod-comptroller',
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r2',
        },
        outputDir,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }

    expect(capture.documentInput).not.toBeNull();
    expect(capture.artifact).not.toBeNull();
    const documentInput = capture.documentInput!;
    const artifact = capture.artifact!;

    // Every unresolved page in this real document is provably blank -- the
    // real production seam must classify all of them as such (not merely
    // the segmenter's already-tested subset).
    expect([...documentInput.unresolvedPages].sort((a, b) => a - b)).toEqual(noResultPages);
    expect([...(documentInput.provablyBlankPages ?? [])].sort((a, b) => a - b)).toEqual(
      noResultPages,
    );

    const unresolvedPageOmissions = artifact.omissions.filter(
      (o) => o.reason === 'missing_evidence' && /did not select a parser result/.test(o.message),
    );
    expect(unresolvedPageOmissions).toHaveLength(0);

    const verificationService = new BudgetVerificationV1Service(
      new RealR2ArtifactVerificationResolver(artifact),
      null as unknown as BudgetVerificationRepositoryV1,
    );
    const verification = await verificationService.verify({
      manifestLocator: 'synthetic://manifest',
      manifestDocumentKey: SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: 'synthetic://artifact',
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      mode: 'inspect',
    });
    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-21 Area 8 -- real production-seam result:',
      JSON.stringify(
        {
          unresolvedPages: documentInput.unresolvedPages,
          provablyBlankPages: documentInput.provablyBlankPages,
          omissionCount: artifact.omissions.length,
          blockingOmissions: artifact.omissions.filter((o) => o.severity === 'blocking'),
          warnings: artifact.warnings,
          verifierChecks: verification.checks.map((c) => ({
            code: c.code,
            outcome: c.outcome,
            message: c.message,
          })),
          verifierDecision: verification.decision,
        },
        null,
        2,
      ),
    );
    expect(verification.decision).not.toBe('REJECT');
  });
});
