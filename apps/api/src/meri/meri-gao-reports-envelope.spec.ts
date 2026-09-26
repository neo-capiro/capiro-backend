import type { MeriResultEnvelope } from '@capiro/shared';
import { envelopeGaoReportsResult, observeGaoReportsCall } from './meri-gao-reports-envelope.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'GAO-24-106155',
  title: 'Defense acquisition report',
  url: 'https://www.gao.gov/products/gao-24-106155',
  publishDate: new Date('2024-06-01T00:00:00.000Z'),
  reportType: 'Report',
  topics: ['Defense'],
  agencies: ['Department of Defense'],
  summary: 'A shortened display summary',
  recommendations: 3,
  ...overrides,
});

const payload = (data: unknown[], total: number) => ({
  tool: 'search_gao_reports',
  generatedAt: '2026-09-25T12:00:00.000Z',
  total,
  data,
});

describe('GAO reports result envelope (dormant observer)', () => {
  it('preserves the result while reporting only a bounded local page', () => {
    const legacy = payload([row()], 1);
    const result = envelopeGaoReportsResult(legacy, {
      query: '  Defense  ', reportType: ' Report ', limit: 5,
    });

    expect(result.legacyPayload).toBe(legacy);
    expect(result.outcome).toBe('succeeded');
    expect(result.sources).toEqual([expect.objectContaining({
      family: 'search', sourceId: 'gao_report', availability: 'available',
      scope: {
        storage: 'capiro_local_database', query: 'Defense',
        reportType: 'Report', limit: 5,
      },
      observedAt: null,
      coverage: { completeness: 'unknown', returnedCount: 1, matchedCount: null },
      provenance: [{
        recordId: 'GAO-24-106155', sourceId: 'gao_report',
        url: 'https://www.gao.gov/products/gao-24-106155',
      }],
    })]);
    // This fixture visibly matches; other returned rows may have hidden matches.
    expect(result.sources[0]?.coverage.continuation).toBeUndefined();
    expect(result.truncation).toEqual({ truncated: false });
  });

  it('does not promote separate empty page/count reads to a no-match claim', () => {
    const result = envelopeGaoReportsResult(payload([], 0), { query: 'shipbuilding' });

    expect(result.outcome).toBe('succeeded');
    expect(result.sources[0]).toMatchObject({
      availability: 'available', observedAt: null,
      coverage: { completeness: 'unknown', returnedCount: 0, matchedCount: null },
      provenance: [],
    });
  });

  it('keeps coverage unknown when the separate count and page disagree', () => {
    const more = envelopeGaoReportsResult(payload([row()], 31), { limit: 1 });
    const fewer = envelopeGaoReportsResult(payload([row()], 0), { limit: 1 });

    for (const result of [more, fewer]) {
      expect(result.outcome).toBe('partial');
      expect(result.sources[0]?.availability).toBe('available');
      expect(result.sources[0]?.coverage).toEqual({
        completeness: 'unknown', returnedCount: 1, matchedCount: null,
      });
      expect(result.truncation).toEqual({ truncated: true, reason: 'possible_local_result_cap' });
    }
  });

  it('flags possible display-text truncation without inferring a hidden query match', () => {
    const result = envelopeGaoReportsResult(payload([row({
      summary: `${'a'.repeat(397)}...`,
    })], 1), { query: 'hidden' });

    expect(result.outcome).toBe('succeeded');
    expect(result.sources[0]?.coverage.completeness).toBe('unknown');
    expect(result.truncation).toEqual({
      truncated: true, reason: 'possible_display_text_truncation',
    });
  });

  it('omits an unverified external URL without denying the local table read', () => {
    const result = envelopeGaoReportsResult(payload([row({
      url: 'https://www.gao.gov.evil.test/products/gao-24-106155',
    })], 1), {});

    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.availability).toBe('available');
    expect(result.sources[0]?.provenance).toEqual([{
      recordId: 'GAO-24-106155', sourceId: 'gao_report',
    }]);
    expect(result.errors).toEqual([{ code: 'gao_report_url_unverified' }]);
  });

  it('accepts the nullable public-record fields without inventing provenance', () => {
    const result = envelopeGaoReportsResult(payload([row({
      url: null, publishDate: null, reportType: null, recommendations: null,
    })], 1), { limit: '99' });

    expect(result.outcome).toBe('succeeded');
    expect(result.sources[0]?.scope).toEqual({
      storage: 'capiro_local_database', limit: 50,
    });
    expect(result.sources[0]?.provenance).toEqual([{
      recordId: 'GAO-24-106155', sourceId: 'gao_report',
    }]);
  });

  const unverifiedCases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['wrong tool', { ...payload([row()], 1), tool: 'other_tool' }, {}],
    ['missing count', { ...payload([row()], 1), total: undefined }, {}],
    ['too many rows', payload([row(), row({ id: 'GAO-24-106156' })], 2), { limit: 1 }],
    ['report type mismatch', payload([row()], 1), { reportType: 'Testimony' }],
    ['malformed topics', payload([row({ topics: 'Defense' })], 1), {}],
    ['unapplied filter', payload([row()], 1), { reportType: 42 }],
  ];

  it.each(unverifiedCases)('does not certify %s', (_label, legacy, request) => {
    const result = envelopeGaoReportsResult(legacy, request);

    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.availability).toBe('unknown');
    expect(result.sources[0]?.coverage).toEqual({
      completeness: 'unknown', matchedCount: null,
    });
    expect(result.sources[0]?.provenance).toEqual([]);
    expect(result.truncation.truncated).toBe(true);
    expect(result.errors).toEqual([{ code: 'gao_reports_observation_unverified' }]);
  });

  it('never changes the returned object or thrown error when observation fails', async () => {
    const legacy = payload([row()], 1);
    const observed: MeriResultEnvelope<typeof legacy>[] = [];
    await expect(observeGaoReportsCall(async () => legacy, {}, (envelope) => {
      observed.push(envelope);
    })).resolves.toBe(legacy);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.legacyPayload).toBe(legacy);

    await expect(observeGaoReportsCall(async () => legacy, {}, () => {
      throw new Error('observer failed');
    })).resolves.toBe(legacy);

    const failure = new Error('legacy read failed');
    const observer = jest.fn();
    await expect(observeGaoReportsCall(async () => { throw failure; }, {}, observer))
      .rejects.toBe(failure);
    expect(observer).not.toHaveBeenCalled();
  });
});
