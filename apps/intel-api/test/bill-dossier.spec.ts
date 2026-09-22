import { BillDossierService } from '../src/bill-dossier/bill-dossier.service.js';
import type {
  SourceBillIdentity,
  SourceBillVote,
} from '../src/sourcedata/source-data.repository.js';

/**
 * Bill 360 dossier service behavior (§1.2): global vs client shape, client
 * validation + tenant/client scoping, and bounded reads. Uses the intel-api
 * house test pattern — direct `new Service(mockPrisma, ...)` with `withTenant`
 * shims and `as never` fakes.
 */

const BILL = '119-hr-1000';
const TENANT = 'tenant-1';
const CLIENT = '11111111-1111-1111-1111-111111111111';

const identity: SourceBillIdentity = {
  id: BILL,
  congress: 119,
  billType: 'hr',
  billNumber: '1000',
  title: 'A test measure',
  originChamber: 'House',
  sponsorName: 'Rep. Test',
  introducedDate: new Date('2026-01-10T00:00:00Z'),
  status: 'passed_chamber',
  statusAt: new Date('2026-05-01T00:00:00Z'),
  latestActionText: 'Passed the House.',
  latestActionDate: new Date('2026-05-01T00:00:00Z'),
  policyArea: 'Defense',
  url: 'https://congress.gov/bill/119/hr/1000',
  lastSyncedAt: new Date('2026-05-02T00:00:00Z'),
  updateDate: new Date('2026-05-01T12:00:00Z'),
  updateDateIncludingText: new Date('2026-05-01T12:00:00Z'),
};

const passageVote: SourceBillVote = {
  id: 'house-119-1-100',
  chamber: 'house',
  billId: BILL,
  question: 'On Passage',
  result: 'Passed',
  voteType: 'YEA-AND-NAY',
  voteDate: new Date('2026-05-01T18:00:00Z'),
  yeas: 230,
  nays: 200,
  present: 0,
  notVoting: 5,
  sourceUrl: 'https://clerk.house.gov/Votes/2026100',
};

function makeSource(overrides: Record<string, unknown> = {}) {
  const calls = { actionsLimit: undefined as number | undefined };
  const src = {
    getBillDossierIdentity: async (id: string) => (id === BILL ? identity : null),
    getBillActions: async (_id: string, limit?: number) => {
      calls.actionsLimit = limit;
      return [
        { id: 'a1', billId: BILL, date: new Date('2026-05-01T00:00:00Z'), text: 'Passed the House.', type: 'Floor', chamber: 'House' },
      ];
    },
    getBillVotes: async () => [passageVote],
    getGoverningRules: async () => [],
    getBillCommittees: async () => [],
    getBillFiscalNotes: async () => [],
    getBillSourceFreshness: async () => ({
      billId: BILL,
      lastSyncedAt: identity.lastSyncedAt,
      updateDate: identity.updateDate,
      updateDateIncludingText: identity.updateDateIncludingText,
      latestActionDate: identity.latestActionDate,
    }),
    getUpcomingHearingsForBills: async () => [],
    getBillMemberVoteSummary: async () => [],
    getClientProfile: async (_t: string, _c: string) => ({ name: 'Acme Defense', sectorTag: 'DEFENSE' }),
    ...overrides,
  };
  return { src, calls };
}

function makePrisma(
  tracked: Record<string, unknown> | null = null,
  alerts: unknown[] = [],
  opts: { combined?: unknown[]; match?: Record<string, unknown> | null } = {},
) {
  const calls: {
    trackedWhere?: Record<string, unknown>;
    alertArgs?: Record<string, unknown>;
    alertCalls: Array<Record<string, unknown>>;
    matchWhere?: Record<string, unknown>;
  } = { alertCalls: [] };
  const tx = {
    trackedBill: {
      findFirst: async (a: { where: Record<string, unknown> }) => {
        calls.trackedWhere = a.where;
        return tracked;
      },
    },
    intelAlert: {
      // Two distinct reads share this model: sourceType 'bill' (alerts) and
      // 'combined' (hearing mentions). Record every call so assertions can pick.
      findMany: async (a: Record<string, unknown>) => {
        calls.alertCalls.push(a);
        const where = (a['where'] ?? {}) as { sourceType?: string };
        if (where.sourceType === 'bill') calls.alertArgs = a;
        return where.sourceType === 'combined' ? (opts.combined ?? []) : alerts;
      },
    },
    billMatch: {
      findFirst: async (a: { where: Record<string, unknown> }) => {
        calls.matchWhere = a.where;
        return opts.match ?? null;
      },
    },
  };
  const prisma = {
    withTenant: async <T>(_t: string, fn: (t: typeof tx) => Promise<T>) => fn(tx),
    withSystem: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return { prisma, calls };
}

describe('BillDossierService.getGlobalDossier', () => {
  it('returns official/public data with no client context', async () => {
    const { src } = makeSource();
    const svc = new BillDossierService({} as never, src as never, {} as never);
    const d = await svc.getGlobalDossier(BILL);
    expect(d.context).toBeNull();
    expect(d.tracking).toBeNull();
    expect(d.alerts).toEqual([]);
    expect(d.bill.num).toBe('H.R. 1000');
    expect(d.bill.isState).toBe(false);
    expect(d.votes[0]?.result).toBe('Passed');
    expect(d.noVote).toBeNull(); // a passage vote exists
    expect(d.kpis).toHaveLength(6);
    expect(d.overview.officialNextStep).toMatchObject({
      origin: 'derived',
      source: 'Capiro status model',
    });
  });

  it('caps action reads at 50 (bounded)', async () => {
    const { src, calls } = makeSource();
    const svc = new BillDossierService({} as never, src as never, {} as never);
    await svc.getGlobalDossier(BILL);
    expect(calls.actionsLimit).toBe(50);
  });

  it('404s an unknown bill (no synthesized links)', async () => {
    const { src } = makeSource({ getBillDossierIdentity: async () => null });
    const svc = new BillDossierService({} as never, src as never, {} as never);
    await expect(svc.getGlobalDossier('119-hr-999999')).rejects.toThrow(/BILL_NOT_FOUND/);
  });

  it('keeps House passage distinct from a later Senate receipt and deduplicates display events', async () => {
    const receiptDate = new Date('2026-09-14T00:00:00Z');
    const passageDate = new Date('2026-07-22T20:00:00Z');
    const receiptIdentity: SourceBillIdentity = {
      ...identity,
      id: BILL,
      status: 'passed_chamber',
      // Simulates the pre-fix persisted value: latest receipt incorrectly won.
      statusAt: receiptDate,
      latestActionText: 'Received in the Senate.',
      latestActionDate: receiptDate,
    };
    const failedRecommit: SourceBillVote = {
      ...passageVote,
      id: 'house-119-2-277',
      question: 'On Motion to Recommit',
      result: 'Failed',
      voteDate: new Date('2026-07-22T20:30:00Z'),
      yeas: 213,
      nays: 216,
    };
    const actualPassage: SourceBillVote = {
      ...passageVote,
      id: 'house-119-2-278',
      voteDate: passageDate,
      yeas: 216,
      nays: 212,
    };
    const { src } = makeSource({
      getBillDossierIdentity: async () => receiptIdentity,
      getBillVotes: async () => [failedRecommit, actualPassage],
      getBillActions: async () => [
        {
          id: 'receipt',
          billId: BILL,
          date: receiptDate,
          text: 'Received in the Senate.',
          type: 'IntroReferral',
          chamber: 'Senate',
        },
        {
          id: 'recommit',
          billId: BILL,
          date: passageDate,
          text: 'On motion to recommit Failed by the Yeas and Nays: 213 - 216 (Roll no. 277).',
          type: 'Floor',
          chamber: 'House',
        },
        {
          id: 'passage-primary',
          billId: BILL,
          date: passageDate,
          text: 'On passage Passed by the Yeas and Nays: 216 - 212 (Roll no. 278).',
          type: 'Floor',
          chamber: 'House',
        },
        {
          id: 'passage-summary',
          billId: BILL,
          date: passageDate,
          // Congress.gov summary rows do not always repeat the roll number.
          text: 'Passed/agreed to in House: On passage Passed by the Yeas and Nays: 216 - 212.',
          type: 'Floor',
          chamber: 'House',
        },
      ],
    });

    const d = await new BillDossierService({} as never, src as never, {} as never).getGlobalDossier(
      BILL,
    );

    expect(d.bill.statusLabel).toBe('Passed House');
    expect(d.bill.statusAt).toBe(passageDate.toISOString());
    expect(d.latest).toEqual({ text: 'Received in the Senate.', date: receiptDate.toISOString() });

    const status = d.kpis.find((k) => k.id === 'current_status')!;
    const latestAction = d.kpis.find((k) => k.id === 'last_official_action')!;
    const latestVote = d.kpis.find((k) => k.id === 'latest_vote')!;
    const next = d.kpis.find((k) => k.id === 'next_milestone')!;
    expect(status).toMatchObject({ value: 'Passed House', asOf: passageDate.toISOString() });
    expect(latestAction).toMatchObject({
      label: 'Latest action',
      value: receiptDate.toISOString(),
      sub: 'Received in the Senate.',
    });
    expect(latestVote.value).toBe('Passed 216-212');
    expect(latestVote.sub).toBe('On Passage');
    expect(next).toMatchObject({
      label: 'Expected next step',
      value: 'Senate action',
      asOf: null,
      sub: 'Date not verified',
      unavailableReason: null,
    });

    const passageEvents = d.milestones.filter((m) => m.label === 'Passed House');
    expect(passageEvents).toHaveLength(1);
    expect(passageEvents[0]).toMatchObject({
      outcome: 'Passed',
      outcomeSev: 'success',
      sourceCount: 2,
      sourceIds: ['passage-primary', 'passage-summary'],
    });
    expect(d.milestones.find((m) => m.label === 'Received in Senate')).toMatchObject({
      detail: expect.stringContaining('Senate receipt'),
      outcome: null,
    });
    expect(d.milestones.find((m) => /recommit/i.test(m.label))).toMatchObject({
      state: 'failed',
      outcome: 'Failed',
      outcomeSev: 'critical',
    });
    expect(JSON.stringify(d.milestones)).not.toContain('IntroReferral');
  });

  it('uses an explicit passage action when a bill-linked vote has no question', async () => {
    const actionDate = new Date('2026-07-22T00:00:00Z');
    const { src } = makeSource({
      getBillDossierIdentity: async () => ({
        ...identity,
        statusAt: new Date('2026-09-14T00:00:00Z'),
        latestActionText: 'Received in the Senate.',
        latestActionDate: new Date('2026-09-14T00:00:00Z'),
      }),
      getBillVotes: async () => [{ ...passageVote, question: null, result: 'Passed' }],
      getBillActions: async () => [
        {
          id: 'receipt',
          billId: BILL,
          date: new Date('2026-09-14T00:00:00Z'),
          text: 'Received in the Senate.',
          type: 'IntroReferral',
          chamber: 'Senate',
        },
        {
          id: 'passage',
          billId: BILL,
          date: actionDate,
          text: 'Passed/agreed to in House: On passage Passed by recorded vote.',
          type: 'Floor',
          chamber: 'House',
        },
      ],
    });
    const d = await new BillDossierService({} as never, src as never, {} as never).getGlobalDossier(
      BILL,
    );
    expect(d.bill).toMatchObject({
      statusLabel: 'Passed House',
      statusAt: actionDate.toISOString(),
    });
    expect(d.votes[0]).toMatchObject({ target: 'procedural', label: 'House procedural vote' });
  });

  it('classifies negative vote language before success substrings', async () => {
    const voteDate = new Date('2026-06-01T18:00:00Z');
    const { src } = makeSource({
      getBillVotes: async () => [
        {
          ...passageVote,
          id: 'house-119-1-301',
          question: 'On Motion to Suspend the Rules and Pass',
          result: 'Not Agreed to',
          voteDate,
          yeas: 190,
          nays: 230,
        },
      ],
      getBillActions: async () => [
        {
          id: 'negative-passage',
          billId: BILL,
          date: voteDate,
          text: 'On motion to suspend the rules and pass Not Agreed to by the Yeas and Nays: 190 - 230 (Roll no. 301).',
          type: 'Floor',
          chamber: 'House',
        },
      ],
    });

    const d = await new BillDossierService({} as never, src as never, {} as never).getGlobalDossier(
      BILL,
    );
    expect(d.votes[0]).toMatchObject({ target: 'passage', resultSev: 'critical' });
    expect(d.milestones[0]).toMatchObject({
      outcome: 'Failed',
      outcomeSev: 'critical',
      state: 'failed',
    });
  });

  it('does not merge equal roll numbers from different chambers on the same day', async () => {
    const date = new Date('2026-06-01T00:00:00Z');
    const { src } = makeSource({
      getBillActions: async () => [
        {
          id: 'house-roll-50',
          billId: BILL,
          date,
          text: 'On motion to recommit Failed by recorded vote (Roll no. 50).',
          type: 'Floor',
          chamber: 'House',
        },
        {
          id: 'senate-roll-50',
          billId: BILL,
          date,
          text: 'On the motion to proceed Agreed to by recorded vote (Roll no. 50).',
          type: 'Floor',
          chamber: 'Senate',
        },
      ],
    });

    const d = await new BillDossierService({} as never, src as never, {} as never).getGlobalDossier(
      BILL,
    );
    expect(d.milestones.filter((m) => m.sourceIds?.includes('house-roll-50'))).toHaveLength(1);
    expect(d.milestones.filter((m) => m.sourceIds?.includes('senate-roll-50'))).toHaveLength(1);
    expect(d.milestones).toHaveLength(2);
  });
});

describe('BillDossierService.getClientDossier', () => {
  it('adds only that tenant/client context and validates the client first', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(null, []);
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.context).toEqual({ contextType: 'client', externalRef: CLIENT, name: 'Acme Defense' });
    expect(d.tracking?.tracked).toBe(false);
  });

  it('404s a client that is not in the tenant', async () => {
    const { src } = makeSource({ getClientProfile: async () => null });
    const { prisma } = makePrisma();
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    await expect(svc.getClientDossier(TENANT, CLIENT, BILL)).rejects.toThrow(/CLIENT_NOT_FOUND/);
  });

  it('404s a malformed client id before any DB read', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma();
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    await expect(svc.getClientDossier(TENANT, 'not-a-uuid', BILL)).rejects.toThrow(/CLIENT_NOT_FOUND/);
  });

  it('scopes alert reads by tenant + client + bill and bounds them to 50', async () => {
    const { src } = makeSource();
    const { prisma, calls } = makePrisma(null, []);
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(calls.alertArgs?.where).toEqual({
      tenantId: TENANT,
      clientId: CLIENT,
      sourceType: 'bill',
      sourceRef: BILL,
    });
    expect(calls.alertArgs?.take).toBe(50);
    expect(calls.trackedWhere).toEqual({ tenantId: TENANT, clientId: CLIENT, billId: BILL });
  });

  it('surfaces analyst note as origin=analyst and falls back to the legacy note', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(
      { note: 'legacy note', analystNote: null, position: 'support', priority: 'high', trackedAt: new Date('2026-05-03T00:00:00Z') },
      [],
    );
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.tracking?.tracked).toBe(true);
    expect(d.tracking?.position).toBe('support');
    expect(d.tracking?.analystNote).toBe('legacy note');
    expect(d.overview.whyItMatters?.origin).toBe('analyst');
    expect(d.overview.whyItMatters?.text).toBe('legacy note');
  });

  it('never lets an analyst outlook change the canonical status', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(
      { analystNote: 'we think this dies in committee', expectedRationale: 'no floor time', trackedAt: new Date() },
      [],
    );
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.bill.stage).toBe('passed_chamber'); // canonical, unchanged
    expect(d.overview.analystOutlook?.origin).toBe('analyst');
  });
});

describe('BillDossierService client context — matched topics, recommended actions, hearings', () => {
  it('returns the client’s matched watchlist topics with the match fit', async () => {
    const { src } = makeSource();
    const { prisma, calls } = makePrisma(null, [], {
      match: {
        matchedTags: ['Shipbuilding', 'Munitions', '  ', ''],
        fit: 0.82,
        jurisdiction: 'US',
        lastFitAt: new Date('2026-05-04T00:00:00Z'),
      },
    });
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    // Blank tags are dropped; every row carries the match fit + timestamp.
    expect(d.matchedTopics.map((t) => t.label)).toEqual(['Shipbuilding', 'Munitions']);
    expect(d.matchedTopics[0]?.fit).toBe(0.82);
    expect(d.matchedTopics[0]?.matchedAt).toBe('2026-05-04T00:00:00.000Z');
    // Tenant-scoped read (intel-api has no RLS).
    expect(calls.matchWhere).toEqual({ tenantId: TENANT, clientId: CLIENT, billId: BILL });
  });

  it('returns [] matched topics when the bill was tracked manually (never matched)', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(null, [], { match: null });
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.matchedTopics).toEqual([]);
  });

  it('takes recommended actions verbatim from alert rows, deduped, never synthesized', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(null, [
      { id: 'al1', severity: 'critical', createdAt: new Date('2026-05-05T00:00:00Z'), title: 'Markup scheduled', whyItMatters: null, recommendedAction: 'Brief the client before markup.' },
      { id: 'al2', severity: 'notable', createdAt: new Date('2026-05-04T00:00:00Z'), title: 'Amendment filed', whyItMatters: null, recommendedAction: 'brief the client before markup.' },
      { id: 'al3', severity: 'info', createdAt: new Date('2026-05-03T00:00:00Z'), title: 'Cosponsor added', whyItMatters: null, recommendedAction: '   ' },
    ]);
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.recommendedActions).toHaveLength(1); // case-insensitive dedup; blank dropped
    expect(d.recommendedActions[0]).toEqual({
      text: 'Brief the client before markup.',
      origin: 'derived',
      sev: 'critical',
      date: '2026-05-05T00:00:00.000Z',
      alertId: 'al1',
    });
  });

  it('returns [] recommended actions when no alert recorded one (no fabrication)', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(null, [
      { id: 'al1', severity: 'info', createdAt: new Date(), title: 'Action', whyItMatters: null, recommendedAction: null },
    ]);
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.recommendedActions).toEqual([]);
  });

  it('falls back to the alert why-it-matters as origin=derived when there is no analyst note', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(null, [
      { id: 'al1', severity: 'notable', createdAt: new Date('2026-05-05T00:00:00Z'), title: 'Markup', whyItMatters: 'Touches the client’s shipbuilding line.', recommendedAction: null },
    ]);
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.overview.whyItMatters?.origin).toBe('derived');
    expect(d.overview.whyItMatters?.text).toMatch(/shipbuilding line/);
  });

  it('lets an analyst note override the derived why-it-matters', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(
      { analystNote: 'Analyst view wins.', trackedAt: new Date('2026-05-06T00:00:00Z') },
      [{ id: 'al1', severity: 'info', createdAt: new Date('2026-05-05T00:00:00Z'), title: 'Markup', whyItMatters: 'derived text', recommendedAction: null }],
    );
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(d.overview.whyItMatters?.origin).toBe('analyst');
    expect(d.overview.whyItMatters?.text).toBe('Analyst view wins.');
  });

  it('returns client hearing mentions from combined alerts, bounded to 10 per session', async () => {
    const { src } = makeSource();
    const mentions = Array.from({ length: 14 }, (_, i) => ({
      segmentId: `s${i}`,
      timestampMs: 3_723_000 + i,
      speakerName: `Speaker ${i}`,
      quote: `quote ${i}`,
      issueTags: [],
    }));
    const { prisma, calls } = makePrisma(null, [], {
      combined: [
        {
          sourceRef: BILL,
          createdAt: new Date('2026-05-05T00:00:00Z'),
          evidence: {
            hearing: {
              sessionId: 'sess-1',
              title: 'SASC posture hearing',
              committeeId: 'ssas00',
              occurredAt: '2026-05-01T14:00:00.000Z',
              mentions,
            },
          },
        },
      ],
    });
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    const sess = d.hearings.find((h) => h.id === 'sess-1');
    expect(sess?.title).toBe('SASC posture hearing');
    expect(sess?.mentions).toHaveLength(10); // capped
    expect(sess?.mentions[0]?.ts).toBe('1:02:03'); // 3,723,000 ms
    expect(sess?.mentions[0]?.quote).toBe('quote 0');
    // Session reads are bounded and exclude dismissed/snoozed/suppressed links.
    const combinedCall = calls.alertCalls.find(
      (c) => (c['where'] as { sourceType?: string }).sourceType === 'combined',
    );
    expect(combinedCall?.['take']).toBe(20);
    expect((combinedCall?.['where'] as Record<string, unknown>)['status']).toEqual({
      notIn: ['dismissed', 'snoozed', 'suppressed'],
    });
  });

  it('never leaks an encrypted transcript quote (linker already stored null)', async () => {
    const { src } = makeSource();
    const { prisma } = makePrisma(null, [], {
      combined: [
        {
          sourceRef: BILL,
          createdAt: new Date('2026-05-05T00:00:00Z'),
          evidence: {
            hearing: {
              sessionId: 'sess-2',
              title: 'Closed session',
              committeeId: null,
              occurredAt: null,
              mentions: [
                { segmentId: 'x', timestampMs: null, speakerName: 'Chair', quote: null, quoteSource: 'encrypted', issueTags: [] },
              ],
            },
          },
        },
      ],
    });
    const svc = new BillDossierService(prisma as never, src as never, {} as never);
    const d = await svc.getClientDossier(TENANT, CLIENT, BILL);
    const sess = d.hearings.find((h) => h.id === 'sess-2');
    expect(sess?.mentions[0]?.quote).toBeNull();
    expect(sess?.mentions[0]?.ts).toBeNull();
  });

  it('the global route returns no matched topics or recommended actions', async () => {
    const { src } = makeSource();
    const svc = new BillDossierService({} as never, src as never, {} as never);
    const d = await svc.getGlobalDossier(BILL);
    expect(d.matchedTopics).toEqual([]);
    expect(d.recommendedActions).toEqual([]);
  });
});
