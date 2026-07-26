import { NotFoundException } from '@nestjs/common';
import { AlertPacketService } from '../src/feed/alert-packet.service.js';
import { PACKET_UNAVAILABLE_IN_INTEL_API, MAX_OFFICIAL_EVIDENCE } from '../src/feed/alert-packet.js';

/**
 * §4.1 / P1-13 (Gate C f-7). `draftOutreach` used to hand the wizard
 * `[whyItMatters, oneBillAction].join(' · ')` — dropping every hearing quote and speaker,
 * every PE funding delta, every regulation field, the official source URL, the client's
 * position and priority, and the target offices. This is the server-built replacement.
 *
 * The contract these tests defend hardest: everything intel-api CANNOT reach is named in
 * confidence.missingFields rather than quietly omitted.
 */

const FLAT_BILL_ALERT = {
  id: 'alert-1',
  clientId: 'c1',
  sourceType: 'bill',
  sourceRef: '119-hr-8800',
  severity: 'notable',
  score: 0.72,
  title: 'H.R. 8800: Reported by committee',
  whyItMatters: 'Matches your watchlist term "hypersonics".',
  termId: null,
  createdAt: new Date('2026-07-20T00:00:00Z'),
  evidence: {
    stage: 'Reported by committee',
    actionText: 'Ordered to be Reported by the Yeas and Nays: 32 - 12.',
    actionDate: '2026-07-18',
    url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    why: 'Matches your watchlist term "hypersonics".',
    matchedTags: ['Hypersonics'],
    tone: 'positive',
    band: 'B',
    triggerKey: 'committee_vote',
    billTitle: 'Hypersonic Capability Acceleration Act',
    displayNum: 'H.R. 8800',
    jurisdiction: 'US',
  },
};

function makeService(opts: {
  alert?: Record<string, unknown> | null;
  topics?: Array<{ label: string; issueArea: string | null; position: string; priority: string }>;
  clientInTenant?: boolean;
}) {
  const tx = {
    intelAlert: { findFirst: async () => (opts.alert === undefined ? FLAT_BILL_ALERT : opts.alert) },
    watchlistTopic: { findMany: async () => opts.topics ?? [] },
  };
  const prisma = { withTenant: async (_t: string, cb: (t: unknown) => unknown) => cb(tx) } as never;
  const watchlist = {
    assertClientInTenant: async () => {
      if (opts.clientInTenant === false) throw new NotFoundException('Client not found');
    },
  } as never;
  return new AlertPacketService(prisma, watchlist);
}

describe('AlertPacketService.build — §4.1 contract', () => {
  // Case 1
  it('returns every top-level §4.1 key with real evidence and named missing fields', async () => {
    const packet = await makeService({
      topics: [{ label: 'Hypersonics', issueArea: 'Defense', position: 'support', priority: 'high' }],
    }).build('t1', 'c1', 'alert-1');

    for (const key of [
      'event',
      'officialEvidence',
      'proceduralMeaning',
      'clientContext',
      'relationshipContext',
      'actionContext',
      'confidence',
    ]) {
      expect(packet).toHaveProperty(key);
    }

    expect(packet.event).toEqual({
      sourceType: 'bill',
      whatChanged: 'H.R. 8800: Reported by committee',
      canonicalStatus: 'Reported by committee',
      occurredAt: '2026-07-18',
      effectiveAt: null,
    });
    expect(packet.officialEvidence.length).toBeGreaterThan(0);
    expect(packet.officialEvidence[0]!.claimId).toBe('c1');
    expect(packet.officialEvidence.map((e) => e.text).join(' ')).toContain('H.R. 8800');
    expect(packet.officialEvidence.map((e) => e.text).join(' ')).toContain(
      'Ordered to be Reported',
    );
    // Everything structurally unreachable from intel-api is NAMED.
    for (const f of PACKET_UNAVAILABLE_IN_INTEL_API) {
      expect(packet.confidence.missingFields).toContain(f);
    }
    expect(packet.confidence.missingFields).toContain('relationshipContext.targetOffices');
    expect(packet.confidence.missingFields).toContain('proceduralMeaning.nextPossibleSteps');
    expect(packet.confidence.missingFields).toContain('confidence.whoActs');
  });

  it('resolves the client position/priority from the matched watchlist topic', async () => {
    const packet = await makeService({
      topics: [
        { label: 'Hypersonics', issueArea: 'Defense', position: 'support', priority: 'high' },
        { label: 'Unrelated', issueArea: null, position: 'oppose', priority: 'low' },
      ],
    }).build('t1', 'c1', 'alert-1');

    expect(packet.clientContext.matchedTopics).toEqual(['Hypersonics']);
    expect(packet.clientContext.position).toBe('support');
    expect(packet.clientContext.priority).toBe('high');
  });

  it('omits position/priority and names them when NO topic matched (never defaults to monitor)', async () => {
    const packet = await makeService({ topics: [] }).build('t1', 'c1', 'alert-1');

    expect(packet.clientContext.position).toBeUndefined();
    expect(packet.clientContext.priority).toBeUndefined();
    expect(packet.confidence.missingFields).toContain('clientContext.position');
    expect(packet.confidence.missingFields).toContain('clientContext.priority');
    expect(packet.confidence.missingFields).toContain('clientContext.matchedTopics');
  });

  it('marks an official http source "official" and reports evidence coverage as a fraction', async () => {
    const packet = await makeService({}).build('t1', 'c1', 'alert-1');
    const withUrl = packet.officialEvidence.filter((e) => e.sourceUrl);
    expect(withUrl.length).toBeGreaterThan(0);
    for (const e of withUrl) expect(e.verification).toBe('official');
    expect(packet.confidence.evidenceCoverage).toBeGreaterThan(0);
    expect(packet.confidence.evidenceCoverage).toBeLessThanOrEqual(1);
    expect(packet.confidence.relevance).toBe(0.72);
    expect(packet.confidence.procedural).toBe(0); // no state machine yet — honest, not a guess
  });

  it('includes the recommended actions the feed would offer', async () => {
    const packet = await makeService({}).build('t1', 'c1', 'alert-1');
    expect(packet.actionContext.recommendedActions).toContain('Draft client memo');
    expect(packet.actionContext.recommendedActions).toContain('Open bill');
  });
});

// Case 2 + §4 edge case 13
describe('AlertPacketService.build — ownership', () => {
  it('404s when the client is not in the caller tenant', async () => {
    await expect(
      makeService({ clientInTenant: false }).build('t-other', 'c1', 'alert-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the alert does not belong to that (tenant, client) pair', async () => {
    // The findFirst predicate carries tenantId + clientId, so a mismatch returns null.
    await expect(makeService({ alert: null }).build('t1', 'c-other', 'alert-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// Case 3
describe('AlertPacketService.build — per-source evidence', () => {
  it('carries hearing quotes and the speaker, and skips an undecryptable quote', async () => {
    const packet = await makeService({
      alert: {
        ...FLAT_BILL_ALERT,
        sourceType: 'hearing',
        sourceRef: 'sess-1',
        evidence: {
          hearing: {
            sessionId: 'sess-1',
            title: 'FY27 posture hearing',
            committeeId: 'HSAS',
            occurredAt: '2026-07-01',
            mentions: [
              { speakerName: 'Sen. Example', quote: 'We must accelerate hypersonic prototyping.' },
              { speakerName: 'Rep. Other', quote: null }, // fail-closed decrypt
            ],
          },
        },
      },
    }).build('t1', 'c1', 'alert-1');

    const text = packet.officialEvidence.map((e) => e.text).join(' | ');
    expect(text).toContain('Hearing: FY27 posture hearing');
    expect(text).toContain('Committee: HSAS');
    expect(text).toContain('Hearing statement — Sen. Example: "We must accelerate hypersonic prototyping."');
    // The undecryptable mention is absent, never a placeholder (fail-closed).
    expect(text).not.toContain('Rep. Other');
    expect(packet.event.occurredAt).toBe('2026-07-01');
  });

  it('carries the PE funding figures', async () => {
    const packet = await makeService({
      alert: {
        ...FLAT_BILL_ALERT,
        sourceType: 'program_element',
        sourceRef: '0603286F',
        evidence: {
          programElement: {
            peCode: '0603286F',
            title: 'Hypersonics Prototyping',
            fiscalYear: 2027,
            deltaTypeLabel: "President's Budget increase",
            fromRef: 'FY26 PB',
            toRef: 'FY27 PB',
            amountFromMillions: 250,
            amountToMillions: 1234.5,
            deltaMillions: 984.5,
            href: '/program-elements/0603286F',
          },
        },
      },
    }).build('t1', 'c1', 'alert-1');

    const text = packet.officialEvidence.map((e) => e.text).join(' | ');
    expect(text).toContain('Program Element: 0603286F — Hypersonics Prototyping');
    expect(text).toContain('Fiscal year: FY2027');
    expect(text).toContain("Budget-stage movement: President's Budget increase");
    expect(text).toContain('Source comparison: from FY26 PB to FY27 PB');
    expect(text).toContain('250');
    expect(text).toContain('1234.5');
    // A relative internal deep link is extracted data, never "official".
    for (const e of packet.officialEvidence.filter((x) => x.sourceUrl === '/program-elements/0603286F'))
      expect(e.verification).toBe('extracted');
  });

  it('carries the regulation dates and surfaces the effective date on the event', async () => {
    const packet = await makeService({
      alert: {
        ...FLAT_BILL_ALERT,
        sourceType: 'regulation',
        sourceRef: '2026-01234',
        evidence: {
          stage: 'New rule',
          actionText: 'EPA proposes to revise the NSPS.',
          actionDate: '2026-07-15',
          sourceUrl: 'https://www.federalregister.gov/d/2026-01234',
          ruleTitle: 'Standards of Performance for Stationary Combustion Turbines',
          agency: 'Environmental Protection Agency',
          ruleType: 'Proposed Rule',
          commentEndDate: '2026-09-15',
          jurisdiction: 'US',
        },
      },
    }).build('t1', 'c1', 'alert-1');

    const text = packet.officialEvidence.map((e) => e.text).join(' | ');
    expect(text).toContain('Issuing agency: Environmental Protection Agency');
    expect(text).toContain('Document type: Proposed Rule');
    expect(text).toContain('Public comment period closes: 2026-09-15');
    expect(packet.event.canonicalStatus).toBe('Proposed Rule');
    expect(packet.proceduralMeaning.deadline).toBe('2026-09-15');
    expect(packet.actionContext.actionWindow).toBe('Before 2026-09-15');
  });

  it('carries a state cutoff deadline from the normalized extra', async () => {
    const packet = await makeService({
      alert: {
        ...FLAT_BILL_ALERT,
        sourceType: 'state_bill',
        sourceRef: 'ca-ab-1234',
        evidence: {
          ...FLAT_BILL_ALERT.evidence,
          jurisdiction: 'CA',
          cutoffType: 'committeeCutoff',
          cutoffDate: '2026-08-01',
          daysUntil: 5,
        },
      },
    }).build('t1', 'c1', 'alert-1');

    const text = packet.officialEvidence.map((e) => e.text).join(' | ');
    expect(text).toContain('Procedural deadline: type committeeCutoff, date 2026-08-01, 5 day(s) remaining');
    expect(packet.proceduralMeaning.deadline).toBe('2026-08-01');
  });

  it('reports uncertainty and no evidence for an empty-evidence alert, without throwing', async () => {
    const packet = await makeService({
      alert: { ...FLAT_BILL_ALERT, whyItMatters: null, evidence: null },
    }).build('t1', 'c1', 'alert-1');

    expect(packet.officialEvidence).toEqual([]);
    expect(packet.proceduralMeaning.uncertainty.length).toBeGreaterThan(0);
    expect(packet.proceduralMeaning.currentStage).toBe('not established');
    expect(packet.confidence.missingFields).toContain('proceduralMeaning.currentStage');
  });

  // §4 edge case 14
  it('caps officialEvidence and NAMES the truncation rather than silently dropping', async () => {
    const mentions = Array.from({ length: 40 }, (_, i) => ({
      speakerName: `Speaker ${i}`,
      quote: `Statement number ${i}.`,
    }));
    const packet = await makeService({
      alert: {
        ...FLAT_BILL_ALERT,
        sourceType: 'hearing',
        evidence: { hearing: { sessionId: 's', title: 'Long hearing', committeeId: 'C', mentions } },
      },
    }).build('t1', 'c1', 'alert-1');

    expect(packet.officialEvidence).toHaveLength(MAX_OFFICIAL_EVIDENCE);
    expect(packet.confidence.missingFields.some((f) => f.startsWith('officialEvidence.truncated:'))).toBe(
      true,
    );
  });
});
