/**
 * Phase 10B-10 Parts D/E/F -- proves the durable RDT&E semantic adapter:
 *  - produces real, extractor-built assertions from production-like FY24 R-1
 *    content (Part D), using the SAME real page 9 PE row this workstream's
 *    forensics pulled from the archived, SHA-verified official PDF;
 *  - the fixed artifact resolves the two production blocking failures
 *    (`completeness`, `r1_specific`) through the REAL verifier (Part E);
 *  - negative controls prove the fix does not weaken anything (Part F).
 */
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ParsedTableV1,
  ParserPageResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import type {
  ComposedPageOutputV1,
  PageLineageEntry,
  SelectedPageResultV1,
} from './page-result-compositor.js';
import type { ExtractionArtifactBridgeInput } from './extraction-artifact-bridge.js';
import { FilesystemExtractionArtifactStore } from './extraction-artifact-store.js';
import {
  createRdteDurableSemanticArtifactFactoryV1,
  resolveArtifactFactoryForFamilyV1,
  type RdteDurableSemanticArtifactFactoryInputV1,
} from './rdte-durable-semantic-artifact-factory-v1.js';
import { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../verification/trusted-proof/trusted-proof-types.js';
import type { BudgetVerificationRepositoryV1 } from '../verification/persistence/verification-repository.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';

const SOURCE_SHA = 'ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425'; // real, archived FY2024 R-1 PDF
const SOURCE_DOCUMENT_ID = '62e8a102-4f01-471b-9cb6-eab58cb41270';
const CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
const FY = 2024;

function makeTable(
  cells: Array<{ rowIndex: number; columnIndex: number; text: string }>,
): ParsedTableV1 {
  return {
    tableIndex: 0,
    rowCount: Math.max(...cells.map((c) => c.rowIndex)) + 1,
    columnCount: Math.max(...cells.map((c) => c.columnIndex)) + 1,
    cells,
    warnings: [],
  };
}

/**
 * Real row 1 from page 9 of the archived FY2024 R-1 PDF (PE 0601102A /
 * Defense Research Sciences / FY2024 request 296,670), laid out using the
 * exact header vocabulary `r1-extractor-v1.spec.ts`'s own passing "standard
 * R-1 table with FYDP columns" fixture already proves the real
 * classifier/detector recognizes -- only the header year labels and the row
 * values differ, to match this canary's real FY2024 content instead of that
 * spec's synthetic FY2027 fixture.
 */
function realArmyR1Table(): ParsedTableV1 {
  return makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'PE' },
    { rowIndex: 0, columnIndex: 1, text: 'Title' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2022 Actual' },
    { rowIndex: 0, columnIndex: 3, text: 'FY 2023 Enacted' },
    { rowIndex: 0, columnIndex: 4, text: 'FY 2024 Request' },
    { rowIndex: 1, columnIndex: 0, text: '0601102A' },
    { rowIndex: 1, columnIndex: 1, text: 'Defense Research Sciences' },
    { rowIndex: 1, columnIndex: 2, text: '358,521' },
    { rowIndex: 1, columnIndex: 3, text: '391,642' },
    { rowIndex: 1, columnIndex: 4, text: '296,670' },
  ]);
}

function emptyR1Page(page: number): ParserPageResultV1 {
  return {
    page,
    text: "UNCLASSIFIED\nDepartment of the Army\nFY 2024 President's Budget",
    blocks: [],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function pageWithTable(page: number, table: ParsedTableV1): ParserPageResultV1 {
  return {
    page,
    text: '$ in Thousands',
    blocks: [],
    tables: [table],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function composedOutputForPages(
  pages: ParserPageResultV1[],
  sourceSha256 = SOURCE_SHA,
): ComposedPageOutputV1 {
  const lineages: PageLineageEntry[] = pages.map((p) => ({
    parserRunId: 'pr1_' + 'a'.repeat(64),
    method: 'deterministic_pdfplumber',
    parserVersion: '1.0.0',
    parserConfigSha256: 'b'.repeat(64),
    sourceSha256,
    page: p.page,
    outputArtifactSha256: 'c'.repeat(64),
  }));
  const selected: SelectedPageResultV1[] = pages.map((p) => ({
    page: p.page,
    selectedParserRunId: 'pr1_' + 'a'.repeat(64),
    selectionReasonCodes: ['resolved_verifier_finding'],
    selectedResult: p,
    alternativeParserRunIds: [],
    failures: [],
  }));
  return {
    schemaVersion: 'defense_budget_composed_output_v1',
    executionId: 'phase10b10-test-exec',
    sourceSha256,
    pages: selected,
    lineages,
    contentSha256: 'd'.repeat(64),
  };
}

function bridgeInputFor(composedOutput: ComposedPageOutputV1): ExtractionArtifactBridgeInput {
  return {
    executionId: 'phase10b10-test-exec',
    cycleId: CYCLE_ID,
    manifestDocumentKey: SOURCE_DOCUMENT_ID,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceSha256: SOURCE_SHA,
    sourceLocator:
      'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
    sourceUrl: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
    composedOutput,
    exhibitType: 'R-1',
    budgetFamily: 'rdte',
    fiscalYear: FY,
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r1',
    title: 'r1',
  };
}

function factoryInput(): RdteDurableSemanticArtifactFactoryInputV1 {
  return {
    document: {
      documentKey: SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r1',
      sourceLocator:
        'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      sourceUrl: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      expectedSourceSha256: SOURCE_SHA,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
      parserPolicy: 'deterministic_table',
      requiredDataCategories: ['identity', 'funding'],
      requiredFundingFields: ['request'],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    } as never,
    source: {
      manifestDocumentKey: SOURCE_DOCUMENT_ID,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourcePdfSha256: SOURCE_SHA,
      sourceLocator:
        'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      sourceUrl: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      fiscalYear: FY,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
      title: 'r1',
    },
    fiscalYear: FY,
  };
}

describe('Phase 10B-10 Part D -- durable RDT&E semantic artifact contains real extracted assertions', () => {
  it('extracts PE 0601102A / Defense Research Sciences / FY2024 request 296670 through the REAL extractor', async () => {
    const store = new FilesystemExtractionArtifactStore(
      await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-')),
    );
    const artifactFactory = createRdteDurableSemanticArtifactFactoryV1(factoryInput());
    const composed = composedOutputForPages([pageWithTable(9, realArmyR1Table())]);
    const output = await artifactFactory(bridgeInputFor(composed), store);

    expect(output.assertionCount).toBeGreaterThan(0);
    const identity = output.artifact.assertions.find(
      (a) => a.assertionKind === 'program_element_identity',
    ) as { peCode?: string; title?: string; identity?: { peCode?: string } } | undefined;
    expect(identity).toBeDefined();
    expect(identity?.identity?.peCode).toBe('0601102A');
    expect(identity?.title).toBe('Defense Research Sciences');

    const funding = output.artifact.assertions.find(
      (a) => a.assertionKind === 'funding' && a.field === 'request',
    ) as
      | {
          fiscalYear?: number;
          money?: { originalValue: string; originalUnit: string; valueMillions: string };
        }
      | undefined;
    expect(funding).toBeDefined();
    expect(funding?.fiscalYear).toBe(2024);
    expect(funding?.money?.originalValue).toBe('296670');
    expect(funding?.money?.originalUnit).toBe('thousands');
    expect(funding?.money?.valueMillions).toBe('296.67');

    expect(
      output.artifact.warnings.some((w) => w.code === 'router_family_assertion_mapping_deferred'),
    ).toBe(false);
  });

  it('persists through the durable store, never exposes the local scratch path', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const store = new FilesystemExtractionArtifactStore(storeRoot);
    const artifactFactory = createRdteDurableSemanticArtifactFactoryV1(factoryInput());
    const composed = composedOutputForPages([pageWithTable(9, realArmyR1Table())]);
    const output = await artifactFactory(bridgeInputFor(composed), store);

    expect(output.artifactLocator.startsWith(storeRoot)).toBe(true);
    expect(output.artifactLocator).not.toContain('capiro-rdte-semantic-artifact-');
    const readBack = await store.readVerified({
      locator: output.artifactLocator,
      expectedByteSha256: output.artifactByteSha256,
    });
    expect(JSON.parse(readBack.toString('utf8')).artifactId).toBe(output.artifactId);
  });
});

describe('Phase 10B-10 Part F -- durability negative controls', () => {
  it('same semantic artifact bytes produce the same content-addressed key', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const store = new FilesystemExtractionArtifactStore(storeRoot);
    const composed = composedOutputForPages([pageWithTable(9, realArmyR1Table())]);
    const first = await createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
      bridgeInputFor(composed),
      store,
    );
    const second = await createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
      bridgeInputFor(composed),
      store,
    );
    expect(second.artifactLocator).toBe(first.artifactLocator);
    expect(second.artifactByteSha256).toBe(first.artifactByteSha256);
  });

  it('a fresh store instance (simulated restart) still reloads the version-pinned artifact and verifies its SHA', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const writingStore = new FilesystemExtractionArtifactStore(storeRoot);
    const composed = composedOutputForPages([pageWithTable(9, realArmyR1Table())]);
    const output = await createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
      bridgeInputFor(composed),
      writingStore,
    );

    // A brand-new store instance pointed at the same root -- no shared
    // in-memory state -- must still resolve the durable, content-addressed
    // locator and re-verify its bytes, exactly like a fresh container after
    // an ECS task restart re-reading S3.
    const freshStore = new FilesystemExtractionArtifactStore(storeRoot);
    const bytes = await freshStore.readVerified({
      locator: output.artifactLocator,
      expectedByteSha256: output.artifactByteSha256,
    });
    expect(JSON.parse(bytes.toString('utf8')).artifactId).toBe(output.artifactId);
  });

  it('durable readback with a mismatched expected SHA fails closed', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const store = new FilesystemExtractionArtifactStore(storeRoot);
    const composed = composedOutputForPages([pageWithTable(9, realArmyR1Table())]);
    const output = await createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
      bridgeInputFor(composed),
      store,
    );
    await expect(
      store.readVerified({ locator: output.artifactLocator, expectedByteSha256: 'f'.repeat(64) }),
    ).rejects.toThrow(/byte SHA mismatch/);
  });

  it('a composed-output source SHA that does not match the declared source SHA fails closed (never silently mismatched)', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const store = new FilesystemExtractionArtifactStore(storeRoot);
    const wrongComposed = composedOutputForPages(
      [pageWithTable(9, realArmyR1Table())],
      'f'.repeat(64),
    );
    await expect(
      createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
        bridgeInputFor(wrongComposed),
        store,
      ),
    ).rejects.toThrow(/source SHA mismatch/);
  });

  it('an R-1 page with funding but zero recognizable PE identities produces zero identity assertions', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const store = new FilesystemExtractionArtifactStore(storeRoot);
    const garbledTable = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2024 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'NOT_A_PE_CODE' },
      { rowIndex: 1, columnIndex: 1, text: 'Unrecognized Row' },
      { rowIndex: 1, columnIndex: 2, text: '1,000' },
    ]);
    const composed = composedOutputForPages([pageWithTable(9, garbledTable)]);
    const output = await createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
      bridgeInputFor(composed),
      store,
    );
    expect(
      output.artifact.assertions.filter((a) => a.assertionKind === 'program_element_identity'),
    ).toHaveLength(0);
  });

  it('resolves proof-bound durable factories for the three supported non-RDT&E families', () => {
    const input = factoryInput();
    expect(() => resolveArtifactFactoryForFamilyV1('procurement', input)).toThrow(
      /requires a parser artifact store/,
    );
    const parserArtifactStore = {
      findExact: jest.fn(),
      readVerified: jest.fn(),
      putVerified: jest.fn(),
    } as never;
    expect(
      resolveArtifactFactoryForFamilyV1('procurement', { ...input, parserArtifactStore }),
    ).toBeDefined();
    expect(
      resolveArtifactFactoryForFamilyV1('om', { ...input, parserArtifactStore }),
    ).toBeDefined();
    expect(
      resolveArtifactFactoryForFamilyV1('milcon', { ...input, parserArtifactStore }),
    ).toBeDefined();
    expect(resolveArtifactFactoryForFamilyV1('rdte', input)).toBeDefined();
    expect(resolveArtifactFactoryForFamilyV1('committee', input)).toBeUndefined();
  });
});

class RepairedCanaryResolver implements TrustedVerificationProofResolverV1 {
  constructor(private readonly artifact: DefenseBudgetExtractionArtifactV1) {}
  async resolve(): Promise<TrustedProofResolutionV1> {
    const manifestDocument = {
      documentKey: SOURCE_DOCUMENT_ID,
      required: true,
      title: 'r1',
      sourceLocator:
        'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      expectedSourceSha256: SOURCE_SHA,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
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
        fiscalYear: FY,
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
          fiscalYear: FY,
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
        // Mirrors what the real production proof-resolution pipeline
        // records for each parser run this artifact actually cites --
        // ProofBoundParserRunRecorder re-verifies bytes before ever writing
        // proofStatus: 'verified'. Synthesized here only because this test
        // bypasses that real recorder; the artifact's own `parserRuns` is
        // the real thing the durable adapter produced.
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

describe('Phase 10B-10 Part E -- repaired artifact resolves the two production blocking failures through the REAL verifier', () => {
  it('completeness and r1_specific no longer FAIL for the zero-assertion reason', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'capiro-test-durable-store-'));
    const store = new FilesystemExtractionArtifactStore(storeRoot);
    const composed = composedOutputForPages([pageWithTable(9, realArmyR1Table())]);
    const output = await createRdteDurableSemanticArtifactFactoryV1(factoryInput())(
      bridgeInputFor(composed),
      store,
    );
    expect(output.assertionCount).toBeGreaterThan(0);

    const service = new BudgetVerificationV1Service(
      new RepairedCanaryResolver(output.artifact),
      null as unknown as BudgetVerificationRepositoryV1,
    );
    const result = await service.verify({
      manifestLocator: 'synthetic://manifest',
      manifestDocumentKey: SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: output.artifactLocator,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      mode: 'inspect',
    });

    const byCode = new Map(result.checks.map((c) => [c.code, c]));
    // The original production defect specifically: both FAILed because the
    // artifact had zero assertions. With real assertions present, neither
    // check may fail for that reason any more.
    expect(byCode.get('completeness')?.outcome).not.toBe('FAIL');
    expect(byCode.get('r1_specific')?.outcome).not.toBe('FAIL');
    expect(byCode.get('completeness')?.message).not.toMatch(/zero assertions/);
    expect(byCode.get('r1_specific')?.message).not.toMatch(/zero PE identity assertions/);
    // The production defect is specifically resolved. This minimal
    // single-page, single-PE, page-only-evidence fixture legitimately still
    // meets OTHER, unrelated, unweakened policy requirements this PR must
    // not touch: an R-2 companion for rdte_summary_detail, and independent
    // reconciliation for page-only money evidence. Both are pre-existing,
    // correct fail-closed behavior -- exactly what Part E requires be
    // preserved, not forced to PASS.
    expect(byCode.get('rdte_summary_detail')?.message).toMatch(/no independently proved R-2/);
    // Deliberately NOT asserting decision === 'PASS': a companion-document
    // requirement (rdte_summary_detail needing an independently proved R-2)
    // or a review-severity warning may legitimately still route this to
    // REVIEW or a companion-source requirement. Forcing PASS here would be
    // exactly the "weaken verification to make the test green" the brief
    // prohibits.
  });
});
