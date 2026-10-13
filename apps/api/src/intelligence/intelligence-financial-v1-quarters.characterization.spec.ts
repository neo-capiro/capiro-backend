import {
  harness,
  installHooks,
  now,
  type QuarterInput,
} from '../../test/fixtures/intelligence-financial.js';

installHooks();

function input(overrides: Partial<QuarterInput> = {}): QuarterInput {
  return { mappedLdaClientIds: [], lobbyingYearly: [], obligationsYearly: [], now, ...overrides };
}

it('financial quarters returns eight oldest-to-newest labels ending at the supplied local quarter', async () => {
  const h = harness();
  const result = await h.subject.buildRoiQuarterSeries(input({ now: new Date(2024, 6, 1) }));
  expect(result).toEqual([
    { label: "Q4'22", lobbying: 0, obligations: 0 },
    { label: "Q1'23", lobbying: 0, obligations: 0 },
    { label: "Q2'23", lobbying: 0, obligations: 0 },
    { label: "Q3'23", lobbying: 0, obligations: 0 },
    { label: "Q4'23", lobbying: 0, obligations: 0 },
    { label: "Q1'24", lobbying: 0, obligations: 0 },
    { label: "Q2'24", lobbying: 0, obligations: 0 },
    { label: "Q3'24", lobbying: 0, obligations: 0 },
  ]);
  expect(h.calls).toEqual([]);
});

it('financial quarters maps all filing periods, sums aliases and binds the original full ID array', async () => {
  const ids = [9, 4, 9];
  const h = harness({
    rows: {
      quarterRows: [
        { filing_year: 2026, filing_period: 'first_quarter', amount: 11 },
        { filing_year: 2026, filing_period: 'second_quarter', amount: 12 },
        { filing_year: 2026, filing_period: 'third_quarter', amount: 13 },
        { filing_year: 2026, filing_period: 'fourth_quarter', amount: 14 },
        { filing_year: 2026, filing_period: 'mid_year', amount: 22 },
        { filing_year: 2026, filing_period: 'year_end', amount: -4 },
        { filing_year: 2026, filing_period: 'unknown', amount: 999 },
        { filing_year: 2026, filing_period: null, amount: 999 },
        { filing_year: 2024, filing_period: 'first_quarter', amount: 999 },
      ],
    },
  });
  const result = await h.subject.buildRoiQuarterSeries(input({ mappedLdaClientIds: ids }));
  expect(result).toEqual([
    { label: "Q1'25", lobbying: 0, obligations: 0 },
    { label: "Q2'25", lobbying: 0, obligations: 0 },
    { label: "Q3'25", lobbying: 0, obligations: 0 },
    { label: "Q4'25", lobbying: 0, obligations: 0 },
    { label: "Q1'26", lobbying: 11, obligations: 0 },
    { label: "Q2'26", lobbying: 34, obligations: 0 },
    { label: "Q3'26", lobbying: 13, obligations: 0 },
    { label: "Q4'26", lobbying: 10, obligations: 0 },
  ]);
  expect(h.callsOf('quarterRows')[0]!.query).toMatchObject({
    sql: 'SELECT filing_year, filing_period, COALESCE(SUM(income), 0)::float AS amount FROM lda_filing WHERE client_id = ANY($1::int[]) AND filing_period IS NOT NULL GROUP BY filing_year, filing_period',
    values: [[9, 4, 9]],
  });
  expect(h.callsOf('quarterRows')[0]!.query!.values[0]).toBe(ids);
  expect(h.calls[0]!.scope).toBe('global');
  expect(h.calls[0]!.tenantId).toBeUndefined();
});

it('financial quarters keeps mapped empty filings authoritative over annual lobbying fallback', async () => {
  const h = harness();
  const result = await h.subject.buildRoiQuarterSeries(
    input({
      mappedLdaClientIds: [3],
      lobbyingYearly: [{ year: 2026, amount: 800 }],
      obligationsYearly: [{ year: 2026, amount: 160 }],
    }),
  );
  expect(result.slice(4)).toEqual([
    { label: "Q1'26", lobbying: 0, obligations: 40 },
    { label: "Q2'26", lobbying: 0, obligations: 40 },
    { label: "Q3'26", lobbying: 0, obligations: 40 },
    { label: "Q4'26", lobbying: 0, obligations: 40 },
  ]);
  expect(h.calls.map((call) => call.operation)).toEqual(['quarterRows']);
});

it('financial quarters distributes annual amounts evenly with last-year-entry authority', async () => {
  const h = harness();
  const result = await h.subject.buildRoiQuarterSeries(
    input({
      lobbyingYearly: [
        { year: 2025, amount: 40 },
        { year: 2026, amount: 100 },
        { year: 2026, amount: -20 },
      ],
      obligationsYearly: [
        { year: 2025, amount: 200 },
        { year: 2025, amount: 120 },
        { year: 2026, amount: 8 },
      ],
    }),
  );
  expect(result).toEqual([
    { label: "Q1'25", lobbying: 10, obligations: 30 },
    { label: "Q2'25", lobbying: 10, obligations: 30 },
    { label: "Q3'25", lobbying: 10, obligations: 30 },
    { label: "Q4'25", lobbying: 10, obligations: 30 },
    { label: "Q1'26", lobbying: -5, obligations: 2 },
    { label: "Q2'26", lobbying: -5, obligations: 2 },
    { label: "Q3'26", lobbying: -5, obligations: 2 },
    { label: "Q4'26", lobbying: -5, obligations: 2 },
  ]);
  expect(h.calls).toEqual([]);
});

it('financial quarters retains signed quarterly dollars and ignores years outside the window', async () => {
  const h = harness({
    rows: {
      quarterRows: [
        { filing_year: 2025, filing_period: 'first_quarter', amount: -3.5 },
        { filing_year: 2027, filing_period: 'first_quarter', amount: 999 },
      ],
    },
  });
  const result = await h.subject.buildRoiQuarterSeries(
    input({
      mappedLdaClientIds: [4],
      obligationsYearly: [{ year: 2025, amount: -10 }],
    }),
  );
  expect(result[0]).toEqual({ label: "Q1'25", lobbying: -3.5, obligations: -2.5 });
  expect(result[7]).toEqual({ label: "Q4'26", lobbying: 0, obligations: 0 });
});

it('financial quarters leaves caller dates, IDs and yearly arrays unchanged', async () => {
  const request = input({
    mappedLdaClientIds: [4],
    lobbyingYearly: [{ year: 2026, amount: 40 }],
    obligationsYearly: [{ year: 2025, amount: 80 }],
  });
  const original = structuredClone(request);
  const h = harness({
    rows: { quarterRows: [{ filing_year: 2026, filing_period: 'year_end', amount: 7 }] },
  });
  await h.subject.buildRoiQuarterSeries(request);
  expect(request).toEqual(original);
  expect(request.now).toBe(now);
  expect(h.callsOf('quarterRows')[0]!.query!.values[0]).toBe(request.mappedLdaClientIds);
});

it('financial quarters propagates filing-query failure without using annual fallback', async () => {
  const failure = new Error('LDA unavailable');
  const h = harness({ errors: { quarterRows: failure } });
  await expect(
    h.subject.buildRoiQuarterSeries(
      input({ mappedLdaClientIds: [4], lobbyingYearly: [{ year: 2026, amount: 40 }] }),
    ),
  ).rejects.toBe(failure);
  expect(h.calls.map((call) => call.operation)).toEqual(['quarterRows']);
});
