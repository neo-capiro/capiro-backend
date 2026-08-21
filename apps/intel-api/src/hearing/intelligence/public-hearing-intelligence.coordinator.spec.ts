import { PublicHearingIntelligenceCoordinator } from './public-hearing-intelligence.coordinator.js';
import { PublicHearingIntelligenceProcessor } from './public-hearing-intelligence.processor.js';
import { TenantHearingRelevanceProcessor } from './tenant-hearing-relevance.processor.js';

const context = {
  hearingId: 'h1',
  title: 'Defense posture',
  committeeName: 'Armed Services',
};
const segment = {
  id: 's1',
  captureId: 'c1',
  hearingId: 'h1',
  sequence: 1,
  startMs: 0,
  endMs: 5_000,
  text: 'We will deliver the H.R. 1 report within 30 days.',
  confidence: 0.9,
  isFinal: true,
};

describe('PublicHearingIntelligenceCoordinator', () => {
  it('persists public insights even when tenant relevance fails', async () => {
    const publicSink = { upsertMany: jest.fn(async () => undefined) };
    const tenantSink = {
      upsertMany: jest.fn(async () => {
        throw new Error('tenant store unavailable');
      }),
    };
    const failure = jest.fn();
    const coordinator = new PublicHearingIntelligenceCoordinator({
      publicProcessor: new PublicHearingIntelligenceProcessor({
        now: () => new Date('2026-08-21T12:00:00Z'),
      }),
      publicSink,
      tenantContextProvider: {
        contextsForHearing: async () => [
          {
            tenantId: 'tenant-a',
            clients: [
              {
                clientId: 'client-a',
                keywords: ['report'],
                billIds: ['HR-1'],
                programElementIds: [],
                agencies: [],
                committees: [],
              },
            ],
          },
        ],
      },
      tenantProcessor: new TenantHearingRelevanceProcessor(),
      tenantSink,
      onTenantFailure: failure,
    });

    const result = await coordinator.processFinalSegment({ segment, context });

    expect(publicSink.upsertMany).toHaveBeenCalledTimes(1);
    expect(result.publicPersisted).toBeGreaterThan(0);
    expect(result.tenantMatchesPersisted).toBe(0);
    expect(result.tenantFailures).toHaveLength(1);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it('requires the tenant relevance rail to be configured atomically', () => {
    expect(
      () =>
        new PublicHearingIntelligenceCoordinator({
          publicProcessor: new PublicHearingIntelligenceProcessor(),
          publicSink: { upsertMany: async () => undefined },
          tenantContextProvider: { contextsForHearing: async () => [] },
        }),
    ).toThrow(/requires a context provider, processor, and sink/i);
  });

  it('rejects interim transcript persistence', async () => {
    const coordinator = new PublicHearingIntelligenceCoordinator({
      publicProcessor: new PublicHearingIntelligenceProcessor(),
      publicSink: { upsertMany: async () => undefined },
    });
    await expect(
      coordinator.processFinalSegment({
        segment: { ...segment, isFinal: false },
        context,
      }),
    ).rejects.toThrow(/only final/i);
  });
});
