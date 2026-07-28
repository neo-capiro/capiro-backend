import { describe, expect, test } from 'vitest';
import { feedItemToMemoAlert, feedItemToDistrictBriefAlert } from './alert-actions-api.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * P0-07 (Gate C a-8 cases 15-16). Before Gate C, intel-api wrote bill evidence FLAT and
 * this mapper read it NESTED, so every one of sourceRef / billDisplayNum / billTitle /
 * actionText / actionDate / url arrived at the memo generator as null and the memo was
 * grounded in nothing but the headline. intel-api now normalizes on read, so
 * `evidence.bill` exists and the mapper populates without changing a line of its logic
 * — which is exactly what these tests lock.
 */

const feedItem = (over: Partial<FeedItem> = {}): FeedItem =>
  ({
    id: 'alert-1',
    clientId: 'client-1',
    sourceType: 'bill',
    kind: 'committee_vote',
    severity: 'notable',
    materiality: 'medium',
    score: 0.7,
    clientImpact: 'monitor',
    urgency: 'med',
    title: 'H.R. 8800: Reported by committee',
    whyItMatters: 'Matches your watchlist term "hypersonics".',
    recommendedAction: null,
    status: 'new',
    createdAt: '2026-07-20T00:00:00Z',
    evidence: {},
    ...over,
  }) as FeedItem;

/** What intel-api's normalizer now returns for a flat bill-change-detector row. */
const normalizedBillEvidence = {
  schemaVersion: 1,
  type: 'bill' as const,
  bill: {
    billId: '119-hr-8800',
    displayNum: 'H.R. 8800',
    title: 'Hypersonic Capability Acceleration Act',
    url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    stage: 'Reported by committee',
    actionText: 'Ordered to be Reported by the Yeas and Nays: 32 - 12.',
    actionDate: '2026-07-18',
    jurisdiction: 'US',
  },
  match: {
    matchedTags: ['Hypersonics'],
    termId: null,
    topicLabel: null,
    why: 'Matches your watchlist term "hypersonics".',
    details: [],
  },
  provenance: {
    sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    triggerKey: 'committee_vote',
    tone: 'positive',
    band: 'B',
    jurisdiction: 'US',
    writerShape: 'flat_bill',
  },
  extra: { tally: { yea: 32, nay: 12 } },
};

describe('feedItemToMemoAlert — normalized bill evidence (P0-07)', () => {
  // Case 15
  test('every bill field that used to be null is now populated', () => {
    const a = feedItemToMemoAlert(feedItem({ evidence: normalizedBillEvidence }));
    expect(a.sourceRef).toBe('119-hr-8800');
    expect(a.billDisplayNum).toBe('H.R. 8800');
    expect(a.billTitle).toBe('Hypersonic Capability Acceleration Act');
    expect(a.actionText).toBe('Ordered to be Reported by the Yeas and Nays: 32 - 12.');
    expect(a.actionDate).toBe('2026-07-18');
    expect(a.url).toBe('https://www.congress.gov/bill/119th-congress/house-bill/8800');
    expect(a.sourceType).toBe('bill');
    for (const v of [a.sourceRef, a.billDisplayNum, a.billTitle, a.actionText, a.actionDate, a.url]) {
      expect(v).not.toBeNull();
    }
  });

  test('an empty evidence object still maps without throwing (nulls, not errors)', () => {
    const a = feedItemToMemoAlert(feedItem({ evidence: {} }));
    expect(a.sourceRef).toBeNull();
    expect(a.billDisplayNum).toBeNull();
    expect(a.title).toBe('H.R. 8800: Reported by committee');
  });
});

describe('feedItemToMemoAlert — hearing evidence', () => {
  // Case 16
  test('sets committee from hearing.committeeId and populates quotes', () => {
    const a = feedItemToMemoAlert(
      feedItem({
        sourceType: 'hearing',
        evidence: {
          schemaVersion: 1,
          type: 'hearing',
          hearing: {
            sessionId: 'sess-1',
            title: 'FY27 posture hearing',
            committeeId: 'HSAS',
            occurredAt: '2026-07-01T14:00:00Z',
            mentions: [
              {
                segmentId: 'seg1',
                timestampMs: 754000,
                speakerName: 'Sen. Example',
                quote: 'We must accelerate hypersonic prototyping.',
                quoteSource: 'textPlain',
                issueTags: ['Hypersonics'],
              },
              {
                segmentId: 'seg2',
                timestampMs: null,
                speakerName: null,
                quote: null,
                quoteSource: 'encrypted',
                issueTags: [],
              },
            ],
          },
        } as FeedItem['evidence'],
      }),
    );
    expect(a.committee).toBe('HSAS');
    expect(a.hearingTitle).toBe('FY27 posture hearing');
    expect(a.quotes).toHaveLength(1); // the undecryptable mention is dropped, not blanked
    expect(a.quotes?.[0]?.text).toBe('We must accelerate hypersonic prototyping.');
    expect(a.quotes?.[0]?.speaker).toBe('Sen. Example');
    expect(a.quotes?.[0]?.atSec).toBe(754);
    expect(a.matchedTags).toEqual(['Hypersonics']);
  });

  test('committee is null when the hearing carries no committeeId', () => {
    const a = feedItemToMemoAlert(
      feedItem({
        sourceType: 'hearing',
        evidence: {
          hearing: { sessionId: 's', title: null, committeeId: null, occurredAt: null, mentions: [] },
        },
      }),
    );
    expect(a.committee).toBeNull();
  });
});

/** What intel-api's PE change detector writes, after normalization. */
const peItem = () =>
  feedItem({
    sourceType: 'program_element',
    title: "0603286F: FY27 President's Budget increases funding",
    evidence: {
      schemaVersion: 1,
      type: 'program_element',
      programElement: {
        peCode: '0603286F',
        title: 'Hypersonics Prototyping',
        fiscalYear: 2027,
        deltaType: 'pb_increase',
        deltaTypeLabel: "President's Budget increase",
        fromRef: 'FY26 PB',
        toRef: 'FY27 PB',
        amountFromMillions: 250,
        amountToMillions: 1234.5,
        deltaMillions: 984.5,
        deltaPct: 393.8,
        materialityScore: 0.82,
        href: '/program-elements/0603286F',
      },
    } as FeedItem['evidence'],
  });

describe('feedItemToMemoAlert — Program Element (P0-08)', () => {
  // Case 14
  test('keeps sourceType program_element and round-trips every PE field', () => {
    const a = feedItemToMemoAlert(peItem());
    expect(a.sourceType).toBe('program_element');
    expect(a.programElement).toEqual({
      peCode: '0603286F',
      title: 'Hypersonics Prototyping',
      fiscalYear: 2027,
      deltaType: 'pb_increase',
      deltaTypeLabel: "President's Budget increase",
      fromRef: 'FY26 PB',
      toRef: 'FY27 PB',
      amountFromMillions: 250,
      amountToMillions: 1234.5,
      deltaMillions: 984.5,
      deltaPct: 393.8,
      href: '/program-elements/0603286F',
    });
  });

});

/**
 * §4.5 (phase d, full-feature option). Every source type is now a first-class memo
 * source, so the mapper no longer downgrades state_bill or regulation to 'bill' — doing
 * so dropped every state deadline and every regulatory date.
 */
const stateBillItem = () =>
  feedItem({
    sourceType: 'state_bill',
    title: 'CA AB 1234: 5 day(s) until its committeeCutoff (2026-08-01).',
    evidence: {
      schemaVersion: 1,
      type: 'state_bill',
      bill: {
        billId: 'ca-ab-1234',
        displayNum: 'CA AB 1234',
        title: 'Advanced Manufacturing Incentive Act',
        url: 'https://leginfo.legislature.ca.gov/ab1234',
        stage: 'Referred to committee',
        actionText: 'Referred to Assembly Appropriations.',
        actionDate: '2026-07-20',
        jurisdiction: 'CA',
      },
      provenance: {
        sourceUrl: 'https://leginfo.legislature.ca.gov/ab1234',
        triggerKey: 'stateDeadline',
        tone: 'warn',
        band: 'B',
        jurisdiction: 'CA',
        session: '2026 Regular Session',
        writerShape: 'flat_bill',
      },
      extra: { cutoffType: 'committeeCutoff', cutoffDate: '2026-08-01', daysUntil: 5 },
    } as FeedItem['evidence'],
  });

const regulationItem = () =>
  feedItem({
    sourceType: 'regulation',
    title: 'EPA proposes new emissions standards',
    evidence: {
      schemaVersion: 1,
      type: 'regulation',
      regulation: {
        ruleTitle: 'Standards of Performance for Stationary Combustion Turbines',
        agency: 'Environmental Protection Agency',
        ruleType: 'Proposed Rule',
        commentEndDate: '2026-09-15',
        stage: 'New rule',
        actionText: 'EPA proposes to revise the NSPS.',
        actionDate: '2026-07-15',
        url: 'https://www.federalregister.gov/d/2026-01234',
      },
      provenance: {
        sourceUrl: 'https://www.federalregister.gov/d/2026-01234',
        triggerKey: 'newMatch',
        tone: 'info',
        band: 'low',
        jurisdiction: 'US',
        writerShape: 'flat_bill',
      },
      extra: {},
    } as FeedItem['evidence'],
  });

describe('feedItemToMemoAlert — state_bill and regulation (§4.5)', () => {
  test('a state bill keeps its sourceType and carries jurisdiction + the cutoff deadline', () => {
    const a = feedItemToMemoAlert(stateBillItem());
    expect(a.sourceType).toBe('state_bill');
    expect(a.jurisdiction).toBe('CA');
    expect(a.deadline).toEqual({
      cutoffType: 'committeeCutoff',
      cutoffDate: '2026-08-01',
      daysUntil: 5,
    });
    // The bill fields still populate — a state bill IS bill-shaped.
    expect(a.billDisplayNum).toBe('CA AB 1234');
    expect(a.actionText).toBe('Referred to Assembly Appropriations.');
  });

  test('Gate L (HP-03) followup: a state bill carries its legislative session through to the memo/brief generator', () => {
    const a = feedItemToMemoAlert(stateBillItem());
    expect(a.session).toBe('2026 Regular Session');
  });

  test('Gate L (HP-03) followup: omits session entirely rather than sending null when the alert never carried one', () => {
    const item = stateBillItem();
    delete (item.evidence as { provenance?: { session?: string } }).provenance?.session;
    const a = feedItemToMemoAlert(item);
    expect('session' in a).toBe(false);
  });

  test('a state bill with no cutoff sends no deadline block at all', () => {
    const item = stateBillItem();
    (item.evidence as { extra?: unknown }).extra = {};
    expect(feedItemToMemoAlert(item).deadline).toBeUndefined();
  });

  test('a regulation keeps its sourceType and carries the rule facts', () => {
    const a = feedItemToMemoAlert(regulationItem());
    expect(a.sourceType).toBe('regulation');
    expect(a.regulation).toMatchObject({
      ruleTitle: 'Standards of Performance for Stationary Combustion Turbines',
      agency: 'Environmental Protection Agency',
      ruleType: 'Proposed Rule',
      commentEndDate: '2026-09-15',
    });
    expect(a.url).toBe('https://www.federalregister.gov/d/2026-01234');
  });
});

describe('feedItemToDistrictBriefAlert', () => {
  test('still maps a bill alert identically to the memo mapper', () => {
    const item = feedItem({ evidence: normalizedBillEvidence });
    expect(feedItemToDistrictBriefAlert(item)).toEqual(feedItemToMemoAlert(item));
  });

  // Case 15 — the alias break. The district-brief DTO was NOT widened for PE, so
  // sending it sourceType:'program_element' would 400.
  test('downgrades a PE alert to bill and strips the PE block', () => {
    const item = peItem();
    expect(feedItemToMemoAlert(item).sourceType).toBe('program_element');
    const brief = feedItemToDistrictBriefAlert(item);
    expect(brief.sourceType).toBe('bill');
    expect(brief.programElement).toBeUndefined();
  });

  test('is no longer a bare alias of the memo mapper', () => {
    expect(feedItemToDistrictBriefAlert).not.toBe(feedItemToMemoAlert);
  });

  /**
   * HP-03 (Gate L phase a): the district-brief DTO's @IsIn (district-brief.controller.ts:30)
   * now accepts state_bill, so a state bill's jurisdiction + deadline facts reach
   * buildClaims instead of being stripped here. This is not hypothetical:
   * recommendedActionsFor DOES offer district_brief for a state bill, so a widened
   * mapper that still downgraded would silently degrade a reachable, user-facing brief
   * to a federal-shaped one.
   */
  test('keeps a STATE BILL as state_bill and preserves its deadline + jurisdiction (reachable path)', () => {
    const item = stateBillItem();
    expect(feedItemToMemoAlert(item).sourceType).toBe('state_bill');
    const brief = feedItemToDistrictBriefAlert(item);
    expect(brief.sourceType).toBe('state_bill');
    expect(brief.deadline).toEqual({
      cutoffType: 'committeeCutoff',
      cutoffDate: '2026-08-01',
      daysUntil: 5,
    });
    expect(brief.jurisdiction).toBe('CA');
    // Gate L (HP-03) followup: the session claim reaches the SAME reachable
    // path — a district brief is where this claim actually matters.
    expect(brief.session).toBe('2026 Regular Session');
    // The bill facts the brief actually grounds on are preserved.
    expect(brief.billDisplayNum).toBe('CA AB 1234');
  });

  test('downgrades a regulation and strips the rule block', () => {
    const brief = feedItemToDistrictBriefAlert(regulationItem());
    expect(brief.sourceType).toBe('bill');
    expect(brief.regulation).toBeUndefined();
  });

  test('only ever sends a sourceType the district-brief DTO accepts', () => {
    const accepted = new Set(['bill', 'hearing', 'combined', 'state_bill']);
    for (const item of [
      stateBillItem(),
      regulationItem(),
      peItem(),
      feedItem({ sourceType: 'bill' }),
      feedItem({ sourceType: 'hearing' }),
      feedItem({ sourceType: 'combined' }),
    ]) {
      expect(accepted.has(feedItemToDistrictBriefAlert(item).sourceType)).toBe(true);
    }
  });
});
