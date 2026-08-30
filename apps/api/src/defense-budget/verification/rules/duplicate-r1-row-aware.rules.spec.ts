/**
 * Phase 10B-13 part 2 — R-1 row-aware duplicate_detection.
 *
 * Proves the natural key extension is scoped exactly to `exhibit === 'R-1'`
 * and driven by the persisted `metadata.rowBudgetActivity` r1-artifact-
 * builder-v1 already writes (Phase 10B-12/13), never by picking a value or
 * weakening the rule for any other exhibit family.
 */
import { extractR1FromPages } from '../../rdte/r1/r1-extractor-v1.js';
import { buildR1Artifact } from '../../rdte/r1/r1-artifact-builder-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { ParserPageResultV1, ParsedTableV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type { R1RowContextV1 } from '../../rdte/r1/r1-text-row-reconstructor-v1.js';
import type { VerificationContextV1 } from '../verification-input-v1.js';
import { DUPLICATE_RULE } from './duplicate.rules.js';

const CYCLE_FY = 2027;
const SHA = 'f'.repeat(64);

function makeTable(
  cells: Array<{ rowIndex: number; columnIndex: number; text: string }>,
): ParsedTableV1 {
  const rowCount = Math.max(...cells.map((c) => c.rowIndex)) + 1;
  const columnCount = Math.max(...cells.map((c) => c.columnIndex)) + 1;
  return { tableIndex: 0, rowCount, columnCount, cells, warnings: [] };
}

function makeRequestTable(peCode: string, title: string, request: string): ParsedTableV1 {
  return makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'PE' },
    { rowIndex: 0, columnIndex: 1, text: 'Title' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
    { rowIndex: 1, columnIndex: 0, text: peCode },
    { rowIndex: 1, columnIndex: 1, text: title },
    { rowIndex: 1, columnIndex: 2, text: request },
  ]);
}

function makeNumberedPage(pageNumber: number, table: ParsedTableV1): ParserPageResultV1 {
  return {
    page: pageNumber,
    text: '$ in Thousands',
    blocks: [],
    tables: [table],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function ctx(overrides: Partial<R1RowContextV1>): R1RowContextV1 {
  return {
    lineNumber: '1',
    budgetActivity: '01',
    budgetActivityCategory: 'U',
    sectionHeading: 'Department of the Air Force',
    component: 'AF',
    componentEvidence: 'test',
    ...overrides,
  };
}

function makeSource(exhibit: ExtractionSourceV1['exhibit']): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'doc',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/doc.pdf',
    fiscalYear: CYCLE_FY,
    family: 'rdte',
    exhibit,
    authority: 'dod-comptroller',
    component: 'UNKNOWN',
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

function buildArtifact(
  exhibit: ExtractionSourceV1['exhibit'],
  pages: ParserPageResultV1[],
  rowContextByPage?: Map<number, Map<number, R1RowContextV1>>,
): DefenseBudgetExtractionArtifactV1 {
  const extraction = extractR1FromPages({
    pages,
    cycleFiscalYear: CYCLE_FY,
    ...(rowContextByPage ? { rowContextByPage } : {}),
  });
  return buildR1Artifact({
    source: makeSource(exhibit),
    parserRuns: [],
    extraction,
    cycleFiscalYear: CYCLE_FY,
  });
}

function context(artifact: DefenseBudgetExtractionArtifactV1): VerificationContextV1 {
  return {
    verificationRunId: 'vr-dup-r1',
    candidateId: 'candidate-dup-r1',
    policy: {},
    policySha256: 'e'.repeat(64),
    input: {
      artifact,
      referenceArtifacts: [],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
    },
  } as unknown as VerificationContextV1;
}

describe('DUPLICATE_RULE — Phase 10B-13 R-1 row-aware natural key', () => {
  it('R-1: same PE, different budget activity, different request -> NOT a duplicate-verification failure', () => {
    // Real-source case: PE 0604201F, BA04 request 18,041 vs BA05 request
    // 163,156, both "Department of the Air Force".
    const pages = [
      makeNumberedPage(41, makeRequestTable('0604201F', 'PNT Resiliency, Mods, and Improvements', '18,041')),
      makeNumberedPage(43, makeRequestTable('0604201F', 'PNT Resiliency, Mods, and Improvements', '163,156')),
    ];
    const rowContextByPage = new Map([
      [41, new Map([[1, ctx({ budgetActivity: '04', lineNumber: '48' })]])],
      [43, new Map([[1, ctx({ budgetActivity: '05', lineNumber: '77' })]])],
    ]);
    const artifact = buildArtifact('R-1', pages, rowContextByPage);
    const result = DUPLICATE_RULE.execute(context(artifact));
    expect(result.check?.outcome).toBe('PASS');
    expect(
      result.discrepancies.filter((d) => d.code === 'duplicate_funding_natural_key'),
    ).toHaveLength(0);
  });

  it('R-1: same PE, SAME budget activity, different request -> still a true blocking duplicate', () => {
    const pages = [
      makeNumberedPage(1, makeRequestTable('0601101A', 'Research', '1,200')),
      makeNumberedPage(2, makeRequestTable('0601101A', 'Research', '1,300')),
    ];
    const rowContextByPage = new Map([
      [1, new Map([[1, ctx({ budgetActivity: '01', lineNumber: '5' })]])],
      [2, new Map([[1, ctx({ budgetActivity: '01', lineNumber: '5' })]])],
    ]);
    const artifact = buildArtifact('R-1', pages, rowContextByPage);
    const result = DUPLICATE_RULE.execute(context(artifact));
    expect(result.check?.outcome).toBe('FAIL');
    expect(
      result.discrepancies.filter((d) => d.code === 'duplicate_funding_natural_key'),
    ).toHaveLength(1);
  });

  it('R-1: no persisted row-budget-activity context -> fails closed onto the original conservative key', () => {
    const pages = [
      makeNumberedPage(1, makeRequestTable('0601101A', 'Research', '1,200')),
      makeNumberedPage(2, makeRequestTable('0601101A', 'Research', '1,300')),
    ];
    // No rowContextByPage supplied -- matches a structural-table R-1
    // document with no reconstructor metadata.
    const artifact = buildArtifact('R-1', pages);
    const result = DUPLICATE_RULE.execute(context(artifact));
    expect(result.check?.outcome).toBe('FAIL');
    expect(
      result.discrepancies.filter((d) => d.code === 'duplicate_funding_natural_key'),
    ).toHaveLength(1);
  });

  it('non-R-1 exhibit: identical PE/FY/field with different (hypothetical) row context is STILL a blocking duplicate -- no global weakening', () => {
    const pages = [
      makeNumberedPage(1, makeRequestTable('0601101A', 'Research', '1,200')),
      makeNumberedPage(2, makeRequestTable('0601101A', 'Research', '1,300')),
    ];
    const rowContextByPage = new Map([
      [1, new Map([[1, ctx({ budgetActivity: '04', lineNumber: '48' })]])],
      [2, new Map([[1, ctx({ budgetActivity: '05', lineNumber: '77' })]])],
    ]);
    // Same shape of "different budget activity" that exempts R-1 above,
    // but this artifact declares a different exhibit -- the natural key
    // must ignore rowBudgetActivity entirely and use the original,
    // exhibit-agnostic key, so this is still caught.
    const artifact = buildArtifact('R-2', pages, rowContextByPage);
    const result = DUPLICATE_RULE.execute(context(artifact));
    expect(result.check?.outcome).toBe('FAIL');
    expect(
      result.discrepancies.filter((d) => d.code === 'duplicate_funding_natural_key'),
    ).toHaveLength(1);
  });
});
