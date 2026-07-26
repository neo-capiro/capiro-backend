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

describe('feedItemToDistrictBriefAlert', () => {
  test('still maps a bill alert identically to the memo mapper', () => {
    const item = feedItem({ evidence: normalizedBillEvidence });
    expect(feedItemToDistrictBriefAlert(item)).toEqual(feedItemToMemoAlert(item));
  });
});
