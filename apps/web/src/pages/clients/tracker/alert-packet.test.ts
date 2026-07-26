import { describe, expect, test } from 'vitest';
import {
  actionTextOf,
  buildOutreachContextPoolItem,
  renderPacketSummary,
  OUTREACH_CONTEXT_POOL_KEYS,
  OUTREACH_SUMMARY_MAX,
  OUTREACH_TITLE_MAX,
  type GovernmentAffairsAlertPacket,
} from './alert-packet.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * §4.1 / P1-13 (Gate C f-7 cases 5-6). The outreach wizard used to open with
 * `whyItMatters + one bill action`; it now opens with the server-built packet rendered to
 * text. Two properties matter most: the `Unknowns:` line must appear whenever the server
 * could not establish something (a wizard that hides its gaps invites the model to invent
 * something plausible), and a packet-fetch failure must degrade to EXACTLY the old
 * projection, never to something new.
 */

const packet = (over: Partial<GovernmentAffairsAlertPacket> = {}): GovernmentAffairsAlertPacket => ({
  event: {
    sourceType: 'bill',
    whatChanged: 'H.R. 8800: Reported by committee',
    canonicalStatus: 'Reported by committee',
    occurredAt: '2026-07-18',
    effectiveAt: null,
  },
  officialEvidence: [
    {
      claimId: 'c1',
      text: 'Bill: H.R. 8800 — Hypersonic Capability Acceleration Act',
      sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
      retrievedAt: '2026-07-26',
      verification: 'official',
    },
    {
      claimId: 'c2',
      text: 'Official action (2026-07-18): Ordered to be Reported by the Yeas and Nays: 32 - 12.',
      sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
      retrievedAt: '2026-07-26',
      verification: 'official',
    },
  ],
  proceduralMeaning: {
    currentStage: 'Reported by committee',
    nextPossibleSteps: [],
    uncertainty: [],
  },
  clientContext: {
    clientId: 'c1',
    position: 'support',
    priority: 'high',
    matchedTopics: ['Hypersonics'],
    capabilities: [],
    activeStrategies: [],
    redLines: [],
    facilities: [],
  },
  relationshipContext: {
    targetOffices: [],
    existingRelationships: [],
    recentMeetings: [],
    openCommitments: [],
  },
  actionContext: { recommendedTargets: [], recommendedActions: ['Draft client memo', 'Open bill'] },
  confidence: {
    relevance: 0.72,
    procedural: 0,
    evidenceCoverage: 0.86,
    missingFields: ['relationshipContext.targetOffices', 'clientContext.redLines'],
  },
  ...over,
});

const feedItem = (over: Partial<FeedItem> = {}): FeedItem =>
  ({
    id: 'alert-1',
    clientId: 'client-1',
    sourceType: 'bill',
    kind: 'committee_vote',
    severity: 'notable',
    materiality: 'medium',
    score: 0.7,
    clientImpact: null,
    urgency: null,
    title: 'H.R. 8800: Reported by committee',
    whyItMatters: 'Matches your watchlist term "hypersonics".',
    recommendedAction: null,
    status: 'new',
    createdAt: '2026-07-20T00:00:00Z',
    evidence: {},
    ...over,
  }) as FeedItem;

describe('renderPacketSummary', () => {
  test('renders the event, stage, client context, and every evidence line with its url', () => {
    const out = renderPacketSummary(packet());
    expect(out).toContain('What changed: H.R. 8800: Reported by committee');
    expect(out).toContain('Canonical status: Reported by committee');
    expect(out).toContain('Current stage: Reported by committee');
    expect(out).toContain('Occurred: 2026-07-18');
    expect(out).toContain('Client context: position support; priority high; matched topics Hypersonics');
    expect(out).toContain('- [c1] Bill: H.R. 8800 — Hypersonic Capability Acceleration Act');
    expect(out).toContain('https://www.congress.gov/bill/119th-congress/house-bill/8800');
    expect(out).toContain('(official)');
    expect(out).toContain('Recommended actions: Draft client memo; Open bill');
  });

  // Case 6
  test('includes an Unknowns line when missingFields is non-empty', () => {
    const out = renderPacketSummary(packet());
    expect(out).toContain('Unknowns: relationshipContext.targetOffices, clientContext.redLines');
  });

  test('omits the Unknowns line entirely when nothing is missing', () => {
    const out = renderPacketSummary(
      packet({
        confidence: { relevance: 1, procedural: 1, evidenceCoverage: 1, missingFields: [] },
        proceduralMeaning: { currentStage: 'Passed House', nextPossibleSteps: [], uncertainty: [] },
      }),
    );
    expect(out).not.toContain('Unknowns:');
  });

  test('folds procedural uncertainty into the Unknowns line', () => {
    const out = renderPacketSummary(
      packet({
        proceduralMeaning: {
          currentStage: 'not established',
          nextPossibleSteps: [],
          uncertainty: ['No official evidence resolved for this alert.'],
        },
      }),
    );
    expect(out).toContain('No official evidence resolved for this alert.');
    expect(out.indexOf('Unknowns:')).toBeGreaterThan(-1);
  });

  test('carries a regulation effective date and deadline when present', () => {
    const out = renderPacketSummary(
      packet({
        event: {
          sourceType: 'regulation',
          whatChanged: 'EPA proposes new emissions standards',
          canonicalStatus: 'Proposed Rule',
          occurredAt: '2026-07-15',
          effectiveAt: '2027-01-01',
        },
        proceduralMeaning: {
          currentStage: 'Proposed Rule',
          nextPossibleSteps: [],
          uncertainty: [],
          deadline: '2026-09-15',
        },
      }),
    );
    expect(out).toContain('Effective: 2027-01-01');
    expect(out).toContain('Deadline: 2026-09-15');
  });

  test('never throws on a malformed or partially-populated packet', () => {
    expect(() => renderPacketSummary({} as GovernmentAffairsAlertPacket)).not.toThrow();
    expect(renderPacketSummary({} as GovernmentAffairsAlertPacket)).toContain('(not established)');
  });
});

/**
 * Case 4: the posted body must be one the REAL outreach DTO accepts. The DTO lives in
 * apps/api and cannot be imported here, so this asserts its two enforceable properties
 * directly — the exact whitelisted key set and the two length bounds — against the
 * constants mirrored from engagement.controller.ts:620-652. A packet summary blows past
 * 2000 chars easily, and an unwhitelisted key 400s the whole POST under
 * forbidNonWhitelisted, so both are real failure modes, not theoretical ones.
 */
describe('buildOutreachContextPoolItem — the real DTO contract', () => {
  test('emits ONLY keys the DTO whitelists', () => {
    const built = buildOutreachContextPoolItem('alert-1', feedItem(), 'body');
    expect(Object.keys(built).sort()).toEqual([...OUTREACH_CONTEXT_POOL_KEYS].sort());
  });

  test('clamps an over-long title to the DTO bound instead of 400ing the POST', () => {
    const built = buildOutreachContextPoolItem(
      'alert-1',
      feedItem({ title: 'X'.repeat(600) }),
      'body',
    );
    expect(built.title.length).toBe(OUTREACH_TITLE_MAX);
    expect(built.title.length).toBeGreaterThan(0); // @Length(1,240) — must not be empty
  });

  test('clamps a full packet summary to the DTO bound', () => {
    const long = renderPacketSummary(
      packet({
        officialEvidence: Array.from({ length: 60 }, (_, i) => ({
          claimId: `c${i}`,
          text: `Evidence line number ${i} with a good deal of explanatory text attached to it.`,
          sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
          retrievedAt: '2026-07-26',
          verification: 'official' as const,
        })),
      }),
    );
    expect(long.length).toBeGreaterThan(OUTREACH_SUMMARY_MAX);
    const built = buildOutreachContextPoolItem('alert-1', feedItem(), long);
    expect(built.summary.length).toBe(OUTREACH_SUMMARY_MAX);
  });

  test('a short body is passed through untouched', () => {
    const built = buildOutreachContextPoolItem('alert-1', feedItem(), 'short body');
    expect(built.summary).toBe('short body');
    expect(built.sourceType).toBe('intel');
    expect(built.scope).toBe('all');
  });
});

describe('actionTextOf — the fallback must be byte-identical to the pre-P1-13 projection', () => {
  // Case 5's fallback contract.
  test('joins whyItMatters and the bill action with the same separator as before', () => {
    const item = feedItem({
      evidence: {
        bill: {
          billId: '119-hr-8800',
          displayNum: 'H.R. 8800',
          title: 'Act',
          url: null,
          stage: 'Reported',
          actionText: 'Ordered to be Reported.',
          actionDate: '2026-07-18',
        },
      },
    });
    expect(actionTextOf(item)).toBe(
      'Matches your watchlist term "hypersonics". · H.R. 8800 — Ordered to be Reported.',
    );
  });

  test('degrades to whyItMatters alone when there is no bill evidence', () => {
    expect(actionTextOf(feedItem())).toBe('Matches your watchlist term "hypersonics".');
  });

  test('yields an empty string when neither is present, never "null"', () => {
    expect(actionTextOf(feedItem({ whyItMatters: null }))).toBe('');
  });
});
