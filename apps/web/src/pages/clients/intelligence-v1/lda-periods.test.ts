import { describe, expect, it } from 'vitest';
import { filingQuarter, summarizeLdaPeriods } from './lda-periods.js';
import type { LdaFilingRow } from './lda-filings-api.js';

const filing = (
  year: number,
  quarter: number,
  amount: number,
  extra: Partial<LdaFilingRow> = {},
): LdaFilingRow => ({
  filingUuid: `${year}-${quarter}`,
  filingType: 'LD-2',
  filingYear: year,
  filingPeriod: `Q${quarter}`,
  amount,
  income: amount,
  expenses: 0,
  postedAt: `${year}-07-01`,
  registrantName: 'Registrant',
  clientName: 'Client',
  issueCodes: [],
  governmentEntities: [],
  lobbyists: [],
  documentUrl: null,
  ...extra,
});
const now = new Date('2026-09-08T12:00:00Z');

describe('LDA reporting periods', () => {
  it.each([
    ['FIRST_QUARTER', 1],
    ['2nd Quarter', 2],
    ['2026 Q3', 3],
    ['Fourth Quarter', 4],
    ['Year end', null],
  ])('parses %s', (value, quarter) => {
    expect(filingQuarter(value as string)).toBe(quarter);
  });
  it('uses four completed reporting quarters, not every loaded year or posting dates', () => {
    const result = summarizeLdaPeriods(
      [
        filing(2021, 1, 999),
        filing(2025, 3, 100),
        filing(2025, 4, 200),
        filing(2026, 1, 300),
        filing(2026, 2, 400),
        filing(2026, 3, 888),
      ],
      now,
    );
    expect(result.amount).toBe(1000);
    expect(result.windowLabel).toBe('Q3 2025–Q2 2026');
  });
  it('compares the same quarters and supersedes an earlier amendment', () => {
    const result = summarizeLdaPeriods(
      [
        filing(2025, 1, 100),
        filing(2025, 2, 100),
        filing(2025, 3, 900),
        filing(2025, 4, 900),
        filing(2026, 1, 100),
        filing(2026, 2, 100),
        filing(2026, 2, 200, {
          filingUuid: 'amendment',
          postedAt: '2026-08-01',
        }),
      ],
      now,
    );
    expect(result.yoy).toBe(50);
    expect(result.comparisonLabel).toBe('Q1–Q2 2026 vs Q1–Q2 2025');
  });
  it('does not invent a comparable prior period or resolve ambiguous amendments arbitrarily', () => {
    expect(summarizeLdaPeriods([filing(2026, 1, 100)], now).yoy).toBeNull();
    expect(
      summarizeLdaPeriods(
        [filing(2026, 2, 100), filing(2026, 2, 200, { filingUuid: 'other' })],
        now,
      ).amount,
    ).toBeNull();
  });
});
