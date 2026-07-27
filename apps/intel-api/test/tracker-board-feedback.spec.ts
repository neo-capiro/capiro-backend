import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';
import { scoreBillFit, type CompiledTopicForFit } from '../src/tracker/bill-fit.util.js';
import type { RoutableTerm } from '../src/watchlist/term-routing.js';

/**
 * §4.10 (Gate E phase f) — `recordFeedback` persisting the structured dismiss
 * reason + matched tags (f-2/f-3), and `feedbackSignal` aggregating them into
 * per-topic dismissal counts by reason (f-3). f-7 cases 2 and 3.
 *
 * An in-memory `intel_feedback` table backs `prisma`, so `findMany`'s where
 * clause (signal + matchedTags.isEmpty filters) is exercised for real rather
 * than asserted against a canned fixture.
 */

const TENANT = 'tenant-1';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const USER = 'user-1';

interface FeedbackRow {
  tenantId: string;
  clientId: string;
  userId: string | null;
  alertId: string | null;
  targetType: string;
  targetRef: string;
  signal: string;
  reason: string | null;
  matchedTags: string[];
  matchedTopicIds: string[];
}

function feedbackHarness(over: { assertAlertInClient?: jest.Mock } = {}) {
  const rows: FeedbackRow[] = [];
  const prisma = {
    withTenant: async (_tid: string, fn: (tx: unknown) => unknown) =>
      fn({
        intelFeedback: {
          create: async ({ data }: { data: FeedbackRow }) => {
            rows.push({ ...data });
            return { id: `fb-${rows.length}`, createdAt: new Date(), ...data };
          },
          findMany: async (args: {
            where: { tenantId: string; clientId: string; signal?: string; matchedTags?: { isEmpty?: boolean } };
            select?: Record<string, boolean>;
          }) => {
            let out = rows.filter(
              (r) => r.tenantId === args.where.tenantId && r.clientId === args.where.clientId,
            );
            if (args.where.signal) out = out.filter((r) => r.signal === args.where.signal);
            if (args.where.matchedTags?.isEmpty === false) out = out.filter((r) => r.matchedTags.length > 0);
            if (!args.select) return out;
            return out.map((r) => {
              const picked: Record<string, unknown> = {};
              for (const k of Object.keys(args.select!)) picked[k] = (r as Record<string, unknown>)[k];
              return picked;
            });
          },
        },
      }),
  } as never;
  const assertAlertInClient = over.assertAlertInClient ?? jest.fn().mockResolvedValue(undefined);
  const watchlists = { assertClientInTenant: async () => {}, assertAlertInClient } as never;
  const repo = {} as never;
  const stateRepo = {} as never;
  return { svc: new TrackerBoardService(prisma, repo, watchlists, stateRepo), rows, assertAlertInClient };
}

describe('TrackerBoardService.recordFeedback — §4.10 (f-7 case 2)', () => {
  it('persists the structured reason and matched tags', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      reason: 'too_broad',
      matchedTags: ['grid', 'permitting'],
    });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      reason: 'too_broad',
      matchedTags: ['grid', 'permitting'],
    });
  });

  it('defaults reason to null and matchedTags to [] when omitted ("Just hide it")', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
    });
    expect(h.rows[0]).toMatchObject({ reason: null, matchedTags: [] });
  });

  it('Gate K (MP-09): persists matchedTopicIds alongside matchedTags, and defaults it to [] when omitted', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      matchedTags: ['grid reliability'],
      matchedTopicIds: ['topic-grid'],
    });
    expect(h.rows[0]).toMatchObject({
      matchedTags: ['grid reliability'],
      matchedTopicIds: ['topic-grid'],
    });

    const h2 = feedbackHarness();
    await h2.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      matchedTags: ['grid reliability'],
      // matchedTopicIds omitted — an un-updated web bundle.
    });
    expect(h2.rows[0]).toMatchObject({ matchedTopicIds: [] });
  });
});

describe('TrackerBoardService.recordFeedback — Gate J (HP-06) a-7', () => {
  it('validates alertId against the client when present, before writing', async () => {
    const assertAlertInClient = jest.fn().mockResolvedValue(undefined);
    const h = feedbackHarness({ assertAlertInClient });
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'dismissed',
      alertId: 'alert-1',
    });
    expect(assertAlertInClient).toHaveBeenCalledWith(TENANT, CLIENT, 'alert-1');
    expect(h.rows).toHaveLength(1);
  });

  it('rejects a foreign alertId and writes nothing', async () => {
    const assertAlertInClient = jest.fn().mockRejectedValue(new Error('404'));
    const h = feedbackHarness({ assertAlertInClient });
    await expect(
      h.svc.recordFeedback(TENANT, CLIENT, USER, {
        targetRef: '119-hr-1',
        signal: 'dismissed',
        alertId: 'someone-elses-alert',
      }),
    ).rejects.toThrow();
    expect(h.rows).toHaveLength(0);
  });

  it('skips the alert check entirely when alertId is absent (a bare targetRef signal is legitimate)', async () => {
    const assertAlertInClient = jest.fn().mockResolvedValue(undefined);
    const h = feedbackHarness({ assertAlertInClient });
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
    });
    expect(assertAlertInClient).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(1);
  });
});

describe('TrackerBoardService.feedbackSignal — §4.10 (f-7 case 3)', () => {
  it('returns an empty map for a client with no feedback', async () => {
    const h = feedbackHarness();
    const out = await h.svc.feedbackSignal(TENANT, CLIENT);
    expect(out.size).toBe(0);
  });

  it('groups per-topic dismissal counts by reason, across multiple dismissals', async () => {
    const h = feedbackHarness();
    const dismissals: Array<[string, string]> = [
      ['119-hr-1', 'too_broad'],
      ['119-hr-2', 'too_broad'],
      ['119-hr-3', 'wrong_issue'],
    ];
    for (const [billId, reason] of dismissals) {
      await h.svc.recordFeedback(TENANT, CLIENT, USER, {
        targetRef: billId,
        signal: 'marked_irrelevant',
        reason,
        matchedTags: ['grid'],
      });
    }
    const out = await h.svc.feedbackSignal(TENANT, CLIENT);
    expect(out.get('grid')).toEqual({ total: 3, byReason: { too_broad: 2, wrong_issue: 1 } });
  });

  it('groups a single dismissal touching two topics into BOTH topics (a-6-style fan-out)', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      reason: 'wrong_entity',
      matchedTags: ['grid', 'permitting'],
    });
    const out = await h.svc.feedbackSignal(TENANT, CLIENT);
    expect(out.get('grid')).toEqual({ total: 1, byReason: { wrong_entity: 1 } });
    expect(out.get('permitting')).toEqual({ total: 1, byReason: { wrong_entity: 1 } });
  });

  it('a dismissal with no reason is bucketed under "unspecified", not dropped', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      matchedTags: ['grid'],
    });
    const out = await h.svc.feedbackSignal(TENANT, CLIENT);
    expect(out.get('grid')).toEqual({ total: 1, byReason: { unspecified: 1 } });
  });

  it('forward-only (§6 open decision 3): a dismissal with no matchedTags (pre-phase-f row) contributes nothing', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      reason: 'too_broad',
      // matchedTags omitted — defaults to [] at the persistence layer.
    });
    const out = await h.svc.feedbackSignal(TENANT, CLIENT);
    expect(out.size).toBe(0);
  });

  it('ignores a non-dismissal signal even if it carries matchedTags', async () => {
    const h = feedbackHarness();
    await h.svc.recordFeedback(TENANT, CLIENT, USER, {
      targetRef: '119-hr-1',
      signal: 'tracked',
      matchedTags: ['grid'],
    });
    const out = await h.svc.feedbackSignal(TENANT, CLIENT);
    expect(out.size).toBe(0);
  });

  describe('Gate K (MP-09, c-2/c-8): keyed by topic id, falling back to label', () => {
    it('a row WITH matchedTopicIds aggregates by id, not label', async () => {
      const h = feedbackHarness();
      await h.svc.recordFeedback(TENANT, CLIENT, USER, {
        targetRef: '119-hr-1',
        signal: 'marked_irrelevant',
        reason: 'too_broad',
        matchedTags: ['grid reliability'],
        matchedTopicIds: ['topic-grid'],
      });
      const out = await h.svc.feedbackSignal(TENANT, CLIENT);
      expect(out.get('topic-grid')).toEqual({ total: 1, byReason: { too_broad: 1 } });
      expect(out.has('grid reliability')).toBe(false);
    });

    it('a row with NO matchedTopicIds (pre-migration row) still falls back to label — forward-only does not mean silently dropped', async () => {
      const h = feedbackHarness();
      await h.svc.recordFeedback(TENANT, CLIENT, USER, {
        targetRef: '119-hr-1',
        signal: 'marked_irrelevant',
        reason: 'too_broad',
        matchedTags: ['grid reliability'],
        // matchedTopicIds omitted, as a row written before this column existed would be.
      });
      const out = await h.svc.feedbackSignal(TENANT, CLIENT);
      expect(out.get('grid reliability')).toEqual({ total: 1, byReason: { too_broad: 1 } });
    });

    /**
     * c-8: "rename a topic, then confirm prior dismissal signal still
     * applies" — the whole point of MP-09. End-to-end through
     * recordFeedback -> feedbackSignal -> scoreBillFit, mirroring what
     * getRecommendations actually does.
     */
    it('renaming a topic (label changes, id does not) preserves the accumulated dismissal signal through the full recordFeedback -> feedbackSignal -> scoreBillFit chain', async () => {
      const h = feedbackHarness();
      const labelTerm = (label: string): RoutableTerm => ({
        id: null,
        topicId: 'topic-grid',
        topicLabel: label,
        termType: 'keyword',
        value: label,
        topicPriority: 'med',
      });
      const bill = (title: string) => ({ title, policyArea: null, subjects: [], latestActionText: '' });

      // 6 too_broad dismissals under the ORIGINAL label — the floor band (0.5×).
      for (let i = 0; i < 6; i += 1) {
        await h.svc.recordFeedback(TENANT, CLIENT, USER, {
          targetRef: `119-hr-${i}`,
          signal: 'marked_irrelevant',
          reason: 'too_broad',
          matchedTags: ['grid reliability'],
          matchedTopicIds: ['topic-grid'],
        });
      }
      const feedback = await h.svc.feedbackSignal(TENANT, CLIENT);

      // The topic is RENAMED — same id, new label — exactly as putWatchlist's
      // rename-in-place (tracker-watchlist.service.ts) preserves it.
      const renamedTopic: CompiledTopicForFit[] = [
        {
          id: 'topic-grid',
          label: 'grid reliability reform',
          issueArea: null,
          priority: 'med',
          keywords: ['grid reliability reform'],
          synonyms: [],
          entities: [],
          riskPhrases: [],
          routableTerms: [labelTerm('grid reliability reform')],
        },
      ];
      const r = scoreBillFit(
        bill('A grid reliability reform bill'),
        renamedTopic,
        [],
        0,
        false,
        feedback,
      );

      expect(r.matchedTags).toContain('grid reliability reform');
      // 0.3 * weight(0.5 floor) — the down-weight followed the id across the rename.
      expect(r.fit).toBeCloseTo(0.3 * 0.5, 9);
    });
  });
});
