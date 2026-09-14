import {
  compileNewsQuery,
  matchNews,
  canonicalNewsUrl,
  dollarsToMinorUnits,
  compareBudgetAmounts,
  briefingOccurrence,
  validateBriefingSchedule,
  type BudgetAmount,
  type BriefingSchedule,
} from '@capiro/shared';
import { createGenerateEditorialBriefTool } from '@capiro/meriv2-core';
import { fiscalContextFact } from '../src/tracker/editorial/editorial-fiscal-context';

const amount = (overrides: Partial<BudgetAmount> = {}): BudgetAmount => ({
  id: 'a',
  projectId: 'FL:2026-27:S:1',
  fiscalYear: '2026-27',
  periodStart: '2026-07-01',
  periodEnd: '2027-06-30',
  currency: 'USD',
  fund: 'GR',
  basis: 'nonrecurring',
  measure: 'money',
  minorUnits: '10000000',
  state: 'amount',
  stage: 'chamber_proposal',
  chamber: 'House',
  offer: 'initial',
  sourceRevision: 'r1',
  documentId: 'd1',
  locator: 'pdf:2/display:1/row:3/GR',
  unitMultiplier: '1',
  allocationBasis: 'project',
  qualified: true,
  ...overrides,
});
describe('Phase 8 exact query, money, schedule and grounded claims', () => {
  test('preserves quoted phrases and implicit AND without cross-field phrases', () => {
    expect(compileNewsQuery('"term limits"').raw).toBe('"term limits"');
    expect(compileNewsQuery('term limits').providerQuery).toContain('AND');
    expect(
      matchNews('"term limits"', {
        title: 'Limits debated; term of office changed',
        bodyComplete: true,
      }).outcome,
    ).not.toBe('match');
    expect(
      matchNews('term limits', {
        title: 'Limits debated; term of office changed',
        bodyComplete: true,
      }).outcome,
    ).toBe('match');
    expect(
      matchNews('"term limits"', { title: 'term', summary: 'limits', bodyComplete: true }).outcome,
    ).not.toBe('match');
  });
  test('unknown body cannot establish a content-negative match', () => {
    expect(matchNews('water AND NOT sewage', { title: 'Water funding announced' }).outcome).toBe(
      'not_fully_evaluated',
    );
    expect(matchNews('water', { title: 'Water funding announced' }).outcome).toBe('match');
    expect(matchNews('sewage', { title: 'Water funding announced' }).outcome).toBe(
      'not_fully_evaluated',
    );
    expect(compileNewsQuery('water*').status).toBe('unsupported');
  });
  test('canonical URL preserves substantive identifiers and does not conflate similar titles', () => {
    expect(canonicalNewsUrl('https://example.org/story?id=42&utm_source=mail#top')).toBe(
      'https://example.org/story?id=42',
    );
    expect(canonicalNewsUrl('https://example.org/story?id=43')).not.toBe(
      canonicalNewsUrl('https://example.org/story?id=42'),
    );
    expect(() => canonicalNewsUrl('javascript:alert(1)')).toThrow();
  });
  test('exact money exceeds Number precision; explicit zero differs from blank and embedded', () => {
    expect(dollarsToMinorUnits('$9,007,199,254,740,993.01')).toBe('900719925474099301');
    expect(dollarsToMinorUnits('1.25', '1000')).toBe('125000');
    expect(() => dollarsToMinorUnits('1.001')).toThrow();
    const zero = compareBudgetAmounts(
      amount({ minorUnits: '0' }),
      amount({ id: 'b', minorUnits: '100' }),
    );
    expect(zero.deltaMinorUnits).toBe('100');
    expect(zero.percentage).toBeNull();
    for (const state of ['blank', 'omitted', 'embedded', 'unpublished'] as const)
      expect(compareBudgetAmounts(amount({ state, minorUnits: null }), amount()).comparable).toBe(
        false,
      );
  });
  test.each([
    'projectId',
    'fiscalYear',
    'periodStart',
    'periodEnd',
    'fund',
    'basis',
    'measure',
    'allocationBasis',
  ] as const)('refuses incompatible %s without false delta', (key) => {
    expect(
      compareBudgetAmounts(amount(), amount({ [key]: 'different' } as never)).deltaMinorUnits,
    ).toBeNull();
  });
  test('parallel chamber amounts can be compared but are never implicitly summed', () => {
    const result = compareBudgetAmounts(
      amount(),
      amount({ id: 'b', chamber: 'Senate', minorUnits: '7500000' }),
    );
    expect(result.deltaMinorUnits).toBe('-2500000');
    expect(result.percentage).toBe('-25.00%');
  });
  const schedule: BriefingSchedule = {
    timezone: 'America/New_York',
    hour: 1,
    minute: 30,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    noChange: 'skip',
    sourceGap: 'hold',
    mode: 'prepare',
  };
  test('repeated DST hour creates one occurrence; skipped hour catches up', () => {
    expect(briefingOccurrence(new Date('2026-11-01T05:30:00Z'), schedule)).toBe(
      briefingOccurrence(new Date('2026-11-01T06:30:00Z'), schedule),
    );
    expect(briefingOccurrence(new Date('2026-03-08T07:00:00Z'), { ...schedule, hour: 2 })).toBe(
      '2026-03-08@America/New_York',
    );
    expect(briefingOccurrence(new Date('2026-09-14T04:15:00Z'), schedule)).toBeNull();
    expect(() => validateBriefingSchedule({ ...schedule, timezone: 'Unknown/place' })).toThrow();
  });
  test('model output cannot cite invented revisions or rewrite quoted source text', async () => {
    const input = {
      template: 'morning_news_brief',
      cutoff: '2026-09-14T00:00:00Z',
      timezone: 'UTC',
      coverage: 'Available title only',
      sources: [
        {
          id: 'a',
          revision: 'r',
          locator: 'headline',
          kind: 'news',
          text: 'Agency announces proposed funding',
          authority: 'Attributed reporting',
        },
      ],
    } as const;
    for (const claim of [
      { kind: 'fact', text: 'A claim', references: [] },
      {
        kind: 'fact',
        text: 'A claim',
        references: [{ id: 'a', revision: 'wrong', locator: 'headline' }],
      },
      {
        kind: 'quote',
        text: 'Funding awarded',
        references: [{ id: 'a', revision: 'r', locator: 'headline' }],
      },
    ]) {
      const llm = {
        completeWithSchema: jest.fn().mockResolvedValue({ input: { claims: [claim] } }),
      };
      await expect(
        createGenerateEditorialBriefTool(llm as never).handler(input as never, {} as never),
      ).rejects.toThrow();
    }
  });
  test('scheduled fiscal context preserves explicit columns, qualified units, veto role and unknowns', () => {
    const row = {
      ...amount(),
      qualified: true,
      minorUnits: '100000000',
      chamber: 'Senate',
      fund: 'General Revenue',
      valueRole: 'vetoed_allocation_amount',
    };
    expect(fiscalContextFact(row)).toMatchObject({
      display: 'USD 1,000,000.00',
      chamber: 'Senate',
      fund: 'General Revenue',
      valueRole: 'vetoed_allocation_amount',
      sourceRevision: row.sourceRevision,
      locator: row.locator,
    });
    expect(fiscalContextFact({ ...row, minorUnits: '0', state: 'zero' }).display).toBe('USD 0.00');
    expect(fiscalContextFact({ ...row, state: 'blank', minorUnits: null }).display).toBeNull();
    expect(fiscalContextFact({ ...row, qualified: false }).display).toBeNull();
  });
});
