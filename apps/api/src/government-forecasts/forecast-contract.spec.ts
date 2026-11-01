import {
  civilDay,
  contentHash,
  forecastId,
  monthBounds,
  parsePage,
  parseRange,
  validateContent,
  type ForecastContent,
} from './forecast-contract.js';

const content = (): ForecastContent => ({
  title: 'Synthetic proposed rule',
  eventType: 'proposed_rule',
  period: { precision: 'month', raw: '11/00/2026', year: 2026, month: 11 },
  status: 'published',
  source: {
    rin: '0000-AA00',
    edition: '202510',
    url: 'https://www.reginfo.gov/public/do/eAgendaViewRule?RIN=0000-AA00',
    issuedAt: null,
    sha256: 'a'.repeat(64),
  },
  confidence: 'not_supplied',
});

describe('forecast civil periods and provenance', () => {
  it('keeps month bounds as civil filtering bounds across year end', () => {
    expect(monthBounds({ precision: 'month', raw: '12/00/2026', year: 2026, month: 12 })).toEqual({
      from: '2026-12-01',
      to: '2027-01-01',
    });
    expect(content().period).not.toHaveProperty('startsAt');
  });
  it('keeps unknown/fiscal periods unplaced', () => {
    expect(monthBounds({ precision: 'unknown', raw: 'Q1 FY2027' })).toBeNull();
  });
  it.each([0, 13, 1.5, NaN])('refuses malformed month %s', (month) => {
    expect(() => monthBounds({ precision: 'month', raw: 'bad', year: 2026, month })).toThrow();
  });
  it.each(['2026-02-30', '2026-11-01T00:00:00Z', '2026-1-01', 'FY2027'])(
    'refuses non-civil day %s',
    (day) => {
      expect(civilDay(day)).toBe(false);
    },
  );
  it('accepts leap day and rejects impossible leap day', () => {
    expect(civilDay('2028-02-29')).toBe(true);
    expect(civilDay('2027-02-29')).toBe(false);
  });
  it('validates half-open bounded ranges and explicit filter choices', () => {
    expect(parseRange({ from: '2026-11-01', to: '2026-12-01' })).toMatchObject({
      includeUndated: false,
    });
    for (const q of [
      { from: '2026-11-01', to: '2026-11-01' },
      { from: '2026-11-02', to: '2026-11-01' },
      { from: '2026-01-01', to: '2028-01-01' },
      { from: '2026-11-01', to: '2026-12-01', includeWithdrawn: 'yes' },
    ])
      expect(() => parseRange(q)).toThrow();
    expect(() => parsePage({ page: '0' })).toThrow();
    expect(() => parsePage({ pageSize: '101' })).toThrow();
  });
  it('keeps stable identity across date revisions and distinguishes action identities', () => {
    expect(forecastId('0000-AA00:proposed_rule')).toBe(forecastId('0000-AA00:proposed_rule'));
    expect(forecastId('0000-AA00:proposed_rule')).not.toBe(forecastId('0000-AA00:final_rule'));
  });
  it('content changes create a new digest while object field order does not', () => {
    const a = content();
    expect(contentHash({ ...a, source: { ...a.source } })).toBe(contentHash(a));
    expect(
      contentHash({
        ...a,
        status: 'withdrawn',
        withdrawalEvidence: { action: 'Withdrawn', rawDate: '10/30/2026' },
      }),
    ).not.toBe(contentHash(a));
    expect(
      contentHash({
        ...a,
        period: { precision: 'month', raw: '12/00/2026', year: 2026, month: 12 },
      }),
    ).not.toBe(contentHash(a));
  });
  it('refuses fabricated confidence and foreign source links', () => {
    expect(() => validateContent({ ...content(), confidence: 'high' } as never)).toThrow();
    expect(() =>
      validateContent({
        ...content(),
        source: { ...content().source, url: 'https://example.com' },
      }),
    ).toThrow();
    expect(() =>
      validateContent({
        ...content(),
        source: { ...content().source, url: 'https://user@www.reginfo.gov' },
      }),
    ).toThrow();
  });
});
