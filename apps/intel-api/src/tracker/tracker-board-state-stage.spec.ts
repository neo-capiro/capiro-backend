import { TrackerBoardService } from './tracker-board.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import type { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';
import type { TrackerWatchlistService } from './tracker-watchlist.service.js';

/**
 * The state rail's stage/outcome mapping (defect
 * TASK/recommendation-state-stage-defect.json, 2026-09-15).
 *
 * Pre-fix, `stateStatusToBoardStage` mapped by `stateBillStatusRank` alone, so
 * EVERY rank-9 terminal (failed / vetoed / dead_by_deadline / veto_overridden /
 * enacted) collapsed to the 'enacted' lane, and rank-3 'floor' collapsed to
 * 'passed'. Two real retained provider bills (FL H0547 / S0032, both canonical
 * status 'failed', latest action "Died …", 2026-03-13) were therefore labelled
 * 'enacted' in recommendations and persisted as 'enacted' on track.
 *
 * These tests drive the REAL public methods (trackBill / getBoard /
 * getRecommendations) with source-shaped state_bill rows, so a regression in the
 * mapping fails here rather than only in production.
 */

// The recommendation path's semantic pass calls Bedrock. Force the
// embeddings-unavailable branch so the state candidate pass is exercised
// keyword-only, exactly as the captured defect probe ran (no provider call).
jest.mock('../embeddings/embedder.js', () => ({
  EMBEDDING_MODEL: 'test',
  EMBED_CANDIDATE_FLOOR: 0.3,
  embedText: jest.fn().mockRejectedValue(new Error('no bedrock in unit test')),
  normalize: (s: string) => s,
  vectorLiteral: (v: unknown) => JSON.stringify(v),
}));

interface StateBillRow {
  id: string;
  state: string;
  sessionKey: string;
  session: string | null;
  identifier: string;
  title: string | null;
  status: string | null;
  statusAt: Date | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  textDate: Date | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  sponsorCount: number | null;
  stateUrl: string | null;
  url: string | null;
  subjects: string[] | null;
  committees: string[] | null;
}

function stateBill(
  partial: Partial<StateBillRow> & { id: string; status: string | null },
): StateBillRow {
  return {
    state: partial.id.slice(0, 2).toUpperCase(),
    sessionKey: '2026',
    session: '2026 Regular Session',
    identifier: 'H0547',
    title: 'Injunctions for Protection',
    statusAt: null,
    latestActionText: null,
    latestActionDate: null,
    textDate: null,
    sponsorName: 'Anne Gerwig',
    sponsorParty: 'R',
    sponsorCount: null,
    stateUrl: null,
    url: null,
    subjects: null,
    committees: null,
    ...partial,
  };
}

interface TrackedRow {
  id: string;
  tenantId: string;
  clientId: string;
  billId: string;
  source: string;
  stage: string | null;
  note: string | null;
  isManual: boolean;
  unread: boolean;
  trackedAt: Date;
  lastSeenActionText: string | null;
  lastSeenActionDate: Date | null;
  lastHearingSessionId: string | null;
  lastHearingAt: Date | null;
  trackedBy: string | null;
}

function makeHarness(opts: {
  stateBills?: StateBillRow[];
  tracked?: TrackedRow[];
  alerts?: Array<Record<string, unknown>>;
  watchlist?: {
    issueAreas: string[];
    jurisdictions: string[];
    topics: Array<{
      id: string;
      label: string;
      issueArea: string | null;
      priority: string;
      position?: string;
    }>;
    /** Flat (topicId-less) or topic terms — compiled into the matching topic. */
    billMatchSet: Array<{
      id?: string | null;
      label: string;
      issueArea: string | null;
      priority: string;
      position?: string;
      keywords: string[];
      synonyms: string[];
      entities: string[];
      riskPhrases: string[];
      routableTerms?: Array<{
        id: string | null;
        topicId: string | null;
        topicLabel: string;
        termType: string;
        value: string;
        topicPriority: string;
      }>;
    }>;
  };
}) {
  const stateBills = opts.stateBills ?? [];
  const tracked = (opts.tracked ?? []).map((r) => ({ ...r }));
  const alerts = opts.alerts ?? [];
  const upserts: Array<{ create: Record<string, unknown> }> = [];

  // Generic Prisma `where` evaluator over the fake tracked rows — supports the
  // shapes getBoard/getTenantBoard actually use (AND/OR, `in`/`notIn`/`not`,
  // equality), so the corrected-stage filter/count path is exercised faithfully.
  const matchesWhere = (row: TrackedRow, where: unknown): boolean => {
    if (!where || typeof where !== 'object') return true;
    const w = where as Record<string, unknown>;
    for (const [key, cond] of Object.entries(w)) {
      if (cond === undefined) continue;
      if (key === 'AND') {
        const arr = Array.isArray(cond) ? cond : [cond];
        if (!arr.every((c) => matchesWhere(row, c))) return false;
        continue;
      }
      if (key === 'OR') {
        const arr = Array.isArray(cond) ? cond : [cond];
        if (!arr.some((c) => matchesWhere(row, c))) return false;
        continue;
      }
      const value = (row as unknown as Record<string, unknown>)[key];
      if (cond && typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        if ('in' in c && !(c['in'] as unknown[]).includes(value)) return false;
        if ('notIn' in c && (c['notIn'] as unknown[]).includes(value)) return false;
        if ('not' in c && value === c['not']) return false;
        continue;
      }
      if (value !== cond) return false;
    }
    return true;
  };

  const tx = {
    trackedBill: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where?: unknown } = {}) =>
          Promise.resolve(tracked.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r }))),
        ),
      count: jest
        .fn()
        .mockImplementation(({ where }: { where?: unknown } = {}) =>
          Promise.resolve(tracked.filter((r) => matchesWhere(r, where)).length),
        ),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) => {
        upserts.push({ create });
        return Promise.resolve({ id: 'tb-1', ...create });
      }),
    },
    intelAlert: {
      findMany: jest.fn().mockResolvedValue(alerts),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    intelFeedback: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'fb-1' }),
    },
    watchlist: {
      findFirst: jest.fn().mockResolvedValue(
        opts.watchlist
          ? {
              issueAreas: opts.watchlist.issueAreas,
              _count: { topics: opts.watchlist.topics.length },
            }
          : null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    watchlistTopic: { findMany: jest.fn().mockResolvedValue([]) },
    watchlistTerm: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const withTenant = jest.fn((_t: string, fn: (t: unknown) => unknown) => fn(tx));
  const prisma = { withTenant, withSystem: jest.fn() } as unknown as PrismaService;

  const stateRepo = {
    getStateBillsByIds: jest.fn().mockResolvedValue(stateBills),
    getStateBillById: jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(stateBills.find((b) => b.id === key) ?? null),
      ),
    stateKeywordCandidateIds: jest.fn().mockResolvedValue(stateBills.map((b) => b.id)),
  } as unknown as StateSourceDataRepository;

  const repo = {
    fetchRecommendationBills: jest.fn().mockResolvedValue([]),
    keywordCandidateIds: jest.fn().mockResolvedValue([]),
    semanticBillScores: jest.fn().mockResolvedValue([]),
    getClientNames: jest.fn().mockResolvedValue(new Map()),
  } as unknown as SourceDataRepository;

  const watchlists = {
    assertClientInTenant: jest.fn().mockResolvedValue(undefined),
    getCompiled: jest
      .fn()
      .mockResolvedValue(
        opts.watchlist ?? { issueAreas: [], jurisdictions: [], topics: [], billMatchSet: [] },
      ),
  } as unknown as TrackerWatchlistService;

  const svc = new TrackerBoardService(prisma, repo, watchlists, stateRepo);
  return { svc, tx, upserts, stateRepo, watchlists };
}

const TENANT = 'ten-1';
const CLIENT = 'cli-1';
const USER = 'user-1';

/** The two real retained provider bills behind the defect. */
const H0547 = stateBill({
  id: 'fl-2026-h0547',
  status: 'failed',
  identifier: 'H0547',
  latestActionText: 'Died in Civil Justice & Claims Subcommittee',
  latestActionDate: new Date('2026-03-13T00:00:00.000Z'),
  stateUrl: 'https://www.flsenate.gov/Session/Bill/2026/547',
  url: 'https://legiscan.com/FL/bill/H0547/2026',
});
const S0032 = stateBill({
  id: 'fl-2026-s0032',
  status: 'failed',
  identifier: 'S0032',
  latestActionText: 'Died in Messages',
  latestActionDate: new Date('2026-03-13T00:00:00.000Z'),
  stateUrl: 'https://www.flsenate.gov/Session/Bill/2026/32',
  url: 'https://legiscan.com/FL/bill/S0032/2026',
});

describe('state stage/outcome mapping — track path (trackStateStage → persisted stage)', () => {
  const cases: Array<[string | null, string]> = [
    ['introduced', 'introduced'],
    ['committee', 'committee'],
    ['reported', 'committee'],
    // floor is a POSITIVE pre-passage status: never asserted as passage.
    ['floor', 'committee'],
    ['passed_chamber', 'passed'],
    ['resolving', 'passed'],
    ['to_governor', 'passed'],
    // only the two POSITIVE terminals are enacted.
    ['enacted', 'enacted'],
    ['veto_overridden', 'enacted'],
    // a veto requires the legislature to have passed — but not enactment.
    ['vetoed', 'passed'],
    // negative outcomes claim NO reached stage (no history proof available).
    ['failed', 'introduced'],
    ['dead_by_deadline', 'introduced'],
    [null, 'introduced'],
  ];

  it.each(cases)('status %s persists stage %s', async (status, expected) => {
    const bill = stateBill({ id: 'fl-2026-h0001', status });
    const { svc, upserts } = makeHarness({ stateBills: [bill] });
    await svc.trackBill(TENANT, CLIENT, USER, bill.id);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.create['stage']).toBe(expected);
  });

  it('persists a real FAILED bill as not-enacted (H0547/S0032 regression)', async () => {
    for (const bill of [H0547, S0032]) {
      const { svc, upserts } = makeHarness({ stateBills: [bill] });
      await svc.trackBill(TENANT, CLIENT, USER, bill.id);
      expect(upserts[0]!.create['stage']).not.toBe('enacted');
      expect(upserts[0]!.create['stage']).not.toBe('passed');
      expect(upserts[0]!.create['lastSeenActionText']).toBe(bill.latestActionText);
    }
  });
});

describe('state stage/outcome mapping — board card (getBoard)', () => {
  function trackedRow(billId: string, stage: string): TrackedRow {
    return {
      id: `tb-${billId}`,
      tenantId: TENANT,
      clientId: CLIENT,
      billId,
      source: 'state',
      stage,
      note: null,
      isManual: false,
      unread: false,
      trackedAt: new Date('2026-09-15T00:00:00.000Z'),
      lastSeenActionText: null,
      lastSeenActionDate: null,
      lastHearingSessionId: null,
      lastHearingAt: null,
      trackedBy: USER,
    };
  }

  it('corrects an EXISTING row already persisted as enacted (failed bill, no chip)', async () => {
    // Pre-fix rows were stored with stage='enacted' for a failed bill. The
    // read-time canonical derivation must place them correctly WITHOUT any
    // destructive backfill.
    const { svc } = makeHarness({
      stateBills: [H0547, S0032],
      tracked: [trackedRow(H0547.id, 'enacted'), trackedRow(S0032.id, 'enacted')],
      alerts: [],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT);
    const enacted = columns.find((c) => c.id === 'enacted')!;
    expect(enacted.cards).toHaveLength(0);
    for (const card of columns.flatMap((c) => c.cards)) {
      expect(card.stage).toBe('introduced');
      expect(card.canonicalStatus).toBe('Failed');
      expect(card.terminalRisk).toBe(true);
    }
  });

  it('activeOnly drops an EXISTING row persisted as enacted whose canonical status is failed', async () => {
    // The persisted-stage proxy alone would have kept this row (stage='enacted',
    // but activeOnly excludes stage='enacted'... ) — and a persisted non-enacted
    // wrong-row would have been kept. Both must follow the CORRECTED stage.
    const { svc } = makeHarness({
      stateBills: [H0547],
      tracked: [trackedRow(H0547.id, 'introduced')], // already-corrected persisted stage
      alerts: [],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT, { filters: { activeOnly: true } });
    expect(columns.flatMap((c) => c.cards)).toHaveLength(0);
  });

  it('activeOnly keeps a live state bill whose persisted stage is wrong', async () => {
    // A live bill persisted in a not-enacted lane but whose canonical status is
    // a positive pre-passage stage: the corrected stage decides, and it stays.
    const live = stateBill({ id: 'fl-2026-h0910', status: 'passed_chamber', identifier: 'H0910' });
    const { svc } = makeHarness({
      stateBills: [live],
      tracked: [trackedRow(live.id, 'committee')],
      alerts: [],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT, { filters: { activeOnly: true } });
    const card = columns.flatMap((c) => c.cards)[0]!;
    expect(card.billId).toBe(live.id);
    expect(card.stage).toBe('passed'); // corrected from canonical, not persisted 'committee'
  });

  it('failed state bill is not in the enacted lane and carries the real canonical status', async () => {
    const { svc } = makeHarness({
      stateBills: [H0547, S0032],
      tracked: [trackedRow(H0547.id, 'introduced'), trackedRow(S0032.id, 'introduced')],
      // No change chip: terminal truth must NOT depend on a recent alert.
      alerts: [],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT);
    const enacted = columns.find((c) => c.id === 'enacted')!;
    expect(enacted.cards.map((c) => c.billId)).toHaveLength(0);
    for (const card of columns.flatMap((c) => c.cards)) {
      expect(card.canonicalStatus).toBe('Failed');
      // terminalRisk derives from the canonical OUTCOME even without a chip.
      expect(card.terminalRisk).toBe(true);
    }
  });

  it('activeOnly excludes enacted AND terminal-negative bills (preserved exclusion, label-independent)', async () => {
    const enactedBill = stateBill({ id: 'fl-2026-h0900', status: 'enacted', identifier: 'H0900' });
    const vetoed = stateBill({ id: 'fl-2026-h0901', status: 'vetoed', identifier: 'H0901' });
    const live = stateBill({ id: 'fl-2026-h0902', status: 'committee', identifier: 'H0902' });
    const { svc } = makeHarness({
      stateBills: [enactedBill, vetoed, live, H0547],
      tracked: [
        trackedRow(enactedBill.id, 'enacted'),
        trackedRow(vetoed.id, 'passed'), // vetoed: passed lane post-fix
        trackedRow(live.id, 'committee'),
        trackedRow(H0547.id, 'introduced'), // failed: no longer in the enacted lane
      ],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT, { filters: { activeOnly: true } });
    const ids = columns.flatMap((c) => c.cards).map((c) => c.billId);
    // The standard activeOnly terminal exclusion must stay true independent of
    // the (no longer) wrong Enacted label.
    expect(ids).not.toContain(enactedBill.id);
    expect(ids).not.toContain(H0547.id);
    expect(ids).not.toContain(vetoed.id);
    // A live (non-terminal) bill stays.
    expect(ids).toContain(live.id);
  });

  it('without activeOnly a failed bill stays on the board with its truthful card', async () => {
    const { svc } = makeHarness({
      stateBills: [H0547],
      tracked: [trackedRow(H0547.id, 'introduced')],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT);
    const card = columns.flatMap((c) => c.cards).find((c) => c.billId === H0547.id)!;
    expect(card).toBeDefined();
    expect(card.canonicalStatus).toBe('Failed');
    expect(card.terminalRisk).toBe(true);
  });

  it('a vetoed state bill sits in the passed lane with the Vetoed label', async () => {
    const vetoed = stateBill({ id: 'fl-2026-h0700', status: 'vetoed', identifier: 'H0700' });
    const { svc } = makeHarness({
      stateBills: [vetoed],
      tracked: [trackedRow(vetoed.id, 'passed')],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT);
    const passed = columns.find((c) => c.id === 'passed')!;
    expect(passed.cards.map((c) => c.billId)).toEqual([vetoed.id]);
    expect(passed.cards[0]!.canonicalStatus).toBe('Vetoed');
    expect(passed.cards[0]!.terminalRisk).toBe(true);
  });

  it('an enacted state bill is NOT flagged terminalRisk (success, not risk)', async () => {
    const enactedBill = stateBill({ id: 'fl-2026-h0800', status: 'enacted', identifier: 'H0800' });
    const { svc } = makeHarness({
      stateBills: [enactedBill],
      tracked: [trackedRow(enactedBill.id, 'enacted')],
    });
    const { columns } = await svc.getBoard(TENANT, CLIENT);
    const card = columns.flatMap((c) => c.cards)[0]!;
    expect(card.stage).toBe('enacted');
    expect(card.canonicalStatus).toBe('Enacted');
    expect(card.terminalRisk).toBe(false);
  });
});

describe('state stage filter — UNKNOWN state id (no canonical row) keeps persisted-stage filter', () => {
  function trackedRow(billId: string, stage: string): TrackedRow {
    return {
      id: `tb-${billId}`,
      tenantId: TENANT,
      clientId: CLIENT,
      billId,
      source: 'state',
      stage,
      note: null,
      isManual: false,
      unread: false,
      trackedAt: new Date('2026-09-15T00:00:00.000Z'),
      lastSeenActionText: null,
      lastSeenActionDate: null,
      lastHearingSessionId: null,
      lastHearingAt: null,
      trackedBy: USER,
    };
  }

  it('activeOnly drops an unknown state row persisted as enacted (federal-parity)', async () => {
    // No state_bill row exists for this id — the canonical stage cannot be
    // re-derived, so the persisted-stage filter applies exactly like federal.
    const { svc } = makeHarness({
      stateBills: [],
      tracked: [trackedRow('zz-2026-x9999', 'enacted')],
    });
    const page = await svc.getBoard(TENANT, CLIENT, { filters: { activeOnly: true } });
    expect(page.total).toBe(0);
    expect(page.columns.flatMap((c) => c.cards)).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it('stages=[committee] excludes an unknown state row persisted as enacted', async () => {
    const { svc } = makeHarness({
      stateBills: [],
      tracked: [trackedRow('zz-2026-x9999', 'enacted')],
    });
    const page = await svc.getBoard(TENANT, CLIENT, { filters: { stages: ['committee'] } });
    expect(page.total).toBe(0);
    expect(page.columns.flatMap((c) => c.cards)).toHaveLength(0);
  });

  it('stages=[enacted] keeps an unknown state row persisted as enacted (filter agrees with display)', async () => {
    const { svc } = makeHarness({
      stateBills: [],
      tracked: [trackedRow('zz-2026-x9999', 'enacted')],
    });
    const page = await svc.getBoard(TENANT, CLIENT, { filters: { stages: ['enacted'] } });
    expect(page.total).toBe(1);
    const card = page.columns.flatMap((c) => c.cards)[0]!;
    expect(card.billId).toBe('zz-2026-x9999');
    // Display falls back to the persisted stage — filter and display agree.
    expect(card.stage).toBe('enacted');
    expect(page.nextCursor).toBeNull();
  });

  it('known failed row with stale persisted=enacted is excluded from enacted filter (alongside)', async () => {
    // Known canonical state rows bypass the persisted filter and use the
    // corrected stage — the two policies coexist in one result set.
    const { svc } = makeHarness({
      stateBills: [H0547],
      tracked: [
        trackedRow(H0547.id, 'enacted'), // stale persisted stage, canonical 'failed'
        trackedRow('zz-2026-x9999', 'enacted'), // unknown id: persisted filter applies
      ],
    });
    const page = await svc.getBoard(TENANT, CLIENT, { filters: { stages: ['enacted'] } });
    const ids = page.columns.flatMap((c) => c.cards).map((c) => c.billId);
    expect(ids).not.toContain(H0547.id); // corrected stage is 'introduced'
    expect(ids).toContain('zz-2026-x9999'); // persisted stage still governs
    expect(page.total).toBe(1);
  });
});

describe('state stage/outcome mapping — recommendations', () => {
  const watchlist = {
    // The captured defect recommendation matched the issue area as well as the
    // topic (fit 0.45 = 0.30 textMatch + 0.10 subjectMatch + 0.05 high-priority).
    issueAreas: ['Injunctions for Protection'],
    jurisdictions: ['FL'],
    topics: [
      {
        id: 'cmu2y7cfa03jr9skoelgu8vdb',
        label: 'lwv4-qa-source: Injunctions for Protection',
        issueArea: null,
        priority: 'high',
      },
    ],
    billMatchSet: [
      {
        id: 'cmu2y7cfa03jr9skoelgu8vdb',
        label: 'lwv4-qa-source: Injunctions for Protection',
        issueArea: null,
        priority: 'high',
        keywords: ['Injunctions for Protection'],
        synonyms: [],
        entities: [],
        riskPhrases: [],
        routableTerms: [
          {
            id: null,
            topicId: 'cmu2y7cfa03jr9skoelgu8vdb',
            topicLabel: 'lwv4-qa-source: Injunctions for Protection',
            termType: 'keyword',
            value: 'Injunctions for Protection',
            topicPriority: 'high',
          },
        ],
      },
    ],
  };

  it('labels a failed state candidate by its real status, not the coarse lane', async () => {
    const { svc } = makeHarness({ stateBills: [S0032], watchlist });
    const items = await svc.getRecommendations(TENANT, CLIENT);
    const item = items.find((i) => i.billId === S0032.id);
    expect(item).toBeDefined();
    expect(item!.stageLabel).toBe('Failed');
    expect(item!.stage).not.toBe('enacted');
    expect(item!.jurisdiction).toBe('FL');
  });

  it('keeps a genuinely enacted state candidate labelled Enacted', async () => {
    const enactedBill = stateBill({
      id: 'fl-2026-s0500',
      status: 'enacted',
      identifier: 'S0500',
    });
    const { svc } = makeHarness({ stateBills: [enactedBill], watchlist });
    const items = await svc.getRecommendations(TENANT, CLIENT);
    const item = items.find((i) => i.billId === enactedBill.id);
    expect(item).toBeDefined();
    expect(item!.stage).toBe('enacted');
    expect(item!.stageLabel).toBe('Enacted');
  });
});
