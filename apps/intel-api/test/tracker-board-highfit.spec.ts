import { highPriorityMatches, type CompiledTopicForFit } from '../src/tracker/bill-fit.util.js';
import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';

/**
 * Gate B phase f (P0-06) — the board tells the client which matched topics are
 * high-priority, instead of the web deriving it from a watchlist query that is not
 * enabled on the surface where the High-fit filter lives.
 *
 * Two levels: the pure `highPriorityMatches` reducer, and `getBoard` /
 * `getTenantBoard` actually populating the fields — including the constraint that
 * this adds NO watchlist read (f-6 case 9 / §4.14).
 */

const TENANT = 'tenant-1';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const BILL = '119-hr-1234';

const topic = (label: string, priority: string, position = 'monitor'): CompiledTopicForFit => ({
  label,
  issueArea: null,
  priority,
  position,
  keywords: [label],
  synonyms: [],
  entities: [],
  riskPhrases: [],
  routableTerms: [
    { id: null, topicId: null, topicLabel: label, termType: 'keyword', value: label, topicPriority: priority },
  ],
});

describe('highPriorityMatches (P0-06 reducer)', () => {
  it('returns only the high-priority matched labels', () => {
    const topics = [topic('grid', 'high'), topic('rates', 'med'), topic('siting', 'low')];
    const out = highPriorityMatches(['grid', 'rates', 'siting'], topics);
    expect(out.matchedHighPriorityTopics).toEqual(['grid']);
  });

  it('is empty when the only matched topic is med (f-6.7)', () => {
    const out = highPriorityMatches(['rates'], [topic('rates', 'med', 'oppose')]);
    expect(out.matchedHighPriorityTopics).toEqual([]);
    // …but the stance is still reported, so a card can be labelled either way.
    expect(out.matchedPosition).toBe('oppose');
  });

  it('reports the stance of the HIGHEST-priority matched topic, not the first', () => {
    const topics = [topic('rates', 'med', 'monitor'), topic('grid', 'high', 'support')];
    expect(highPriorityMatches(['rates', 'grid'], topics).matchedPosition).toBe('support');
    // Order of matchedTags must not change the answer.
    expect(highPriorityMatches(['grid', 'rates'], topics).matchedPosition).toBe('support');
  });

  it('ignores matchedTags entries that are ISSUE AREAS rather than topics', () => {
    // scoreBillFit pushes matched issue areas into matchedTags too; they carry no
    // priority, so they must neither resolve nor throw.
    const out = highPriorityMatches(['Energy', 'grid'], [topic('grid', 'high', 'support')]);
    expect(out.matchedHighPriorityTopics).toEqual(['grid']);
    expect(out.matchedPosition).toBe('support');
  });

  it('is empty and null with no matches at all', () => {
    expect(highPriorityMatches([], [topic('grid', 'high')])).toEqual({
      matchedHighPriorityTopics: [],
      matchedPosition: null,
    });
  });
});

/** A board harness: real TrackerBoardService, doubles for everything it reads. */
function boardHarness(topics: CompiledTopicForFit[]) {
  let compiledCalls = 0;
  const prisma = {
    withTenant: async (_tid: string, fn: (t: unknown) => unknown) =>
      fn({
        trackedBill: {
          findMany: async () => [
            {
              billId: BILL,
              clientId: CLIENT,
              stage: 'introduced',
              note: null,
              isManual: true,
              unread: false,
              trackedAt: new Date(0),
              lastSeenActionText: null,
              lastSeenActionDate: null,
              lastHearingSessionId: null,
              lastHearingAt: null,
            },
          ],
        },
        intelAlert: { findMany: async () => [], groupBy: async () => [] },
      }),
  } as never;
  const repo = {
    fetchRecommendationBills: async () => [
      {
        id: BILL,
        title: 'Grid modernization act',
        latestActionText: null,
        latestActionDate: null,
        policyArea: null,
        subjects: [],
      },
    ],
    getClientNames: async () => new Map([[CLIENT, 'Acme Corp']]),
  } as never;
  const watchlists = {
    // The board resolves the compiled watchlist through this ONE call; phase f must
    // not add a second (f-6 case 9).
    getCompiled: async () => {
      compiledCalls += 1;
      return {
        issueAreas: [],
        billMatchSet: topics.map((t) => ({
          label: t.label,
          issueArea: t.issueArea,
          position: t.position ?? 'monitor',
          priority: t.priority,
          keywords: t.keywords,
          synonyms: t.synonyms,
          entities: t.entities,
          riskPhrases: t.riskPhrases,
          routableTerms: t.routableTerms ?? [],
        })),
        hearingTerms: [],
        deepgramKeyterms: [],
        jurisdictions: [],
        termSurfaces: {},
      };
    },
  } as never;
  const stateRepo = { getStateBillsByIds: async () => [] } as never;
  return {
    svc: new TrackerBoardService(prisma, repo, watchlists, stateRepo),
    compiledCalls: () => compiledCalls,
  };
}

describe('TrackerBoardService.getBoard — matchedHighPriorityTopics (P0-06)', () => {
  it('f-6.6 a card whose matched topic is high-priority carries the label and the stance', async () => {
    const h = boardHarness([topic('Grid modernization', 'high', 'support')]);

    const { columns } = await h.svc.getBoard(TENANT, CLIENT);
    const card = columns.flatMap((c) => c.cards).find((c) => c.billId === BILL)!;

    expect(card.matchedTags).toContain('Grid modernization');
    expect(card.matchedHighPriorityTopics).toEqual(['Grid modernization']);
    expect(card.matchedPosition).toBe('support');
  });

  it('f-6.7 a med-priority-only match yields an EMPTY array, not an absent field', async () => {
    const h = boardHarness([topic('Grid modernization', 'med', 'monitor')]);

    const { columns } = await h.svc.getBoard(TENANT, CLIENT);
    const card = columns.flatMap((c) => c.cards).find((c) => c.billId === BILL)!;

    // The web distinguishes [] ("server says none") from undefined ("legacy board,
    // fall back to the watchlist query") — so the field must always be present.
    expect(card.matchedHighPriorityTopics).toEqual([]);
    expect(card.matchedPosition).toBe('monitor');
  });

  it('f-6.8 getTenantBoard (the _all roll-up) populates both fields too', async () => {
    const h = boardHarness([topic('Grid modernization', 'high', 'oppose')]);

    const { columns } = await h.svc.getTenantBoard(TENANT);
    const card = columns.flatMap((c) => c.cards).find((c) => c.billId === BILL)!;

    expect(card.matchedHighPriorityTopics).toEqual(['Grid modernization']);
    expect(card.matchedPosition).toBe('oppose');
    expect(card.clientId).toBe(CLIENT);
  });

  it('f-6.9 adds NO watchlist read: still exactly one getCompiled per client', async () => {
    const h = boardHarness([topic('Grid modernization', 'high')]);
    await h.svc.getBoard(TENANT, CLIENT);
    expect(h.compiledCalls()).toBe(1);

    const t = boardHarness([topic('Grid modernization', 'high')]);
    await t.svc.getTenantBoard(TENANT);
    expect(t.compiledCalls()).toBe(1); // one per DISTINCT client, unchanged (P1-18)
  });
});
