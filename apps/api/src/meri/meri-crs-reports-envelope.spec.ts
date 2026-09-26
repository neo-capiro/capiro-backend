import type { MeriResultEnvelope } from '@capiro/shared';
import { envelopeCrsReportsResult, observeCrsReportsCall } from './meri-crs-reports-envelope.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'R47650',
  title: 'Defense policy report',
  date: new Date('2024-06-01T00:00:00.000Z'),
  authors: ['Analyst'],
  topics: ['Defense'],
  summary: 'A shortened display summary',
  pdfUrl: 'https://crsreports.congress.gov/product/pdf/R/R47650',
  htmlUrl: null,
  ...overrides,
});

const payload = (data: unknown[], total: number) => ({
  tool: 'search_crs_reports',
  generatedAt: '2026-09-25T12:00:00.000Z',
  total,
  data,
});

describe('CRS reports result envelope (dormant observer)', () => {
  it('preserves the result and reports returned local records only', () => {
    const legacy = payload([row()], 1);
    const result = envelopeCrsReportsResult(legacy, { query: '  Defense  ', limit: 5 });

    expect(result.legacyPayload).toBe(legacy);
    expect(result.outcome).toBe('succeeded');
    expect(result.sources).toEqual([expect.objectContaining({
      family: 'search', sourceId: 'crs_report', availability: 'available',
      scope: {
        storage: 'capiro_local_database', activeOnly: true, query: 'Defense', limit: 5,
      },
      observedAt: null,
      coverage: { completeness: 'unknown', returnedCount: 1, matchedCount: null },
      provenance: [{
        recordId: 'R47650', sourceId: 'crs_report',
        url: 'https://crsreports.congress.gov/product/pdf/R/R47650',
      }],
    })]);
    expect(result.sources[0]?.coverage.continuation).toBeUndefined();
    expect(result.sources[0]?.provenance[0]?.sourceVersion).toBeUndefined();
    expect(result.truncation).toEqual({ truncated: false });
  });

  it('does not promote separate empty page/count reads to a no-match claim', () => {
    const result = envelopeCrsReportsResult(payload([], 0), { query: 'shipbuilding' });

    expect(result.outcome).toBe('succeeded');
    expect(result.sources[0]).toMatchObject({
      availability: 'available', observedAt: null,
      coverage: { completeness: 'unknown', returnedCount: 0, matchedCount: null },
      provenance: [],
    });
    expect(result.sources[0]?.coverage.continuation).toBeUndefined();
  });

  it('does not infer a visible-field match when text was summarized', () => {
    const result = envelopeCrsReportsResult(payload([row({
      summary: `${'a'.repeat(397)}...`,
    })], 1), { query: 'hidden source text' });

    expect(result.outcome).toBe('succeeded');
    expect(result.sources[0]?.coverage.completeness).toBe('unknown');
    expect(result.truncation).toEqual({
      truncated: true, reason: 'possible_display_text_truncation',
    });
  });

  it('flags a full page and separately reported additional rows as possible caps', () => {
    const full = envelopeCrsReportsResult(payload([row()], 1), { limit: 1 });
    expect(full.sources[0]?.coverage).toEqual({
      completeness: 'unknown', returnedCount: 1, matchedCount: null,
    });
    expect(full.truncation).toEqual({ truncated: true, reason: 'possible_local_result_cap' });

    const more = envelopeCrsReportsResult(payload([row()], 31), { limit: 5 });
    expect(more.outcome).toBe('partial');
    expect(more.sources[0]?.coverage.matchedCount).toBeNull();
    expect(more.truncation).toEqual({ truncated: true, reason: 'possible_local_result_cap' });
  });

  it('does not trust a count below the returned page', () => {
    const result = envelopeCrsReportsResult(payload([row()], 0), {});

    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.availability).toBe('available');
    expect(result.sources[0]?.coverage).toEqual({
      completeness: 'unknown', returnedCount: 1, matchedCount: null,
    });
    expect(result.errors).toEqual([{ code: 'crs_reports_count_page_inconsistent' }]);
  });

  it('reports both an untrusted URL and a count below the page', () => {
    const legacy = payload([row({
      pdfUrl: 'https://crsreports.congress.gov.evil.example/product/pdf/R/R47650',
    })], 0);
    const result = envelopeCrsReportsResult(legacy, {});

    expect(result.legacyPayload).toBe(legacy);
    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.provenance).toEqual([{
      recordId: 'R47650', sourceId: 'crs_report',
    }]);
    expect(result.errors).toEqual([
      { code: 'crs_report_url_unverified' },
      { code: 'crs_reports_count_page_inconsistent' },
    ]);
  });

  it('uses only an exact official HTTPS origin in provenance', () => {
    const hostile = envelopeCrsReportsResult(payload([row({
      htmlUrl: 'https://crsreports.congress.gov.evil.example/product/html/R/R47650',
      pdfUrl: 'http://crsreports.congress.gov/product/pdf/R/R47650',
    })], 1), {});

    expect(hostile.outcome).toBe('partial');
    expect(hostile.sources[0]?.availability).toBe('available');
    expect(hostile.sources[0]?.provenance).toEqual([{
      recordId: 'R47650', sourceId: 'crs_report',
    }]);
    expect(hostile.errors).toEqual([{ code: 'crs_report_url_unverified' }]);

    const safeFallback = envelopeCrsReportsResult(payload([row({
      htmlUrl: 'https://crsreports.congress.gov@evil.example/product/html/R/R47650',
    })], 1), {});
    expect(safeFallback.outcome).toBe('partial');
    expect(safeFallback.sources[0]?.provenance[0]?.url)
      .toBe('https://crsreports.congress.gov/product/pdf/R/R47650');

    for (const pdfUrl of [
      'https://user@crsreports.congress.gov/product/pdf/R/R47650',
      'https://crsreports.congress.gov:444/product/pdf/R/R47650',
    ]) {
      const result = envelopeCrsReportsResult(payload([row({ pdfUrl })], 1), {});
      expect(result.sources[0]?.provenance[0]?.url).toBeUndefined();
      expect(result.errors).toEqual([{ code: 'crs_report_url_unverified' }]);
    }
  });

  it('accepts nullable public-record fields without inventing freshness', () => {
    const result = envelopeCrsReportsResult(payload([row({
      date: null, pdfUrl: null, htmlUrl: null,
    })], 1), { limit: '99' });

    expect(result.outcome).toBe('succeeded');
    expect(result.sources[0]?.scope).toEqual({
      storage: 'capiro_local_database', activeOnly: true, limit: 50,
    });
    expect(result.sources[0]?.provenance).toEqual([{
      recordId: 'R47650', sourceId: 'crs_report',
    }]);
    expect(result.sources[0]?.observedAt).toBeNull();
  });

  const unverifiedCases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['wrong tool', { ...payload([row()], 1), tool: 'other_tool' }, {}],
    ['missing count', { ...payload([row()], 1), total: undefined }, {}],
    ['more rows than applied limit', payload([row(), row({ id: 'R47651' })], 2), { limit: 1 }],
    ['duplicate local IDs', payload([row(), row()], 2), {}],
    ['malformed authors', payload([row({ authors: 'Analyst' })], 1), {}],
    ['malformed date', payload([row({ date: 'not-a-date' })], 1), {}],
    ['unapplied query type', payload([row()], 1), { query: 42 }],
  ];

  it.each(unverifiedCases)('does not certify %s', (_label, legacy, request) => {
    const result = envelopeCrsReportsResult(legacy, request);

    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.availability).toBe('unknown');
    expect(result.sources[0]?.coverage).toEqual({
      completeness: 'unknown', matchedCount: null,
    });
    expect(result.sources[0]?.provenance).toEqual([]);
    expect(result.truncation.truncated).toBe(true);
    expect(result.errors).toEqual([{ code: 'crs_reports_observation_unverified' }]);
  });

  it('mirrors the handler limit coercion without inferring coverage', () => {
    const negative = envelopeCrsReportsResult(payload([], 0), { limit: -3 });
    const invalid = envelopeCrsReportsResult(payload([], 0), { limit: 'invalid' });

    expect(negative.sources[0]?.scope.limit).toBe(1);
    expect(invalid.sources[0]?.scope.limit).toBe(20);
    expect(negative.sources[0]?.coverage.completeness).toBe('unknown');
    expect(invalid.sources[0]?.coverage.completeness).toBe('unknown');
  });

  it('never changes the returned object or thrown error when observation fails', async () => {
    const legacy = payload([row()], 1);
    const observed: MeriResultEnvelope<typeof legacy>[] = [];
    await expect(observeCrsReportsCall(async () => legacy, {}, (envelope) => {
      observed.push(envelope);
    })).resolves.toBe(legacy);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.legacyPayload).toBe(legacy);

    await expect(observeCrsReportsCall(async () => legacy, {}, () => {
      throw new Error('observer failed');
    })).resolves.toBe(legacy);

    const failure = new Error('legacy read failed');
    const observer = jest.fn();
    await expect(observeCrsReportsCall(async () => { throw failure; }, {}, observer))
      .rejects.toBe(failure);
    expect(observer).not.toHaveBeenCalled();
  });

  it('returns the legacy object without waiting for a pending observer', async () => {
    const legacy = payload([row()], 1);
    const pendingObserver = new Promise<void>(() => undefined);

    // A regression that awaits the observer leaves this assertion pending.
    await expect(observeCrsReportsCall(async () => legacy, {}, () => pendingObserver))
      .resolves.toBe(legacy);
  });

  it('consumes a rejecting async observer without changing the legacy result', async () => {
    const legacy = payload([row()], 1);

    await expect(observeCrsReportsCall(async () => legacy, {}, () =>
      Promise.reject(new Error('async observer failed')))).resolves.toBe(legacy);
  });
});
