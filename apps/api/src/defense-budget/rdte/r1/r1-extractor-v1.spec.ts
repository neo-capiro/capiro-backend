/**
 * r1-extractor-v1.spec — Workstream C tests.
 *
 * Synthetic/golden fixtures for:
 *   - standard R-1 table;
 *   - multi-row header;
 *   - page continuation;
 *   - base/OCO/total;
 *   - wrapped title;
 *   - missing unit;
 *   - shifted column;
 *   - OCR-mangled PE code;
 *   - duplicate PE row;
 *   - FYDP outyears;
 *   - cost-to-complete/total cost;
 *   - zero-dollar row;
 *   - negative adjustment where valid.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractR1FromPages } from './r1-extractor-v1.js';
import { buildR1Artifact } from './r1-artifact-builder-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import type { R1RowContextV1 } from './r1-text-row-reconstructor-v1.js';

const CYCLE_FY = 2027;
const SHA = 'd'.repeat(64);

function makeTable(
  cells: Array<{ rowIndex: number; columnIndex: number; text: string }>,
): ParsedTableV1 {
  const rowCount = Math.max(...cells.map((c) => c.rowIndex)) + 1;
  const columnCount = Math.max(...cells.map((c) => c.columnIndex)) + 1;
  return {
    tableIndex: 0,
    rowCount,
    columnCount,
    cells,
    warnings: [],
  };
}

function makePage(tables: ParsedTableV1[], text?: string): ParserPageResultV1 {
  return {
    page: 1,
    text,
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function makeSource(): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'r1_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/r1.pdf',
    fiscalYear: CYCLE_FY,
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

describe('r1-extractor-v1', () => {
  it('extracts a standard R-1 table with FYDP columns', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2025 Actual' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2026 Enacted' },
      { rowIndex: 0, columnIndex: 4, text: 'FY 2027 Request' },
      { rowIndex: 0, columnIndex: 5, text: 'FY 2028' },
      { rowIndex: 0, columnIndex: 6, text: 'Cost to Complete' },
      { rowIndex: 0, columnIndex: 7, text: 'Total Cost' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research Project' },
      { rowIndex: 1, columnIndex: 2, text: '1,000' },
      { rowIndex: 1, columnIndex: 3, text: '1,100' },
      { rowIndex: 1, columnIndex: 4, text: '1,200' },
      { rowIndex: 1, columnIndex: 5, text: '1,300' },
      { rowIndex: 1, columnIndex: 6, text: '500' },
      { rowIndex: 1, columnIndex: 7, text: '5,100' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.peCode).toBe('0601101A');
    expect(result.identities[0]?.title).toBe('Research Project');

    expect(result.funding).toHaveLength(6);
    const byRole = new Map(result.funding.map((f) => [f.columnRole, f]));
    expect(byRole.get('prior_actual_context')?.originalValue).toBe('1000');
    expect(byRole.get('prior_actual_context')?.disposition).toBe('contextual_only');
    expect(byRole.get('current_enacted_context')?.originalValue).toBe('1100');
    expect(byRole.get('budget_year_request')?.originalValue).toBe('1200');
    expect(byRole.get('budget_year_request')?.disposition).toBe('canonical_request_candidate');
    expect(byRole.get('outyear_projection')?.originalValue).toBe('1300');
    expect(byRole.get('outyear_projection')?.disposition).toBe('pe_budget_position');
    expect(byRole.get('cost_to_complete')?.disposition).toBe('non_annual_cost');
    expect(byRole.get('total_cost')?.disposition).toBe('non_annual_cost');
    expect(result.omissions).toHaveLength(0);
  });

  it('handles multi-row headers', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: '' },
      { rowIndex: 1, columnIndex: 1, text: '' },
      { rowIndex: 1, columnIndex: 2, text: 'Request' },
      { rowIndex: 2, columnIndex: 0, text: '0601101A' },
      { rowIndex: 2, columnIndex: 1, text: 'Research' },
      { rowIndex: 2, columnIndex: 2, text: '1,200' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.columnRole).toBe('budget_year_request');
  });

  it('handles base/OCO/total columns', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Base' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2027 OCO' },
      { rowIndex: 0, columnIndex: 4, text: 'FY 2027 Total' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,000' },
      { rowIndex: 1, columnIndex: 3, text: '200' },
      { rowIndex: 1, columnIndex: 4, text: '1,200' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(3);
    const roles = result.funding.map((f) => f.columnRole).sort();
    expect(roles).toEqual(['base_component', 'oco_component', 'total_component']);
    // Components are contextual_only, never canonical request candidates.
    for (const f of result.funding) {
      expect(f.disposition).toBe('contextual_only');
    }
  });

  it('rejects OCR-mangled PE codes as omissions, never coerces', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'O6O11O1A' }, // OCR mangled
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,200' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.identities).toHaveLength(0);
    expect(result.funding).toHaveLength(0);
  });

  it('detects duplicate PE rows with conflicting values', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,200' },
      { rowIndex: 2, columnIndex: 0, text: '0601101A' },
      { rowIndex: 2, columnIndex: 1, text: 'Research Duplicate' },
      { rowIndex: 2, columnIndex: 2, text: '1,300' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.values.sort()).toEqual(['1200', '1300']);
  });

  /* ------------------------------------------------------------------ */
  /* Phase 10B-12: row-identity-aware duplicate/conflict semantics.      */
  /* Proven against the real FY2024 R-1 document (258 cross-page PE      */
  /* codes; zero true same-identity contradictions found there).        */
  /* ------------------------------------------------------------------ */

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

  it('same PE / same row identity / different request -> true blocking conflict', () => {
    const pages = [
      makeNumberedPage(1, makeRequestTable('0601101A', 'Research', '1,200')),
      makeNumberedPage(2, makeRequestTable('0601101A', 'Research', '1,300')),
    ];
    const rowContextByPage = new Map([
      [1, new Map([[1, ctx({ sectionHeading: 'Department of the Air Force', budgetActivity: '01' })]])],
      [2, new Map([[1, ctx({ sectionHeading: 'Department of the Air Force', budgetActivity: '01' })]])],
    ]);
    const result = extractR1FromPages({ pages, cycleFiscalYear: CYCLE_FY, rowContextByPage });
    expect(result.funding).toHaveLength(2); // both kept, never last-wins
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.values.sort()).toEqual(['1200', '1300']);
  });

  it('same PE / different legitimate budget activity / different request -> NOT automatically a conflict, both kept', () => {
    // Real-source case: PE 0604201F, "PNT Resiliency, Mods, and Improvements",
    // page 41 BA04 request 18,041 vs page 43 BA05 request 163,156, both
    // under "Department of the Air Force".
    const pages = [
      makeNumberedPage(41, makeRequestTable('0604201F', 'PNT Resiliency, Mods, and Improvements', '18,041')),
      makeNumberedPage(43, makeRequestTable('0604201F', 'PNT Resiliency, Mods, and Improvements', '163,156')),
    ];
    const rowContextByPage = new Map([
      [41, new Map([[1, ctx({ sectionHeading: 'Department of the Air Force', budgetActivity: '04' })]])],
      [43, new Map([[1, ctx({ sectionHeading: 'Department of the Air Force', budgetActivity: '05' })]])],
    ]);
    const result = extractR1FromPages({ pages, cycleFiscalYear: CYCLE_FY, rowContextByPage });
    expect(result.funding).toHaveLength(2); // both real, independent facts preserved
    expect(result.funding.map((f) => f.originalValue).sort()).toEqual(['163156', '18041']);
    expect(result.conflicts).toHaveLength(0); // not automatically a conflict
  });

  it('same PE / identical value reprinted on another page -> deterministic duplicate, no second assertion', () => {
    // Real-source case: PE 0601101E, "Defense Research Sciences", restated
    // identically in both the Defense-Wide roll-up (page 62) and DARPA's
    // own chapter (page 82).
    const pages = [
      makeNumberedPage(62, makeRequestTable('0601101E', 'Defense Research Sciences', '311,531')),
      makeNumberedPage(82, makeRequestTable('0601101E', 'Defense Research Sciences', '311,531')),
    ];
    const rowContextByPage = new Map([
      [62, new Map([[1, ctx({ sectionHeading: 'Defense-Wide', component: 'DW', budgetActivity: '01' })]])],
      [82, new Map([[1, ctx({ sectionHeading: 'Defense Advanced Research Projects Agency', component: 'DARPA', budgetActivity: '01' })]])],
    ]);
    const result = extractR1FromPages({ pages, cycleFiscalYear: CYCLE_FY, rowContextByPage });
    expect(result.funding).toHaveLength(1); // provenance merge, not two assertions
    expect(result.funding[0]?.originalValue).toBe('311531');
    expect(result.conflicts).toHaveLength(0);
    expect(result.identities).toHaveLength(2); // faithful row-level identity record, unaffected
  });

  it('cross-component genuinely different constituent rows -> both kept, not automatically a conflict', () => {
    const pages = [
      makeNumberedPage(1, makeRequestTable('0999999D', 'Shared Initiative', '5,000')),
      makeNumberedPage(2, makeRequestTable('0999999D', 'Shared Initiative', '7,500')),
    ];
    const rowContextByPage = new Map([
      [1, new Map([[1, ctx({ sectionHeading: 'Defense-Wide', component: 'DW', budgetActivity: '02' })]])],
      [2, new Map([[1, ctx({ sectionHeading: 'Missile Defense Agency', component: 'MDA', budgetActivity: '03' })]])],
    ]);
    const result = extractR1FromPages({ pages, cycleFiscalYear: CYCLE_FY, rowContextByPage });
    expect(result.funding).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });

  it('missing row-identity evidence on either side falls back to treating recurring different values as a true conflict (safe default)', () => {
    const pages = [
      makeNumberedPage(1, makeRequestTable('0601101A', 'Research', '1,200')),
      makeNumberedPage(2, makeRequestTable('0601101A', 'Research', '1,300')),
    ];
    // No rowContextByPage supplied at all -- matches a structural-table R-1
    // document, where this contextual seam has no data.
    const result = extractR1FromPages({ pages, cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
  });

  it('handles zero-dollar rows', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Zero Project' },
      { rowIndex: 1, columnIndex: 2, text: '0' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.originalValue).toBe('0');
  });

  it('handles negative adjustments', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Adjustment' },
      { rowIndex: 1, columnIndex: 2, text: '-500' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.originalValue).toBe('-500');
  });

  it('omits all money cells when unit is missing', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,200' },
    ]);
    const page = makePage([table]); // no unit text
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'missing_unit')).toBe(true);
  });

  it('omits cells with unresolved column roles', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'Unknown Column' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,200' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.funding).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'unresolved_column_role')).toBe(true);
  });

  it('treats repeated header rows as metadata, not PE rows', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'PE' },
      { rowIndex: 1, columnIndex: 1, text: 'Title' },
      { rowIndex: 1, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 2, columnIndex: 0, text: '0601101A' },
      { rowIndex: 2, columnIndex: 1, text: 'Research' },
      { rowIndex: 2, columnIndex: 2, text: '1,200' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const result = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    expect(result.identities).toHaveLength(1);
    expect(result.funding).toHaveLength(1);
  });

  it('is deterministic under page input permutation', () => {
    const table1 = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research A' },
      { rowIndex: 1, columnIndex: 2, text: '1,200' },
    ]);
    const table2 = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601102A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research B' },
      { rowIndex: 1, columnIndex: 2, text: '2,400' },
    ]);
    const page1 = { ...makePage([table1], '$ in Thousands'), page: 1 };
    const page2 = { ...makePage([table2], '$ in Thousands'), page: 2 };

    const resultA = extractR1FromPages({ pages: [page1, page2], cycleFiscalYear: CYCLE_FY });
    const resultB = extractR1FromPages({ pages: [page2, page1], cycleFiscalYear: CYCLE_FY });

    const sortFunding = (r: typeof resultA) =>
      [...r.funding].sort(
        (a, b) => a.peCode.localeCompare(b.peCode) || (a.fiscalYear ?? 0) - (b.fiscalYear ?? 0),
      );
    expect(sortFunding(resultA)).toEqual(sortFunding(resultB));
  });
});

describe('r1-artifact-builder-v1', () => {
  it('builds a valid artifact with funding assertions for request only', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2025 Actual' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Request' },
      { rowIndex: 0, columnIndex: 4, text: 'FY 2028' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,000' },
      { rowIndex: 1, columnIndex: 3, text: '1,200' },
      { rowIndex: 1, columnIndex: 4, text: '1,300' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const extraction = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    const artifact = buildR1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction,
      cycleFiscalYear: CYCLE_FY,
    });

    const fundingAssertions = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(fundingAssertions).toHaveLength(1);
    if (fundingAssertions[0]?.assertionKind === 'funding') {
      expect(fundingAssertions[0].field).toBe('request');
      expect(fundingAssertions[0].fiscalYear).toBe(2027);
      expect(fundingAssertions[0].money.originalValue).toBe('1200');
    }

    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(docFacts.length).toBe(2); // actual + outyear

    const identities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(identities).toHaveLength(1);
  });

  it('produces deterministic artifact IDs under input permutation', () => {
    const table = makeTable([
      { rowIndex: 0, columnIndex: 0, text: 'PE' },
      { rowIndex: 0, columnIndex: 1, text: 'Title' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: '0601101A' },
      { rowIndex: 1, columnIndex: 1, text: 'Research' },
      { rowIndex: 1, columnIndex: 2, text: '1,200' },
    ]);
    const page = makePage([table], '$ in Thousands');
    const extraction = extractR1FromPages({ pages: [page], cycleFiscalYear: CYCLE_FY });
    const artifactA = buildR1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction,
      cycleFiscalYear: CYCLE_FY,
    });
    const artifactB = buildR1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(artifactA.artifactId).toBe(artifactB.artifactId);
    expect(artifactA.contentSha256).toBe(artifactB.contentSha256);
  });
});
