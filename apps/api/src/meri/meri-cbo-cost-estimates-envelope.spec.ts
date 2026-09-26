import {
  envelopeCboCostEstimatesResult,
  observeCboCostEstimatesCall,
} from './meri-cbo-cost-estimates-envelope.js';

const row = () => ({
  id: '62540',
  billId: '119-hr-8800',
  congress: 119,
  billType: 'hr',
  billNumber: '8800',
  title: 'NDAA cost estimate',
  description: null,
  pubDate: new Date('2026-06-01T00:00:00.000Z'),
  cboUrl: 'https://www.cbo.gov/publication/62540',
});

const payload = (estimates: unknown[]) => ({
  tool: 'search_cbo_cost_estimates',
  generatedAt: '2026-09-25T12:00:00.000Z',
  estimatesFound: estimates.length,
  estimates,
});

describe('CBO cost-estimate result envelope (dormant observer)', () => {
  it('describes a verified local query and keeps the exact legacy object', () => {
    const legacy = payload([row()]);
    const result = envelopeCboCostEstimatesResult(legacy, {
      billId: ' 119-HR-8800 ', query: 'ndaa', congress: 119, limit: 5,
    });

    expect(result.legacyPayload).toBe(legacy);
    expect(result.outcome).toBe('succeeded');
    expect(result.sources).toEqual([expect.objectContaining({
      family: 'legislative',
      sourceId: 'cbo_cost_estimate',
      availability: 'available',
      scope: {
        storage: 'capiro_local_database', billId: '119-hr-8800',
        query: 'ndaa', congress: 119, limit: 5,
      },
      observedAt: null,
      coverage: {
        completeness: 'complete', continuation: { hasMore: false },
        returnedCount: 1, matchedCount: 1,
      },
      provenance: [{
        recordId: '62540', sourceId: 'cbo_cost_estimate',
        url: 'https://www.cbo.gov/publication/62540',
      }],
    })]);
    expect(result.truncation).toEqual({ truncated: false });
  });

  it('limits a no-match finding to the queried local table', () => {
    const result = envelopeCboCostEstimatesResult(payload([]), {
      billId: '119-hr-9999',
    });

    expect(result.outcome).toBe('not_found_within_scope');
    expect(result.sources[0]).toMatchObject({
      sourceId: 'cbo_cost_estimate', availability: 'available',
      scope: { storage: 'capiro_local_database', billId: '119-hr-9999', limit: 10 },
      observedAt: null,
      coverage: { completeness: 'complete', returnedCount: 0, matchedCount: 0 },
      provenance: [],
    });
  });

  it('does not invent a total, continuation cursor, or truncation on a full page', () => {
    const result = envelopeCboCostEstimatesResult(payload([row()]), { limit: 1 });

    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.coverage).toEqual({
      completeness: 'partial', returnedCount: 1, matchedCount: null,
    });
    expect(result.truncation).toEqual({ truncated: false });
  });

  it('matches the handler default and clamped limits without claiming an upstream total', () => {
    expect(envelopeCboCostEstimatesResult(payload([]), { limit: 'invalid' }).sources[0]?.scope.limit)
      .toBe(10);
    expect(envelopeCboCostEstimatesResult(payload([]), { limit: -20 }).sources[0]?.scope.limit)
      .toBe(1);
    expect(envelopeCboCostEstimatesResult(payload([]), { limit: 99 }).sources[0]?.scope.limit)
      .toBe(25);
  });

  const unverifiedCases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['tool identity', { ...payload([row()]), tool: 'different_tool' }, {}],
    ['count mismatch', { ...payload([row()]), estimatesFound: 2 }, {}],
    ['missing rows', { ...payload([]), estimates: undefined }, {}],
    ['rows beyond applied limit', payload([row(), { ...row(), id: '62541' }]), { limit: 1 }],
    ['bill filter mismatch', payload([row()]), { billId: '119-hr-9999' }],
    ['Congress filter mismatch', payload([row()]), { congress: 118 }],
    ['title filter mismatch', payload([row()]), { query: 'unrelated' }],
    ['unapplied Congress request', payload([row()]), { congress: 'invalid' }],
    ['spoofed CBO URL', payload([{ ...row(), cboUrl: 'https://www.cbo.gov.evil.test/publication/62540' }]), {}],
  ];

  it.each(unverifiedCases)('does not certify %s', (_label, legacy, request) => {
    const result = envelopeCboCostEstimatesResult(legacy, request);

    expect(result.outcome).toBe('partial');
    expect(result.sources[0]?.availability).toBe('unknown');
    expect(result.sources[0]?.coverage.completeness).toBe('unknown');
    expect(result.sources[0]?.coverage.returnedCount).toBeUndefined();
    expect(result.sources[0]?.provenance).toEqual([]);
    expect(result.errors).toEqual([{ code: 'cbo_cost_estimates_observation_unverified' }]);
  });

  it('does not let the observer change the returned object or thrown error', async () => {
    const legacy = payload([row()]);
    const successfulObserver = jest.fn();
    await expect(observeCboCostEstimatesCall(async () => legacy, {}, successfulObserver))
      .resolves.toBe(legacy);
    expect(successfulObserver).toHaveBeenCalledWith(expect.objectContaining({
      legacyPayload: legacy, outcome: 'succeeded',
    }));

    await expect(observeCboCostEstimatesCall(async () => legacy, {}, () => {
      throw new Error('observer failed');
    })).resolves.toBe(legacy);

    const failure = new Error('legacy read failed');
    const observer = jest.fn();
    await expect(observeCboCostEstimatesCall(async () => { throw failure; }, {}, observer))
      .rejects.toBe(failure);
    expect(observer).not.toHaveBeenCalled();
  });
});
