import {
  BillHearingsService,
  mapCombinedAlertsToHearings,
} from '../src/linking/bill-hearings.service.js';

/**
 * Phase 9 — Bill→Hearing interlink read (GET .../bills/:billId/hearings).
 * Pure-unit: the mapper is a pure export; the service is exercised with a mocked
 * PrismaService (no DB) to assert the tenant/client/source scoping.
 */
describe('mapCombinedAlertsToHearings', () => {
  const alert = (sessionId: string, extra?: Record<string, unknown>) => ({
    sourceRef: '119-hr-1234',
    createdAt: new Date('2026-06-24T16:00:00Z'),
    evidence: {
      hearing: {
        sessionId,
        title: 'HASC Markup',
        committeeId: 'hsas00',
        occurredAt: '2026-06-24T16:00:00.000Z',
        mentions: [
          {
            segmentId: 'seg1',
            timestampMs: 5000,
            speakerName: 'Rep. Rogers',
            quote: 'public quote',
            quoteSource: 'textPlain',
            issueTags: ['defense'],
          },
        ],
        ...extra,
      },
    },
  });

  it('maps a combined alert into a hearing with its mentions', () => {
    const r = mapCombinedAlertsToHearings([alert('s1')]);
    expect(r.count).toBe(1);
    expect(r.hearings[0]).toEqual({
      sessionId: 's1',
      title: 'HASC Markup',
      occurredAt: '2026-06-24T16:00:00.000Z',
      committeeId: 'hsas00',
      mentions: [
        {
          segmentId: 'seg1',
          timestampMs: 5000,
          speakerName: 'Rep. Rogers',
          quote: 'public quote',
          quoteSource: 'textPlain',
          issueTags: ['defense'],
        },
      ],
    });
  });

  it('dedups by sessionId (first/newest row wins)', () => {
    const r = mapCombinedAlertsToHearings([
      alert('s1', { title: 'newest' }),
      alert('s1', { title: 'older' }),
      alert('s2'),
    ]);
    expect(r.count).toBe(2);
    expect(r.hearings.map((h) => h.sessionId)).toEqual(['s1', 's2']);
    expect(r.hearings[0]!.title).toBe('newest');
  });

  it('tolerates missing hearing evidence / mentions', () => {
    expect(mapCombinedAlertsToHearings([{ sourceRef: 'b', createdAt: new Date(), evidence: {} }])).toEqual({
      count: 0,
      hearings: [],
    });
    const r = mapCombinedAlertsToHearings([
      { sourceRef: 'b', createdAt: new Date(), evidence: { hearing: { sessionId: 's1' } } },
    ]);
    expect(r.count).toBe(1);
    expect(r.hearings[0]).toEqual({
      sessionId: 's1',
      title: null,
      occurredAt: null,
      committeeId: null,
      mentions: [],
    });
  });

  it('leaves an encrypted (null) quote as null — never fabricates text', () => {
    const r = mapCombinedAlertsToHearings([
      alert('s1', {
        mentions: [{ segmentId: 'seg9', timestampMs: 1, speakerName: null, quote: null, quoteSource: 'encrypted', issueTags: [] }],
      }),
    ]);
    expect(r.hearings[0]!.mentions[0]!.quote).toBeNull();
    expect(r.hearings[0]!.mentions[0]!.quoteSource).toBe('encrypted');
  });
});

describe('BillHearingsService.getBillHearings', () => {
  it('scopes the query by tenantId + clientId + combined/sourceRef (no RLS) and excludes dismissed', async () => {
    let calledWith: any = null;
    const prisma = {
      intelAlert: {
        findMany: async (args: any) => {
          calledWith = args;
          return [
            {
              sourceRef: '119-hr-1234',
              createdAt: new Date('2026-06-24T16:00:00Z'),
              evidence: { hearing: { sessionId: 's1', title: 'H', committeeId: null, occurredAt: null, mentions: [] } },
            },
          ];
        },
      },
    } as any;
    const svc = new BillHearingsService(prisma);
    const r = await svc.getBillHearings('t1', 'c1', '119-hr-1234');
    expect(r.count).toBe(1);
    expect(calledWith.where.tenantId).toBe('t1');
    expect(calledWith.where.clientId).toBe('c1');
    expect(calledWith.where.sourceType).toBe('combined');
    expect(calledWith.where.sourceRef).toBe('119-hr-1234');
    expect(calledWith.where.status).toEqual({ notIn: ['dismissed', 'snoozed', 'suppressed'] });
    expect(calledWith.orderBy).toEqual({ createdAt: 'desc' });
  });
});
