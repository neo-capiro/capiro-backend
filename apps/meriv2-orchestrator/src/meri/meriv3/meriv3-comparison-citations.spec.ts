import {
  compareBudgetAmounts,
  compareResearchVersions,
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  type BudgetAmount,
  type ResearchVersion,
} from '@capiro/shared';
import { projectMeriToolEvidence } from './meriv3-tool-evidence.js';

const budgetAmount = (overrides: Partial<BudgetAmount> = {}): BudgetAmount => ({
  id: 'amount-house',
  projectId: 'FL:2026-27:SYNTHETIC-1',
  fiscalYear: '2026-27',
  periodStart: '2026-07-01',
  periodEnd: '2027-06-30',
  currency: 'USD',
  fund: 'General Revenue',
  basis: 'nonrecurring',
  measure: 'money',
  minorUnits: '5000000',
  state: 'amount',
  stage: 'chamber_proposal',
  chamber: 'House',
  offer: 'initial',
  sourceRevision: 'revision-house-2026',
  documentId: 'budget-document-house',
  locator: 'pdf:2/row:3/GR',
  unitMultiplier: '1',
  allocationBasis: 'project',
  qualified: true,
  ...overrides,
});

const researchVersion = (overrides: Partial<ResearchVersion> = {}): ResearchVersion => ({
  id: 'FL:2026:SB432:introduced',
  billId: 'FL:2026:SB432',
  jurisdiction: 'FL',
  sessionKey: '2026',
  revision: 'revision-introduced',
  contentHash: 'content-introduced',
  extractorVersion: 'text-v1',
  sourceUrl: 'https://www.flsenate.gov/Session/Bill/2026/432',
  kind: 'bill_text',
  publishedDate: '2026-01-12',
  observedAt: '2026-01-13T00:00:00.000Z',
  complete: true,
  sections: [{ locator: 'page:2', text: 'Section 1. Old text.', hash: 'section-old' }],
  ...overrides,
});

describe('B6 exact comparison source-to-citation oracles', () => {
  it('retains an exact global aggregate value without inventing a source-record citation', () => {
    // AnalyticsDbService.normalizeRow emits this Decimal as a string because
    // converting it to Number would round the cents away.
    const ownerResponse = {
      tool: 'query_global_data',
      dataset: 'federal_awards',
      sql: 'SELECT SUM(amount) AS sum_amount FROM federal_award LIMIT 1',
      rowCount: 1,
      rows: [{ sum_amount: '9007199254740993.01' }],
    };
    const visible = projectMeriToolEvidence({
      result: ownerResponse, maxCharacters: 12_000, readOnly: true,
    });
    expect(visible).toEqual(ownerResponse);
    expect(extractCitationsFromToolResult('query_global_data', visible, 1)).toEqual([]);
  });

  it('keeps exact cents in the model result and cites each qualified source, not the delta', () => {
    const left = budgetAmount();
    const right = budgetAmount({
      id: 'amount-senate',
      chamber: 'Senate',
      minorUnits: '5400000',
      sourceRevision: 'revision-senate-2026',
      documentId: 'budget-document-senate',
      locator: 'pdf:5/row:9/GR',
    });
    const ownerResult = compareBudgetAmounts(left, right);
    expect(ownerResult).toMatchObject({
      comparable: true,
      deltaMinorUnits: '400000',
      percentage: '8.00%',
    });
    const visible = projectMeriToolEvidence({
      result: { tool: 'compare_florida_budget_amounts', result: ownerResult },
      maxCharacters: 12_000,
      readOnly: true,
    }) as Record<string, any>;
    expect(visible.result.left.minorUnits).toBe('5000000');
    expect(visible.result.right.minorUnits).toBe('5400000');
    expect(visible.presentation).toMatchObject({
      left: 'USD 50,000.00',
      right: 'USD 54,000.00',
      deltaRightMinusLeft: 'USD 4,000.00',
    });
    const citations = extractCitationsFromToolResult('compare_florida_budget_amounts', visible, 4);
    expect(citations.map((citation) => [citation.n, citation.id, citation.url])).toEqual([
      [4, 'amount-house', null],
      [5, 'amount-senate', null],
    ]);
    expect(citations[0]?.snippet).toContain('budget-document-house; revision revision-house-2026; locator pdf:2/row:3/GR; 5000000 USD cents');
    expect(citations[1]?.snippet).toContain('budget-document-senate; revision revision-senate-2026; locator pdf:5/row:9/GR; 5400000 USD cents');
    expect(formatCitationsForPrompt(citations)).toContain('[4] Florida budget amount amount-house');
    expect(citations.some((citation) => citation.id === '400000')).toBe(false);
  });

  it('refuses an incompatible fiscal basis and never displays or cites a computed delta', () => {
    const result = compareBudgetAmounts(budgetAmount(), budgetAmount({
      id: 'amount-different-basis', basis: 'recurring', minorUnits: '5400000',
    }));
    expect(result).toMatchObject({
      comparable: false,
      reasons: expect.arrayContaining(['INCOMPATIBLE_basis']),
      deltaMinorUnits: null,
      percentage: null,
    });
    const visible = projectMeriToolEvidence({
      result: { tool: 'compare_florida_budget_amounts', result },
      maxCharacters: 12_000,
      readOnly: true,
    }) as Record<string, any>;
    expect(visible.presentation.deltaRightMinusLeft).toBeNull();
    expect(extractCitationsFromToolResult('compare_florida_budget_amounts', visible, 1)).toHaveLength(2);
  });

  it('does not cite unqualified, blank, clipped or provenance-free amount observations', () => {
    const ownerResult = compareBudgetAmounts(budgetAmount(), budgetAmount({
      id: 'amount-senate', minorUnits: '5400000',
    }));
    const response = { tool: 'compare_florida_budget_amounts', result: ownerResult };
    const citations = (value: unknown) => extractCitationsFromToolResult('compare_florida_budget_amounts', value, 1);
    expect(citations({ ...response, truncated: true })).toEqual([]);
    expect(citations({ ...response, result: { ...ownerResult, left: { ...ownerResult.left, qualified: false } } })).toHaveLength(1);
    expect(citations({ ...response, result: { ...ownerResult, left: { ...ownerResult.left, state: 'blank', minorUnits: null } } })).toHaveLength(1);
    expect(citations({ ...response, result: { ...ownerResult, left: { ...ownerResult.left, locator: '' } } })).toHaveLength(1);
    expect(citations({ ...response, result: { ...ownerResult, left: { ...ownerResult.left, sourceRevision: '' } } })).toHaveLength(1);
  });

  it('cites exact legislative versions and change locators, with only an explicit valid source URL', () => {
    const left = researchVersion();
    const right = researchVersion({
      id: 'FL:2026:SB432:engrossed',
      revision: 'revision-engrossed',
      contentHash: 'content-engrossed',
      sourceUrl: 'https://www.flsenate.gov/Session/Bill/2026/432/BillText/e1/PDF',
      sections: [{ locator: 'page:7', text: 'Section 1. New text.', hash: 'section-new' }],
    });
    const result = compareResearchVersions(left, right);
    expect(result.classification).toBe('textual_change');
    expect(result.changes.map((change) => change.kind)).toEqual(['removed', 'added']);
    const ownerResponse = { tool: 'compare_legislative_versions', result };
    const visible = projectMeriToolEvidence({ result: ownerResponse, maxCharacters: 12_000, readOnly: true });
    expect(visible).toEqual(ownerResponse);
    const citations = extractCitationsFromToolResult('compare_legislative_versions', visible, 1);
    expect(citations.map((citation) => [citation.id, citation.url])).toEqual([
      ['FL:2026:SB432:introduced', left.sourceUrl],
      ['FL:2026:SB432:engrossed', right.sourceUrl],
    ]);
    expect(citations[0]?.snippet).toContain('Revision revision-introduced; FL session 2026; locator page:2');
    expect(citations[1]?.snippet).toContain('Revision revision-engrossed; FL session 2026; locator page:7');
  });

  it('refuses the wrong bill/session pair, incomplete text and invalid or invented URLs', () => {
    const left = researchVersion();
    const wrong = researchVersion({ id: 'FL:2025:HB999', billId: 'FL:2025:HB999', sessionKey: '2025' });
    expect(() => compareResearchVersions(left, wrong)).toThrow('EXPLICIT_CROSS_BILL_SELECTION_REQUIRED');
    expect(() => compareResearchVersions(left, researchVersion({ complete: false }))).toThrow('COMPARISON_REQUIRES_COMPLETE_EXTRACTIONS');
    const result = compareResearchVersions(left, researchVersion({ id: 'right', revision: 'right-rev' }));
    const malformed = { ...result, right: { ...result.right, sourceUrl: 'https://user:pass@example.gov/path' } };
    const citations = extractCitationsFromToolResult('compare_legislative_versions', { tool: 'compare_legislative_versions', result: malformed }, 1);
    expect(citations).toHaveLength(2);
    expect(citations[1]?.url).toBeNull();
    expect(extractCitationsFromToolResult('compare_legislative_versions', {
      tool: 'compare_legislative_versions', result: { ...result, right: { ...result.right, complete: false } },
    }, 1)).toHaveLength(1);
    expect(extractCitationsFromToolResult('compare_legislative_versions', {
      tool: 'compare_legislative_versions', result: { ...result, changes: [] },
    }, 1)).toEqual([]);
  });
});
