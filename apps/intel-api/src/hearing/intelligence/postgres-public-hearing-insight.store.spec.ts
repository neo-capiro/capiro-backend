import { PostgresPublicHearingInsightStore } from './postgres-public-hearing-insight.store.js';
import type { PublicHearingInsight } from './public-hearing-intelligence.types.js';

function insight(): PublicHearingInsight {
  return {
    id: 'phi-1',
    hearingId: 'hearing-1',
    captureId: 'capture-1',
    segmentId: 'segment-1',
    sequence: 1,
    startMs: 0,
    endMs: 5_000,
    insightType: 'COMMITMENT',
    title: 'Commitment detected',
    summary: 'The witness committed to provide a report.',
    evidenceText: 'We will provide the report.',
    speakerName: 'Witness One',
    confidence: 0.95,
    preliminary: false,
    entities: [],
    extractor: 'deterministic-public-facts',
    extractorVersion: '1',
    createdAt: '2026-08-21T00:00:00.000Z',
  };
}

function fixture(revision: number) {
  const query = jest.fn().mockResolvedValue([{ revision, isFinal: true }]);
  const execute = jest.fn().mockResolvedValue(1);
  const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
  const prisma = {
    withSystem: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    query,
    execute,
    store: new PostgresPublicHearingInsightStore(prisma as never),
  };
}

describe('PostgresPublicHearingInsightStore revision fence', () => {
  it('writes only while holding a lock on the exact claimed transcript revision', async () => {
    const { query, execute, store } = fixture(2);
    await expect(
      store.replaceSegmentInsightsIfCurrent({
        segmentId: 'segment-1',
        expectedRevision: 2,
        insights: [insight()],
      }),
    ).resolves.toBe(true);

    expect(String(query.mock.calls[0]?.[0])).toContain('FOR SHARE');
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM public_hearing_insight'))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO public_hearing_insight'))).toBe(true);
  });

  it('writes nothing when a newer transcript revision already exists', async () => {
    const { query, execute, store } = fixture(3);
    await expect(
      store.replaceSegmentInsightsIfCurrent({
        segmentId: 'segment-1',
        expectedRevision: 2,
        insights: [insight()],
      }),
    ).resolves.toBe(false);

    expect(String(query.mock.calls[0]?.[0])).toContain('FOR SHARE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a non-final segment even when its revision matches', async () => {
    const query = jest.fn().mockResolvedValue([{ revision: 2, isFinal: false }]);
    const execute = jest.fn();
    const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
    const prisma = {
      withSystem: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const store = new PostgresPublicHearingInsightStore(prisma as never);

    await expect(
      store.replaceSegmentInsightsIfCurrent({
        segmentId: 'segment-1',
        expectedRevision: 2,
        insights: [insight()],
      }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
