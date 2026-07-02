import { BillHearingLinkerService, canonicalizeBillRef } from '../src/linking/bill-hearing-linker.service.js';

describe('canonicalizeBillRef', () => {
  it('passes through an already-canonical id', () => {
    expect(canonicalizeBillRef('119-hr-1234', [], 119)).toBe('119-hr-1234');
  });
  it('resolves a display ref via the session billIds (recovers the congress)', () => {
    expect(canonicalizeBillRef('H.R. 1234', ['119-hr-1234', '118-s-5'], 117)).toBe('119-hr-1234');
  });
  it('falls back to the current congress when unmatched', () => {
    expect(canonicalizeBillRef('HR 900', [], 119)).toBe('119-hr-900');
  });
  it('handles senate + resolution tokens', () => {
    expect(canonicalizeBillRef('S. 5', [], 119)).toBe('119-s-5');
    expect(canonicalizeBillRef('H.J.Res. 10', [], 119)).toBe('119-hjres-10');
    expect(canonicalizeBillRef('H.Res. 7', [], 119)).toBe('119-hres-7');
  });
  it('returns null for non-bill refs', () => {
    expect(canonicalizeBillRef('the defense bill', [], 119)).toBeNull();
    expect(canonicalizeBillRef('', [], 119)).toBeNull();
    expect(canonicalizeBillRef('XYZ 5', [], 119)).toBeNull();
  });
});

interface MockOpts {
  locked?: boolean;
  session?: any;
  bills?: any[];
  mentions?: any[];
  segments?: any[];
  tracked?: Array<{ id: string; clientId: string; billId: string }>;
  billAlert?: any;
  hearingAlert?: any;
  existing?: { dedupeKey: string; id: string; status: string } | null;
}
function mockPrisma(opts: MockOpts) {
  const created: any[] = [];
  const updated: any[] = [];
  const trackedUpdates: any[] = [];
  const tx = {
    $queryRawUnsafe: async (sql: string) => {
      if (/pg_try_advisory_xact_lock/.test(sql)) return [{ locked: opts.locked ?? true }];
      if (/FROM congress_bill/.test(sql)) return opts.bills ?? [];
      return [];
    },
    liveHearingSession: { findUnique: async () => opts.session ?? null },
    entityMention: { findMany: async () => opts.mentions ?? [] },
    transcriptSegment: { findMany: async () => opts.segments ?? [] },
    trackedBill: {
      findMany: async ({ where }: any) =>
        (opts.tracked ?? []).filter((t) => (where.clientId ? t.clientId === where.clientId : true) && t.billId === where.billId),
      update: async ({ where, data }: any) => {
        trackedUpdates.push({ where, data });
        return {};
      },
    },
    intelAlert: {
      findFirst: async () => opts.billAlert ?? null,
      findUnique: async ({ where }: any) => {
        if (opts.existing && opts.existing.dedupeKey === where.dedupeKey) return opts.existing;
        if (opts.hearingAlert && typeof where.dedupeKey === 'string' && where.dedupeKey.startsWith('hearing:')) return opts.hearingAlert;
        return null;
      },
      create: async ({ data }: any) => {
        created.push(data);
        return { id: 'c' };
      },
      update: async ({ where, data }: any) => {
        updated.push({ where, data });
        return {};
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as any;
  return { prisma, created, updated, trackedUpdates };
}

describe('BillHearingLinkerService.linkSession', () => {
  const session = {
    clientId: 'cA',
    billIds: ['119-hr-1234'],
    title: 'HASC Markup',
    committeeId: 'hsas00',
    startedAt: null,
    endedAt: new Date('2026-06-24T16:00:00Z'),
  };
  const bills = [
    { id: '119-hr-1234', title: 'NDAA', latestActionText: 'Reported by Committee', latestActionDate: new Date('2026-06-20'), url: 'https://congress.gov/x' },
  ];

  it('skips when the advisory lock is not acquired', async () => {
    const { prisma, created } = mockPrisma({ locked: false });
    const r = await new BillHearingLinkerService(prisma).linkSession('t1', 's1');
    expect(r).toEqual({ combined: 0, skipped: true });
    expect(created).toHaveLength(0);
  });

  it('creates a combined alert for a curated+tracked bill and sets the hearing badge (not the watermark)', async () => {
    const { prisma, created, trackedUpdates } = mockPrisma({
      session,
      bills,
      tracked: [{ id: 'tb1', clientId: 'cA', billId: '119-hr-1234' }],
    });
    const r = await new BillHearingLinkerService(prisma).linkSession('t1', 's1');
    expect(r.combined).toBe(1);
    const a = created[0];
    expect(a.sourceType).toBe('combined');
    expect(a.dedupeKey).toBe('combined:cA:119-hr-1234:s1');
    expect(a.severity).toBe('notable');
    expect(a.evidence.bill.displayNum).toBe('H.R. 1234');
    expect(a.evidence.bill.stage).toBe('committee');
    expect(a.evidence.link.via).toBe('session.billIds');
    expect(trackedUpdates[0].data.lastHearingSessionId).toBe('s1');
    expect('lastSeenActionText' in trackedUpdates[0].data).toBe(false);
  });

  it('inherits severity/score from the bill alert and marks via=entity_mention', async () => {
    const { prisma, created } = mockPrisma({
      session,
      bills,
      mentions: [{ entityRef: 'H.R. 1234', segmentId: 'seg1' }],
      segments: [{ id: 'seg1', startMs: 5000, resolvedSpeakerName: 'Rep. Rogers', textPlain: 'public', issueTags: ['defense'] }],
      tracked: [{ id: 'tb1', clientId: 'cA', billId: '119-hr-1234' }],
      billAlert: { id: 'ba1', severity: 'critical', score: 0.8, clientImpact: 'unfavorable', urgency: 'high' },
      hearingAlert: { id: 'ha1', severity: 'info', score: 0.4 },
    });
    const r = await new BillHearingLinkerService(prisma).linkSession('t1', 's1');
    expect(r.combined).toBe(1);
    const a = created[0];
    expect(a.severity).toBe('critical');
    expect(a.materiality).toBe('high');
    expect(a.score).toBeCloseTo(0.85, 9);
    expect(a.clientImpact).toBe('unfavorable');
    expect(a.evidence.link.via).toBe('entity_mention');
    expect(a.evidence.link.billAlertId).toBe('ba1');
    expect(a.evidence.link.hearingAlertId).toBe('ha1');
    expect(a.evidence.hearing.mentions[0].quoteSource).toBe('textPlain');
  });

  it('does not alert for a non-tracked bill', async () => {
    const { prisma, created } = mockPrisma({ session, bills, tracked: [] });
    const r = await new BillHearingLinkerService(prisma).linkSession('t1', 's1');
    expect(r.combined).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('never resurrects a dismissed combined alert', async () => {
    const { prisma, created, updated } = mockPrisma({
      session,
      bills,
      tracked: [{ id: 'tb1', clientId: 'cA', billId: '119-hr-1234' }],
      existing: { dedupeKey: 'combined:cA:119-hr-1234:s1', id: 'e1', status: 'dismissed' },
    });
    const r = await new BillHearingLinkerService(prisma).linkSession('t1', 's1');
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(r.combined).toBe(0);
  });
});
