import {
  FY26_SCOPE_SUFFIX,
  FY26_YEAR,
  admitsRawBill,
  fiscalYearMode,
  fy26ScopedSuffix,
  rawBillEligibleFy26,
  rawBillEventDates,
  textVersionsForAdmission,
} from './bill-fy26-admission.js';

describe('fiscalYearMode', () => {
  it('is opt-in: absent and blank values leave behaviour unchanged', () => {
    expect(fiscalYearMode(undefined)).toBeNull();
    expect(fiscalYearMode('')).toBeNull();
    expect(fiscalYearMode('   ')).toBeNull();
  });

  it('accepts exactly 2026', () => {
    expect(fiscalYearMode('2026')).toBe(FY26_YEAR);
    expect(fiscalYearMode(' 2026 ')).toBe(FY26_YEAR);
  });

  it.each(['2025', '2027', 'twenty26', '2026x', '0', '-2026'])(
    'rejects malformed or unsupported fiscal year %p',
    (value) => {
      expect(() => fiscalYearMode(value)).toThrow(/BILL_FISCAL_YEAR must be 2026/);
    },
  );

  it('scopes durable keys only in FY26 mode', () => {
    expect(fy26ScopedSuffix(null)).toBe('');
    expect(fy26ScopedSuffix(FY26_YEAR)).toBe(FY26_SCOPE_SUFFIX);
    expect(FY26_SCOPE_SUFFIX).toBe(':fy26');
  });
});

describe('raw bill official event dates', () => {
  it('uses history and progress dates only, ignoring session/sync/text dates', () => {
    const raw = {
      session: { year_start: 2025, year_end: 2026 },
      synced_at: '2026-03-04T10:00:00Z',
      status_date: '2026-02-02',
      history: [{ date: '2025-01-14' }, { date: '2025-11-06' }],
      progress: [{ date: '2025-12-01' }],
      texts: [{ date: '2026-04-01' }],
    };
    expect(rawBillEventDates(raw)).toEqual(['2025-01-14', '2025-11-06', '2025-12-01']);
  });

  it('tolerates missing or malformed entries without admitting anything', () => {
    expect(rawBillEventDates({})).toEqual([]);
    expect(rawBillEventDates({ history: [null, { date: 42 }], progress: [{ date: '' }] })).toEqual(
      [],
    );
    expect(rawBillEligibleFy26({})).toBe(false);
    expect(rawBillEligibleFy26(null)).toBe(false);
  });
});

describe('FY26 parent admission', () => {
  const at = (date: string, action = 'Filed') => ({ date, action });

  it('admits introduced-in-FY26 bills', () => {
    expect(rawBillEligibleFy26({ history: [at('2025-11-01')] })).toBe(true);
  });

  it('admits an old introduced bill whose later action lands in FY26', () => {
    expect(
      rawBillEligibleFy26({
        history: [at('2025-02-11', 'Introduced'), at('2026-02-20', 'Referred to committee')],
      }),
    ).toBe(true);
  });

  it('rejects session-only and sync-only bills with no FY26 action', () => {
    expect(
      rawBillEligibleFy26({
        session: { year_start: 2025, year_end: 2026 },
        synced_at: '2026-05-01T00:00:00Z',
        history: [at('2025-02-11', 'Introduced')],
        progress: [{ date: '2025-03-01' }],
        texts: [{ date: '2026-04-01' }],
      }),
    ).toBe(false);
  });

  it('treats the FY26 window as half-open [2025-10-01, 2026-10-01)', () => {
    expect(rawBillEligibleFy26({ history: [at('2025-09-30T23:59:59Z')] })).toBe(false);
    expect(rawBillEligibleFy26({ history: [at('2025-10-01')] })).toBe(true);
    expect(rawBillEligibleFy26({ history: [at('2026-09-30T23:59:59Z')] })).toBe(true);
    expect(rawBillEligibleFy26({ history: [at('2026-10-01')] })).toBe(false);
  });

  it('preserves every text version of an eligible parent and none for an excluded one', () => {
    const texts = [
      { doc_id: 1, date: '2025-02-11' },
      { doc_id: 2, date: '2025-11-20' },
      { doc_id: 3, date: '2026-04-02' },
    ];
    expect(textVersionsForAdmission({ texts }, true)).toEqual(texts);
    expect(textVersionsForAdmission({ texts }, false)).toEqual([]);
    expect(textVersionsForAdmission({}, true)).toEqual([]);
  });

  it('keeps all bills admitted when FY26 mode is absent', () => {
    const raw = { history: [at('2024-02-11')] };
    expect(admitsRawBill(raw, null)).toBe(true);
    expect(admitsRawBill(raw, FY26_YEAR)).toBe(false);
  });
});
