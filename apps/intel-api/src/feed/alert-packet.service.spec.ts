import { AlertPacketService } from './alert-packet.service.js';

/**
 * feed-mapping-21: a `bill_new_match` alert is a Capiro application DETECTION,
 * not a legislative event. NewMatchDetectorService records the detection label
 * "New matched bill" in evidence.stage and the fit line in evidence.actionText,
 * and reuses the bill's STALE latest-action date as actionDate. The packet must
 * not present that computed match as an OFFICIAL stage/action, nor date it to the
 * old legislative date. Real legislative events (bill_failed, enacted, …) keep
 * their official stage/date/action untouched.
 *
 * The evidence shapes below mirror the real writer output (the native fixture
 * alerts H0547 / S0032).
 */

const CLIENT = 'c50bc7d6-e88a-4df4-9047-6fa6d554b16d';
const TENANT = 'tenant-1';
const DETECTED = '2026-09-15T17:31:02.397Z';

const newMatchEvidence = {
  fit: 0.45,
  why: 'Matches your watchlist term "injunctions".',
  whyKind: 'keyword',
  stage: 'New matched bill', // detection label, NOT a legislative stage
  actionText: 'Now matches your watchlist (fit 0.45) — Injunctions for Protection',
  actionDate: '2026-03-13', // the stale canonical latest-action date
  url: 'https://www.flsenate.gov/Session/Bill/2026/547',
  sourceUrl: 'https://www.flsenate.gov/Session/Bill/2026/547',
  matchedTags: ['injunctions'],
  tone: 'info',
  band: null,
  triggerKey: 'newMatch',
  billTitle: 'Injunctions for Protection',
  displayNum: 'FL H 0547',
  jurisdiction: 'FL',
};

function makePrisma(alert: Record<string, unknown>) {
  return {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        intelAlert: { findFirst: async () => alert },
        watchlistTopic: { findMany: async () => [] },
      }),
  };
}

function makeService(alert: Record<string, unknown>) {
  const watchlist = { assertClientInTenant: async () => undefined };
  return new AlertPacketService(makePrisma(alert) as never, watchlist as never);
}

function baseAlert(changeType: string, evidence: Record<string, unknown>) {
  return {
    id: 'alert-1',
    clientId: CLIENT,
    sourceType: 'state_bill',
    sourceRef: 'fl-2026-h0547',
    severity: 'info',
    score: 0.4,
    title: 'FL H 0547: New matched bill',
    whyItMatters: 'Matches your watchlist term "injunctions".',
    evidence,
    termId: null,
    createdAt: new Date(DETECTED),
    changeType,
  };
}

describe('AlertPacketService — new-match detection provenance', () => {
  it('does not label a bill_new_match detection as an official stage/action', async () => {
    const svc = makeService(baseAlert('bill_new_match', newMatchEvidence));
    const packet = await svc.build(TENANT, CLIENT, 'alert-1');

    const texts = packet.officialEvidence.map((e) => e.text);
    // No fabricated official stage / action from the detection label + fit text.
    expect(texts.some((t) => t.startsWith('Stage:'))).toBe(false);
    expect(texts.some((t) => t.startsWith('Official action'))).toBe(false);
    expect(texts.some((t) => t.includes('New matched bill'))).toBe(false);

    // The match is preserved, honestly labelled as a Capiro detection with fit + detection date.
    const matchLine = texts.find((t) => t.startsWith('Watchlist match'));
    expect(matchLine).toBeDefined();
    expect(matchLine).toContain('fit 0.45');
    expect(matchLine).toContain('detected 2026-09-15');

    // The computed match must NOT carry the official bill URL as its source —
    // that page does not verify Capiro's detection, so it must not be labelled
    // 'official'. The Bill identity entry keeps the genuine source URL.
    const matchEntry = packet.officialEvidence.find((e) => e.text.startsWith('Watchlist match'));
    expect(matchEntry?.sourceUrl).toBeUndefined();
    expect(matchEntry?.verification).toBe('unverified');
    const billEntry = packet.officialEvidence.find((e) => e.text.startsWith('Bill:'));
    expect(billEntry?.sourceUrl).toBe('https://www.flsenate.gov/Session/Bill/2026/547');
    expect(billEntry?.verification).toBe('official');

    // Relevance to client (the watch why) is preserved.
    expect(texts.some((t) => t.startsWith('Relevance to client:'))).toBe(true);
  });

  it('reports detection time, not the stale legislative date, and no official status', async () => {
    const svc = makeService(baseAlert('bill_new_match', newMatchEvidence));
    const packet = await svc.build(TENANT, CLIENT, 'alert-1');

    expect(packet.event.canonicalStatus).toBeNull();
    expect(packet.event.occurredAt).toBe('2026-09-15'); // detection time, not 2026-03-13
    expect(packet.event.whatChanged).toBe('FL H 0547: New matched bill'); // detection title preserved
    expect(packet.proceduralMeaning.currentStage).toBe('not established');
    expect(packet.confidence.missingFields).toContain('proceduralMeaning.currentStage');
  });

  it('applies the same distinction for a federal new-match alert', async () => {
    const svc = makeService({
      ...baseAlert('bill_new_match', {
        ...newMatchEvidence,
        displayNum: 'H.R. 1234',
        url: 'https://www.congress.gov/bill/119th-congress/house-bill/1234',
        sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/1234',
        jurisdiction: 'US',
      }),
      sourceType: 'bill',
      sourceRef: '119-hr-1234',
      title: 'H.R. 1234: New matched bill',
    });
    const packet = await svc.build(TENANT, CLIENT, 'alert-1');

    const texts = packet.officialEvidence.map((e) => e.text);
    expect(texts.some((t) => t.startsWith('Official action'))).toBe(false);
    expect(packet.event.canonicalStatus).toBeNull();
    expect(packet.event.occurredAt).toBe('2026-09-15');

    // Federal official URL: identity entry is official; computed match is not.
    const billEntry = packet.officialEvidence.find((e) => e.text.startsWith('Bill:'));
    expect(billEntry?.sourceUrl).toBe('https://www.congress.gov/bill/119th-congress/house-bill/1234');
    expect(billEntry?.verification).toBe('official');
    const matchEntry = packet.officialEvidence.find((e) => e.text.startsWith('Watchlist match'));
    expect(matchEntry?.sourceUrl).toBeUndefined();
    expect(matchEntry?.verification).toBe('unverified');
  });

  it('keeps official stage/date/action for a real legislative event (bill_failed)', async () => {
    const legislative = {
      ...newMatchEvidence,
      stage: 'Failed',
      actionText: 'Died in Civil Justice & Claims Subcommittee',
      actionDate: '2026-03-13',
    };
    const svc = makeService({
      ...baseAlert('state_bill_failed', legislative),
      title: 'FL H 0547: Failed / rejected',
    });
    const packet = await svc.build(TENANT, CLIENT, 'alert-1');

    const texts = packet.officialEvidence.map((e) => e.text);
    expect(texts.some((t) => t.startsWith('Stage: Failed'))).toBe(true);
    expect(
      texts.some((t) => t.startsWith('Official action (2026-03-13): Died in Civil Justice')),
    ).toBe(true);
    expect(texts.some((t) => t.startsWith('Watchlist match'))).toBe(false);

    expect(packet.event.canonicalStatus).toBe('Failed');
    expect(packet.event.occurredAt).toBe('2026-03-13'); // the real legislative date
    expect(packet.proceduralMeaning.currentStage).toBe('Failed');

    // A genuine legislative event keeps its official source URL and badge.
    const stageEntry = packet.officialEvidence.find((e) => e.text.startsWith('Stage:'));
    expect(stageEntry?.sourceUrl).toBe('https://www.flsenate.gov/Session/Bill/2026/547');
    expect(stageEntry?.verification).toBe('official');
    const actionEntry = packet.officialEvidence.find((e) => e.text.startsWith('Official action'));
    expect(actionEntry?.sourceUrl).toBe('https://www.flsenate.gov/Session/Bill/2026/547');
    expect(actionEntry?.verification).toBe('official');
  });

  it('stays honest when the new-match alert has no source URL', async () => {
    const noUrl = { ...newMatchEvidence, url: null, sourceUrl: null };
    const svc = makeService(baseAlert('bill_new_match', noUrl));
    const packet = await svc.build(TENANT, CLIENT, 'alert-1');

    // No fabricated official source; the detection line is still recorded but unverified.
    const matchEntry = packet.officialEvidence.find((e) => e.text.startsWith('Watchlist match'));
    expect(matchEntry).toBeDefined();
    expect(matchEntry?.verification).toBe('unverified');
    expect(packet.event.canonicalStatus).toBeNull();
    expect(packet.event.occurredAt).toBe('2026-09-15');
  });
});
